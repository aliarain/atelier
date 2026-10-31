import {stat} from 'node:fs/promises';
import {mediaKindOf, stderrTail} from './exec.ts';
import type {
	CheckStatus,
	Exec,
	ExecResult,
	MediaKind,
	MediaProbe,
	Review,
	ReviewCheck,
} from './types.ts';

export interface Interval {
	readonly start: number;
	readonly end: number;
}

export interface Detections {
	readonly black: readonly Interval[];
	readonly freeze: readonly Interval[];
	readonly silence: readonly Interval[];
	readonly loudnessLufs?: number;
	readonly truePeakDbtp?: number;
}

export interface LumaStats {
	readonly yMin: number;
	readonly yMax: number;
	readonly yAvg: number;
}

export interface Measurements {
	readonly probe: MediaProbe;
	readonly detections: Detections;
	readonly luma?: LumaStats;
	// The caller made a slideshow of stills, so a long hold is the design, not a stall.
	readonly expectStill?: boolean;
}

export interface CheckRule {
	readonly id: string;
	readonly appliesTo: readonly MediaKind[];
	readonly when: (measurements: Measurements) => boolean;
	readonly evaluate: (measurements: Measurements) => ReviewCheck;
}

// pic_th=1 flags a frame only when every pixel is black. A dark slide with a headline or a small
// logo is designed, not broken, and any lower ratio reads it as a black screen.
const VIDEO_FILTER = 'blackdetect=d=0.4:pix_th=0.10:pic_th=1,freezedetect=n=0.003:d=1.5';
const AUDIO_FILTER = 'silencedetect=n=-45dB:d=0.8,ebur128=peak=true';
const IMAGE_FILTER = 'signalstats,metadata=print:file=-';

const PROBE_TIMEOUT_MS = 30_000;
const ANALYSIS_TIMEOUT_MS = 300_000;

const MIN_SIDE_PX = 720;
const MIN_VIDEO_DURATION_S = 0.5;
const BLACK_START_EDGE_S = 0.1;
const BLACK_START_FAIL_S = 0.4;
const BLACK_ANYWHERE_FAIL_S = 1;
const FREEZE_WARN_S = 1.5;
const AUDIO_EXPECTED_AFTER_S = 3;
const SILENCE_WARN_S = 0.8;
// A fade-out tail is normal, so the last stretch of a silence that reaches the end is not counted.
const SILENCE_TAIL_ALLOWANCE_S = 0.5;
const SILENCE_END_TOLERANCE_S = 0.1;
const LOUDNESS_MIN_LUFS = -20;
const LOUDNESS_MAX_LUFS = -12;
const TRUE_PEAK_FAIL_DBTP = -0.5;
const TRUE_PEAK_WARN_DBTP = -1;
const MIN_IMAGE_SIDE_PX = 512;
const BLANK_LUMA_RANGE = 8;

const STATUS_RANK: Readonly<Record<CheckStatus, number>> = {
	pass: 0,
	warn: 1,
	fail: 2,
};

const STILL_IMAGE_CODECS: ReadonlySet<string> = new Set([
	'png',
	'mjpeg',
	'jpeg2000',
	'bmp',
	'tiff',
	'webp',
	'gif',
	'ppm',
	'pgm',
	'targa',
	'apng',
	'avif',
	'heic',
]);

interface ProbedStream {
	readonly type: string;
	readonly codec: string;
	readonly width?: number;
	readonly height?: number;
	readonly durationS?: number;
	readonly frameCount?: number;
	readonly fps?: number;
	readonly attachedPicture: boolean;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Readonly<Record<string, unknown>>;
}

