import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {execFileExec} from '../src/exec.ts';
import {
	analysisArgs,
	parseDetections,
	parseLuma,
	parseProbe,
	reviewMedia,
	runChecks,
	worstStatus,
} from '../src/review.ts';
import type {Measurements} from '../src/review.ts';
import type {CheckStatus, ReviewCheck} from '../src/types.ts';

const dir = await mkdtemp(join(tmpdir(), 'atelier-review-'));
after(() => rm(dir, {recursive: true, force: true}));

async function ffmpeg(args: readonly string[]): Promise<string> {
	const result = await execFileExec({
		command: 'ffmpeg',
		args: ['-hide_banner', '-loglevel', 'error', '-y', ...args],
	});
	assert.equal(result.code, 0, result.stderr);
	return result.stderr;
}

const file = (name: string): string => join(dir, name);

const statuses = (checks: readonly ReviewCheck[]): Readonly<Record<string, CheckStatus>> =>
	Object.fromEntries(checks.map(c => [c.id, c.status]));

await ffmpeg([
	...['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1:r=25'],
	...['-f', 'lavfi', '-i', 'testsrc=s=320x240:d=3:r=25'],
	...['-f', 'lavfi', '-i', 'sine=f=440:d=4'],
	...['-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]'],
	...['-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
	...['-c:a', 'aac', '-t', '4', file('black-start.mp4')],
]);
await ffmpeg([
	...['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=3:r=25'],
	...['-f', 'lavfi', '-i', 'sine=f=440:d=3'],
	...['-filter:a', 'loudnorm=I=-16:TP=-2:LRA=11,aresample=48000'],
	...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file('clean.mp4')],
]);
await ffmpeg([
	...['-f', 'lavfi', '-i', 'color=c=gray:s=800x800'],
	...['-frames:v', '1', file('flat.png')],
]);
await ffmpeg([
	...['-f', 'lavfi', '-i', 'testsrc=s=1024x1024'],
	...['-frames:v', '1', file('chart.png')],
]);
await ffmpeg([
	...['-f', 'lavfi', '-i', 'sine=f=440:d=0.75'],
	...['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1.5'],
	...['-f', 'lavfi', '-i', 'sine=f=440:d=0.75'],
	...['-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-ar', '44100'],
	file('gap.wav'),
]);

const REAL_BLACK_STDERR = (
	await execFileExec({
		command: 'ffmpeg',
		args: analysisArgs(file('black-start.mp4'), {
			kind: 'video',
			hasAudio: true,
			bytes: 0,
		}),
	})
).stderr;

const SUMMARY = `[Parsed_ebur128_1 @ 0x7578c2e040] Summary:

  Integrated loudness:
    I:         -21.8 LUFS
    Threshold: -31.8 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -41.8 LUFS
    LRA low:   -21.8 LUFS
    LRA high:  -21.8 LUFS

  True peak:
    Peak:      -17.7 dBFS
`;

test('parseDetections reads a black run from a literal log line', () => {
	const found = parseDetections(
		'[Parsed_blackdetect_0 @ 0x7578c2ec40] black_start:0 black_end:1 black_duration:1\n',
	);
	assert.deepEqual(found.black, [{start: 0, end: 1}]);
});

test('parseDetections reads freeze and silence intervals', () => {
	const found = parseDetections(
		[
			'[freeze @ 0x1] lavfi.freezedetect.freeze_start: 2',
			'[freeze @ 0x1] lavfi.freezedetect.freeze_duration: 3.5',
			'[freeze @ 0x1] lavfi.freezedetect.freeze_end: 5.5',
			'[silencedetect @ 0x2] silence_start: 1.25',
			'[silencedetect @ 0x2] silence_end: 2.75 | silence_duration: 1.5',
		].join('\n'),
	);
	assert.deepEqual(found.freeze, [{start: 2, end: 5.5}]);
	assert.deepEqual(found.silence, [{start: 1.25, end: 2.75}]);
});

test('parseDetections closes a freeze that runs to the end at the media duration', () => {
	const found = parseDetections(
		'[freeze @ 0x1] lavfi.freezedetect.freeze_start: 1.5\n',
		4,
	);
	assert.deepEqual(found.freeze, [{start: 1.5, end: 4}]);
});

test('parseDetections takes loudness and true peak from the summary, not the progress lines', () => {
	const progress =
		'[Parsed_ebur128_1 @ 0x1] t: 0.7  TARGET:-23 LUFS    M: -9.0 S:-120.7     I: -9.9 LUFS       LRA:   0.0 LU  FTPK: -3.0 dBFS  TPK: -3.0 dBFS\n';
	const found = parseDetections(progress + SUMMARY);
	assert.equal(found.loudnessLufs, -21.8);
	assert.equal(found.truePeakDbtp, -17.7);
});

test('parseDetections reports no loudness for a silent summary', () => {
	const found = parseDetections(
		'Summary:\n\n  Integrated loudness:\n    I:         -inf LUFS\n\n  True peak:\n    Peak:      -inf dBFS\n',
	);
	assert.equal(found.loudnessLufs, undefined);
	assert.equal(found.truePeakDbtp, undefined);
});

test('parseDetections on the real analysis of the black-start video', () => {
	const found = parseDetections(REAL_BLACK_STDERR, 4);
	assert.deepEqual(found.black, [{start: 0, end: 1}]);
	assert.deepEqual(found.silence, []);
	assert.ok(
		found.loudnessLufs !== undefined && found.loudnessLufs < -20 && found.loudnessLufs > -23,
		`loudness ${found.loudnessLufs}`,
	);
});

test('parseLuma summarises every frame', () => {
	const output = [
		'lavfi.signalstats.YMIN=126',
		'lavfi.signalstats.YAVG=126',
		'lavfi.signalstats.YMAX=126',
		'lavfi.signalstats.UMIN=128',
		'lavfi.signalstats.YMIN=16',
		'lavfi.signalstats.YAVG=100',
		'lavfi.signalstats.YMAX=235',
	].join('\n');
	assert.deepEqual(parseLuma(output), {yMin: 16, yMax: 235, yAvg: 113});
	assert.equal(parseLuma('nothing here'), undefined);
});

test('parseProbe reads a video with audio', () => {
	const json = JSON.stringify({
		streams: [
			{codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '25/1', nb_frames: '100', disposition: {attached_pic: 0}},
			{codec_type: 'audio', codec_name: 'aac'},
		],
		format: {duration: '4.000000'},
	});
	assert.deepEqual(parseProbe(json, 2048, 'video'), {
		kind: 'video',
		width: 1280,
		height: 720,
		durationS: 4,
		fps: 25,
		hasAudio: true,
		bytes: 2048,
	});
});

test('parseProbe falls back to a still-image codec when the extension is unknown', () => {
	const json = JSON.stringify({
		streams: [{codec_type: 'video', codec_name: 'png', width: 64, height: 32}],
		format: {duration: 'N/A'},
	});
	assert.deepEqual(parseProbe(json, 10), {
		kind: 'image',
		width: 64,
		height: 32,
		hasAudio: false,
		bytes: 10,
	});
});

test('parseProbe treats cover art on an audio file as audio', () => {
	const json = JSON.stringify({
		streams: [
			{codec_type: 'audio', codec_name: 'mp3'},
			{codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: {attached_pic: 1}},
		],
		format: {duration: '12.5'},
	});
	const probe = parseProbe(json, 1, undefined);
	assert.equal(probe.kind, 'audio');
	assert.equal(probe.durationS, 12.5);
});

test('parseProbe rejects a file with no media streams', () => {
	assert.throws(() => parseProbe('{"streams": []}', 1), /unsupported media/);
	assert.throws(() => parseProbe('not json', 1), /not JSON/);
});

test('runChecks lists the video checks and the worst status wins', () => {
	const measurements: Measurements = {
		probe: {kind: 'video', width: 1280, height: 720, durationS: 5, hasAudio: false, bytes: 1},
		detections: {black: [{start: 4, end: 4.6}], freeze: [{start: 0, end: 2}], silence: []},
	};
	const checks = runChecks(measurements);
	assert.deepEqual(statuses(checks), {
		resolution: 'pass',
		duration: 'pass',
		black_frames: 'warn',
		frozen_frames: 'warn',
		audio_present: 'warn',
	});
	assert.equal(worstStatus(checks), 'warn');
});

test('a silence that only reaches into the last half second is tolerated', () => {
	const measurements: Measurements = {
		probe: {kind: 'audio', durationS: 3, hasAudio: true, bytes: 1},
		detections: {
			black: [],
			freeze: [],
			silence: [{start: 1.8, end: 3}],
			loudnessLufs: -16,
			truePeakDbtp: -3,
		},
	};
	assert.deepEqual(statuses(runChecks(measurements)), {
		silence: 'pass',
		loudness: 'pass',
		true_peak: 'pass',
	});
});

test('true peak and loudness thresholds', () => {
	const at = (loudnessLufs: number, truePeakDbtp: number): Readonly<Record<string, CheckStatus>> =>
		statuses(
			runChecks({
				probe: {kind: 'audio', durationS: 3, hasAudio: true, bytes: 1},
				detections: {black: [], freeze: [], silence: [], loudnessLufs, truePeakDbtp},
			}),
		);
	assert.deepEqual(at(-12, -1), {silence: 'pass', loudness: 'pass', true_peak: 'pass'});
	assert.deepEqual(at(-11.9, -0.9), {silence: 'pass', loudness: 'warn', true_peak: 'warn'});
	assert.deepEqual(at(-20.1, -0.4), {silence: 'pass', loudness: 'warn', true_peak: 'fail'});
});