function numberOf(value: unknown): number | undefined {
	if (typeof value !== 'number' && typeof value !== 'string') return undefined;
	if (value === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function frameRateOf(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const [numerator, denominator] = value.split('/').map(numberOf);
	if (numerator === undefined || denominator === undefined) return undefined;
	if (denominator === 0 || numerator === 0) return undefined;
	return numerator / denominator;
}

function parseJson(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
}

function toStream(raw: unknown): ProbedStream | undefined {
	const record = asRecord(raw);
	if (record === undefined) return undefined;
	const disposition = asRecord(record['disposition']);
	return {
		type: String(record['codec_type'] ?? ''),
		codec: String(record['codec_name'] ?? ''),
		width: numberOf(record['width']),
		height: numberOf(record['height']),
		durationS: numberOf(record['duration']),
		frameCount: numberOf(record['nb_frames']),
		fps: frameRateOf(record['avg_frame_rate']) ?? frameRateOf(record['r_frame_rate']),
		attachedPicture: disposition?.['attached_pic'] === 1,
	};
}

function isStillImage(stream: ProbedStream): boolean {
	if (!STILL_IMAGE_CODECS.has(stream.codec)) return false;
	return stream.frameCount === undefined || stream.frameCount <= 1;
}

function kindFromStreams(
	video: ProbedStream | undefined,
	hasAudio: boolean,
): MediaKind | undefined {
	if (video === undefined) return hasAudio ? 'audio' : undefined;
	if (hasAudio) return 'video';
	return isStillImage(video) ? 'image' : 'video';
}

function resolveKind(
	hint: MediaKind | undefined,
	video: ProbedStream | undefined,
	hasAudio: boolean,
): MediaKind | undefined {
	const supported =
		hint === 'audio' ? hasAudio : hint !== undefined && video !== undefined;
	if (hint !== undefined && supported) return hint;
	return kindFromStreams(video, hasAudio);
}

export function parseProbe(
	json: string,
	bytes: number,
	kindHint?: MediaKind,
): MediaProbe {
	const root = asRecord(parseJson(json));
	if (root === undefined) throw new Error('ffprobe returned output that is not JSON');
	const rawStreams = Array.isArray(root['streams']) ? root['streams'] : [];
	const streams = rawStreams.flatMap(raw => toStream(raw) ?? []);
	const video = streams.find(s => s.type === 'video' && !s.attachedPicture);
	const hasAudio = streams.some(s => s.type === 'audio');
	const kind = resolveKind(kindHint, video, hasAudio);
	if (kind === undefined) {
		throw new Error('unsupported media: the file has no video, image or audio stream');
	}
	const format = asRecord(root['format']);
	const audio = streams.find(s => s.type === 'audio');
	const durationS =
		numberOf(format?.['duration']) ?? video?.durationS ?? audio?.durationS;
	if (kind === 'image') {
		return {kind, width: video?.width, height: video?.height, hasAudio, bytes};
	}
	return {
		kind,
		width: video?.width,
		height: video?.height,
		durationS,
		fps: video?.fps,
		hasAudio,
		bytes,
	};
}

function valuesOf(text: string, pattern: RegExp): readonly string[] {
	return [...text.matchAll(pattern)].flatMap(match => match[1] ?? []);
}

function pairIntervals(
	starts: readonly string[],
	ends: readonly string[],
	endOfMedia: number | undefined,
): readonly Interval[] {
	return starts.flatMap((rawStart, index) => {
		const start = Number(rawStart);
		const end = numberOf(ends[index]) ?? endOfMedia;
		return end === undefined || !Number.isFinite(start) ? [] : [{start, end}];
	});
}

// ebur128 prints -inf for silence; that is "no measurement", not a number.
function measureOf(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.endsWith('inf')) return undefined;
	return numberOf(raw);
}

function summaryOf(stderr: string): string {
	const index = stderr.lastIndexOf('Summary:');
	return index < 0 ? '' : stderr.slice(index);
}

// A freeze that runs to the end of the file has a start line and no end line, so the caller
// passes the media duration to close it.
export function parseDetections(
	stderr: string,
	endOfMedia?: number,
): Detections {
	const black = [
		...stderr.matchAll(/black_start:(\S+) black_end:(\S+)/g),
	].flatMap(match => {
		const start = numberOf(match[1]);
		const end = numberOf(match[2]);
		return start === undefined || end === undefined ? [] : [{start, end}];
	});
	const freeze = pairIntervals(
		valuesOf(stderr, /freeze_start: (\S+)/g),
		valuesOf(stderr, /freeze_end: (\S+)/g),
		endOfMedia,
	);
	const silence = pairIntervals(
		valuesOf(stderr, /silence_start: (\S+)/g),
		valuesOf(stderr, /silence_end: (\S+)/g),
		endOfMedia,
	);
	const summary = summaryOf(stderr);
	const loudness = /I:\s+(-?[\d.]+|-?inf) LUFS/.exec(summary)?.[1];
	const peak = /True peak:\s+Peak:\s+(-?[\d.]+|-?inf) (?:dBFS|dBTP)/.exec(
		summary,
	)?.[1];
	return {
		black,
		freeze,
		silence,
		loudnessLufs: measureOf(loudness),
		truePeakDbtp: measureOf(peak),
	};
}

// One value per frame; an animated image is summarised over all of its frames.
export function parseLuma(output: string): LumaStats | undefined {
	const mins = valuesOf(output, /YMIN=([\d.]+)/g).map(Number);
	const maxs = valuesOf(output, /YMAX=([\d.]+)/g).map(Number);
	const avgs = valuesOf(output, /YAVG=([\d.]+)/g).map(Number);
	if (mins.length === 0 || maxs.length === 0 || avgs.length === 0) return undefined;
	return {
		yMin: Math.min(...mins),
		yMax: Math.max(...maxs),
		yAvg: avgs.reduce((sum, value) => sum + value, 0) / avgs.length,
	};
}

function check(id: string, status: CheckStatus, detail: string): ReviewCheck {
	return {id, status, detail};
}

function lengthOf(interval: Interval): number {
	return interval.end - interval.start;
}

function secs(value: number): string {
	return `${value.toFixed(2)}s`;
}

function span(interval: Interval): string {
	return `${secs(interval.start)} to ${secs(interval.end)}`;
}

function longestOf(intervals: readonly Interval[]): Interval | undefined {
	return intervals.reduce<Interval | undefined>(
		(longest, current) =>
			longest === undefined || lengthOf(current) > lengthOf(longest)
				? current
				: longest,
		undefined,
	);
}

function evaluateResolution({probe}: Measurements): ReviewCheck {
	const {width, height} = probe;
	if (width === undefined || height === undefined) {
		return check('resolution', 'warn', 'the file reports no frame size');
	}
	const label = `${width}x${height}`;
	if (Math.min(width, height) < MIN_SIDE_PX) {
		return check('resolution', 'warn', `${label} is under ${MIN_SIDE_PX}px on a side`);
	}
	if (width % 2 !== 0 || height % 2 !== 0) {
		return check('resolution', 'warn', `${label} has an odd side, which many players reject`);
	}
	return check('resolution', 'pass', label);
}

function evaluateDuration({probe}: Measurements): ReviewCheck {
	const {durationS} = probe;
	if (durationS === undefined) {
		return check('duration', 'fail', 'the file reports no duration');
	}
	if (durationS < MIN_VIDEO_DURATION_S) {
		return check('duration', 'fail', `${secs(durationS)} is too short to be a video`);
	}
	return check('duration', 'pass', secs(durationS));
}

function isFailingBlack(interval: Interval): boolean {
	if (lengthOf(interval) > BLACK_ANYWHERE_FAIL_S) return true;
	return (
		interval.start <= BLACK_START_EDGE_S &&
		lengthOf(interval) > BLACK_START_FAIL_S
	);
}

function evaluateBlackFrames({detections}: Measurements): ReviewCheck {
	const {black} = detections;
	const failing = black.find(isFailingBlack);
	if (failing !== undefined) {
		return check(
			'black_frames',
			'fail',
			`black for ${secs(lengthOf(failing))} (${span(failing)})`,
		);
	}
	const longest = longestOf(black);
	if (longest !== undefined) {
		return check(
			'black_frames',
			'warn',
			`${black.length} brief black run(s), longest ${secs(lengthOf(longest))} (${span(longest)})`,
		);
	}
	return check('black_frames', 'pass', 'no black frames');
}

function evaluateFrozenFrames({detections, expectStill}: Measurements): ReviewCheck {
	if (expectStill === true) {
		return check('frozen_frames', 'pass', 'Still scenes, freeze check skipped');
	}
	const frozen = detections.freeze.filter(i => lengthOf(i) > FREEZE_WARN_S);
	const longest = longestOf(frozen);
	if (longest === undefined) {
		return check('frozen_frames', 'pass', 'no frozen stretch over 1.5s');
	}
	return check(
		'frozen_frames',
		'warn',
		`picture frozen for ${secs(lengthOf(longest))} (${span(longest)})`,
	);
}

function evaluateAudioPresent({probe}: Measurements): ReviewCheck {
	const {durationS, hasAudio} = probe;
	if (hasAudio) return check('audio_present', 'pass', 'has an audio track');
	if (durationS !== undefined && durationS > AUDIO_EXPECTED_AFTER_S) {
		return check(
			'audio_present',
			'warn',
			`no audio track on a ${secs(durationS)} video`,
		);
	}
	return check('audio_present', 'pass', 'no audio track, and the video is short');
}

function audibleSilenceS(interval: Interval, durationS: number | undefined): number {
	const reachesEnd =
		durationS !== undefined &&
		interval.end >= durationS - SILENCE_END_TOLERANCE_S;
	return lengthOf(interval) - (reachesEnd ? SILENCE_TAIL_ALLOWANCE_S : 0);
}

function evaluateSilence({probe, detections}: Measurements): ReviewCheck {
	const gaps = detections.silence.filter(
		i => audibleSilenceS(i, probe.durationS) > SILENCE_WARN_S,
	);
	const longest = longestOf(gaps);
	if (longest === undefined) {
		return check('silence', 'pass', 'no silent gap over 0.8s');
	}
	return check(
		'silence',
		'warn',
		`${gaps.length} silent gap(s), longest ${secs(lengthOf(longest))} (${span(longest)})`,
	);
}

function evaluateLoudness({detections}: Measurements): ReviewCheck {
	const lufs = detections.loudnessLufs;
	if (lufs === undefined) {
		return check('loudness', 'fail', 'no loudness could be measured, the audio may be silent');
	}
	const label = `${lufs.toFixed(1)} LUFS`;
	if (lufs < LOUDNESS_MIN_LUFS) {
		return check('loudness', 'warn', `${label} is quieter than the ${LOUDNESS_MIN_LUFS} to ${LOUDNESS_MAX_LUFS} target`);
	}
	if (lufs > LOUDNESS_MAX_LUFS) {
		return check('loudness', 'warn', `${label} is louder than the ${LOUDNESS_MIN_LUFS} to ${LOUDNESS_MAX_LUFS} target`);
	}
	return check('loudness', 'pass', label);
}

function evaluateTruePeak({detections}: Measurements): ReviewCheck {
	const peak = detections.truePeakDbtp;
	if (peak === undefined) {
		return check('true_peak', 'fail', 'no true peak could be measured, the audio may be silent');
	}
	const label = `${peak.toFixed(1)} dBTP`;
	if (peak > TRUE_PEAK_FAIL_DBTP) {
		return check('true_peak', 'fail', `${label} will clip after encoding`);
	}
	if (peak > TRUE_PEAK_WARN_DBTP) {
		return check('true_peak', 'warn', `${label} leaves almost no headroom`);
	}
	return check('true_peak', 'pass', label);
}

function evaluateDimensions({probe}: Measurements): ReviewCheck {
	const {width, height} = probe;
	if (width === undefined || height === undefined) {
		return check('dimensions', 'warn', 'the file reports no size');
	}
	const label = `${width}x${height}`;
	if (Math.min(width, height) < MIN_IMAGE_SIDE_PX) {
		return check('dimensions', 'warn', `${label} is under ${MIN_IMAGE_SIDE_PX}px on a side`);
	}
	return check('dimensions', 'pass', label);
}

function evaluateBlank({luma}: Measurements): ReviewCheck {
	if (luma === undefined) {
		return check('blank', 'fail', 'no brightness could be measured');
	}
	const range = luma.yMax - luma.yMin;
	if (range < BLANK_LUMA_RANGE) {
		return check(
			'blank',
			'fail',
			`flat image: brightness spans ${range} of 255 (average ${luma.yAvg.toFixed(0)})`,
		);
	}
	return check('blank', 'pass', `brightness spans ${range} of 255`);
}

const always = (): boolean => true;
const hasAudio = ({probe}: Measurements): boolean => probe.hasAudio;

export const CHECK_RULES: readonly CheckRule[] = [
	{id: 'resolution', appliesTo: ['video'], when: always, evaluate: evaluateResolution},
	{id: 'duration', appliesTo: ['video'], when: always, evaluate: evaluateDuration},
	{id: 'black_frames', appliesTo: ['video'], when: always, evaluate: evaluateBlackFrames},
	{id: 'frozen_frames', appliesTo: ['video'], when: always, evaluate: evaluateFrozenFrames},
	{id: 'audio_present', appliesTo: ['video'], when: always, evaluate: evaluateAudioPresent},
	{id: 'silence', appliesTo: ['audio', 'video'], when: hasAudio, evaluate: evaluateSilence},
	{id: 'loudness', appliesTo: ['audio', 'video'], when: hasAudio, evaluate: evaluateLoudness},
	{id: 'true_peak', appliesTo: ['audio', 'video'], when: hasAudio, evaluate: evaluateTruePeak},
	{id: 'dimensions', appliesTo: ['image'], when: always, evaluate: evaluateDimensions},
	{id: 'blank', appliesTo: ['image'], when: always, evaluate: evaluateBlank},
];

export function runChecks(measurements: Measurements): readonly ReviewCheck[] {
	return CHECK_RULES.filter(
		rule =>
			rule.appliesTo.includes(measurements.probe.kind) &&
			rule.when(measurements),
	).map(rule => rule.evaluate(measurements));
}

export function worstStatus(checks: readonly ReviewCheck[]): CheckStatus {
	return checks.reduce<CheckStatus>(
		(worst, current) =>
			STATUS_RANK[current.status] > STATUS_RANK[worst] ? current.status : worst,
		'pass',
	);
}

export function analysisArgs(path: string, probe: MediaProbe): readonly string[] {
	const videoArgs = probe.kind === 'video' ? ['-vf', VIDEO_FILTER] : ['-vn'];
	const audioArgs = probe.hasAudio ? ['-af', AUDIO_FILTER] : [];
	return [
		'-hide_banner',
		'-nostats',
		'-i',
		path,
		...videoArgs,
		...audioArgs,
		'-f',
		'null',
		'-',
	];
}

export function imageArgs(path: string): readonly string[] {
	return ['-hide_banner', '-i', path, '-vf', IMAGE_FILTER, '-f', 'null', '-'];
}

async function sizeOf(path: string): Promise<number> {
	const info = await stat(path).catch(() => undefined);
	if (info === undefined) throw new Error(`file not found: ${path}`);
	if (!info.isFile()) throw new Error(`not a file: ${path}`);
	return info.size;
}

async function run(params: {
	readonly exec: Exec;
	readonly command: string;
	readonly args: readonly string[];
	readonly path: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}): Promise<ExecResult> {
	const {exec, command, args, path, timeoutMs, signal} = params;
	const result = await exec({command, args, timeoutMs, signal});
	if (result.code === 0) return result;
	if (result.errno === 'ENOENT') {
		throw new Error(`${command} is not installed or not on PATH`);
	}
	if (result.timedOut === true) {
		throw new Error(`${command} took longer than ${Math.round(timeoutMs / 1000)}s reading ${path}`);
	}
	throw new Error(
		`${command} could not read ${path} (exit ${result.code}): ${stderrTail(result.stderr)}`,
	);
}

async function measure(params: {
	readonly path: string;
	readonly probe: MediaProbe;
	readonly exec: Exec;
	readonly signal?: AbortSignal;
}): Promise<Measurements> {
	const {path, probe, exec, signal} = params;
	const empty: Detections = {black: [], freeze: [], silence: []};
	if (probe.kind === 'image') {
		const result = await run({
			exec,
			command: 'ffmpeg',
			args: imageArgs(path),
			path,
			timeoutMs: ANALYSIS_TIMEOUT_MS,
			signal,
		});
		return {probe, detections: empty, luma: parseLuma(result.stdout)};
	}
	const result = await run({
		exec,
		command: 'ffmpeg',
		args: analysisArgs(path, probe),
		path,
		timeoutMs: ANALYSIS_TIMEOUT_MS,
		signal,
	});
	return {probe, detections: parseDetections(result.stderr, probe.durationS)};
}

export async function reviewMedia(params: {
	readonly path: string;
	readonly exec: Exec;
	readonly signal?: AbortSignal;
	readonly expectStill?: boolean;
}): Promise<Review> {
	const {path, exec, signal, expectStill} = params;
	const bytes = await sizeOf(path);
	const probed = await run({
		exec,
		command: 'ffprobe',
		args: ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '-i', path],
		path,
		timeoutMs: PROBE_TIMEOUT_MS,
		signal,
	});
	const probe = parseProbe(probed.stdout, bytes, mediaKindOf(path));
	const measured = await measure({path, probe, exec, signal});
	const measurements: Measurements = {...measured, expectStill};
	const checks = runChecks(measurements);
	return {path, probe, checks, verdict: worstStatus(checks)};
}