test('reviewMedia fails a video that starts with a second of black', async () => {
	const review = await reviewMedia({path: file('black-start.mp4'), exec: execFileExec});
	const byId = statuses(review.checks);
	assert.equal(review.verdict, 'fail');
	assert.equal(byId['black_frames'], 'fail');
	assert.deepEqual(Object.keys(byId), [
		'resolution',
		'duration',
		'black_frames',
		'frozen_frames',
		'audio_present',
		'silence',
		'loudness',
		'true_peak',
	]);
	assert.equal(review.probe.kind, 'video');
	assert.equal(review.probe.hasAudio, true);
});

test('reviewMedia gives a clean normalised video no failing check', async () => {
	const review = await reviewMedia({path: file('clean.mp4'), exec: execFileExec});
	assert.deepEqual(statuses(review.checks), {
		resolution: 'pass',
		duration: 'pass',
		black_frames: 'pass',
		frozen_frames: 'pass',
		audio_present: 'pass',
		silence: 'pass',
		loudness: 'pass',
		true_peak: 'pass',
	});
	assert.equal(review.verdict, 'pass');
});

test('reviewMedia fails a flat gray image as blank', async () => {
	const review = await reviewMedia({path: file('flat.png'), exec: execFileExec});
	assert.deepEqual(statuses(review.checks), {dimensions: 'pass', blank: 'fail'});
	assert.equal(review.verdict, 'fail');
});

test('reviewMedia passes a real test chart image', async () => {
	const review = await reviewMedia({path: file('chart.png'), exec: execFileExec});
	assert.deepEqual(statuses(review.checks), {dimensions: 'pass', blank: 'pass'});
	assert.equal(review.probe.kind, 'image');
});

test('reviewMedia warns on a silent gap in the middle of audio', async () => {
	const review = await reviewMedia({path: file('gap.wav'), exec: execFileExec});
	assert.deepEqual(statuses(review.checks), {
		silence: 'warn',
		loudness: 'warn',
		true_peak: 'pass',
	});
	assert.equal(review.verdict, 'warn');
	assert.equal(review.probe.kind, 'audio');
});

test('reviewMedia names a missing file', async () => {
	await assert.rejects(
		reviewMedia({path: file('nope.mp4'), exec: execFileExec}),
		/file not found/,
	);
});

test('reviewMedia rejects a corrupt file', async () => {
	const path = file('junk.png');
	await writeFile(path, 'this is not an image');
	await assert.rejects(
		reviewMedia({path, exec: execFileExec}),
		/ff(?:probe|mpeg) could not read .*junk\.png/,
	);
});

await ffmpeg([
	...['-f', 'lavfi', '-i', 'color=c=0x141414:s=540x960:d=3:r=24'],
	...['-vf', 'drawbox=x=40:y=400:w=200:h=30:c=white:t=fill'],
	...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('dark-slide.mp4')],
]);
await ffmpeg([
	...['-f', 'lavfi', '-i', 'color=c=black:s=540x960:d=3:r=24'],
	...['-vf', 'drawbox=x=250:y=450:w=12:h=12:c=white:t=fill'],
	...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('black-logo.mp4')],
]);
await ffmpeg([
	...['-f', 'lavfi', '-i', 'color=c=black:s=540x960:d=3:r=24'],
	...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', file('all-black.mp4')],
]);

test('reviewMedia passes a #141414 slide with a white headline', async () => {
	const review = await reviewMedia({path: file('dark-slide.mp4'), exec: execFileExec});
	assert.equal(statuses(review.checks)['black_frames'], 'pass');
});

test('reviewMedia passes a #000 slide with a small white logo', async () => {
	const review = await reviewMedia({path: file('black-logo.mp4'), exec: execFileExec});
	assert.equal(statuses(review.checks)['black_frames'], 'pass');
});

test('reviewMedia still fails a video that is black in every frame', async () => {
	const review = await reviewMedia({path: file('all-black.mp4'), exec: execFileExec});
	const black = review.checks.find(c => c.id === 'black_frames');
	assert.equal(black?.status, 'fail');
	assert.equal(black?.detail, 'black for 2.96s (0.00s to 2.96s)');
});

test('reviewMedia warns on a held still by default and skips the freeze check on request', async () => {
	const held = await reviewMedia({path: file('dark-slide.mp4'), exec: execFileExec});
	assert.equal(statuses(held.checks)['frozen_frames'], 'warn');
	const still = await reviewMedia({
		path: file('dark-slide.mp4'),
		exec: execFileExec,
		expectStill: true,
	});
	assert.deepEqual(still.checks.find(c => c.id === 'frozen_frames'), {
		id: 'frozen_frames',
		status: 'pass',
		detail: 'Still scenes, freeze check skipped',
	});
});

test('reviewMedia says a missing ffprobe is not installed', async () => {
	const missing = (params: Parameters<typeof execFileExec>[0]): ReturnType<typeof execFileExec> =>
		execFileExec({...params, command: 'atelier-no-such-ffprobe'});
	await assert.rejects(
		reviewMedia({path: file('dark-slide.mp4'), exec: missing}),
		{message: 'ffprobe is not installed or not on PATH'},
	);
});
