import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {before, describe, it, after} from 'node:test';
import {
	buildFfmpegArgs,
	effectiveTransitionS,
	totalDurationS,
	videoEngine,
} from '../src/engines/video.ts';
import type {VideoInput, VideoMotion} from '../src/engines/video.ts';
import {execFileExec, isEngineFailure} from '../src/exec.ts';
import type {EngineRunContext} from '../src/types.ts';

function sceneList(
	motions: readonly VideoMotion[],
	durationS = 2,
): VideoInput['scenes'] {
	return motions.map((motion, index) => ({
		image: `/t/${index}.png`,
		durationS,
		motion,
	}));
}

function inputOf(overrides: Partial<VideoInput>): VideoInput {
	return {
		width: 320,
		height: 568,
		fps: 30,
		transitionS: 0.5,
		musicVolume: 0.25,
		scenes: sceneList(['still', 'zoom_in']),
		...overrides,
	};
}

function filterComplexOf(args: readonly string[]): string {
	return args[args.indexOf('-filter_complex') + 1] ?? '';
}

describe('video parse', () => {
	it('applies every default', () => {
		const parsed = videoEngine.parse({
			scenes: [{image: '/a/one.png', duration_s: 3}],
		});
		assert.deepEqual(parsed, {
			ok: true,
			value: {
				width: 1080,
				height: 1920,
				fps: 30,
				scenes: [{image: '/a/one.png', durationS: 3, motion: 'still'}],
				transitionS: 0.5,
				voiceover: undefined,
				music: undefined,
				musicVolume: 0.25,
			},
		});
	});

	it('maps snake_case keys to camelCase fields', () => {
		const parsed = videoEngine.parse({
			width: 720,
			height: 1280,
			fps: 24,
			scenes: [
				{image: '/a/one.JPG', duration_s: 1.5, motion: 'pan_right'},
				{image: '/a/two.webp', duration_s: 60, motion: 'zoom_out'},
			],
			transition_s: 0,
			voiceover: '/a/voice.mp3',
			music: '/a/music.wav',
			music_volume: 0,
		});
		assert.deepEqual(parsed, {
			ok: true,
			value: {
				width: 720,
				height: 1280,
				fps: 24,
				scenes: [
					{image: '/a/one.JPG', durationS: 1.5, motion: 'pan_right'},
					{image: '/a/two.webp', durationS: 60, motion: 'zoom_out'},
				],
				transitionS: 0,
				voiceover: '/a/voice.mp3',
				music: '/a/music.wav',
				musicVolume: 0,
			},
		});
	});

	const rejections: readonly (readonly [string, unknown, string])[] = [
		['a non-object', 'nope', 'input must be an object'],
		['missing scenes', {}, 'scenes must be an array'],
		['empty scenes', {scenes: []}, 'scenes must hold 1 to 60 items'],
		[
			'61 scenes',
			{scenes: Array.from({length: 61}, () => ({image: '/a.png', duration_s: 1}))},
			'scenes must hold 1 to 60 items',
		],
		[
			'a relative image',
			{scenes: [{image: 'a.png', duration_s: 1}]},
			'scenes[0].image must be an absolute path',
		],
		[
			'a gif image',
			{scenes: [{image: '/a.gif', duration_s: 1}]},
			'scenes[0].image must be a png, jpg or webp file',
		],
		[
			'a missing duration',
			{scenes: [{image: '/a.png'}]},
			'scenes[0].duration_s is required',
		],
		[
			'a too-short duration',
			{scenes: [{image: '/a.png', duration_s: 0.4}]},
			'scenes[0].duration_s must be between 0.5 and 60',
		],
		[
			'a too-long duration',
			{scenes: [{image: '/a.png', duration_s: 61}]},
			'scenes[0].duration_s must be between 0.5 and 60',
		],
		[
			'an unknown motion',
			{scenes: [{image: '/a.png', duration_s: 1, motion: 'spin'}]},
			'scenes[0].motion must be one of still, zoom_in, zoom_out, pan_left, pan_right',
		],
		[
			'the second scene being bad',
			{scenes: [{image: '/a.png', duration_s: 1}, {image: '/b.png', duration_s: 'x'}]},
			'scenes[1].duration_s must be a number',
		],
		[
			'a tiny width',
			{width: 100, scenes: [{image: '/a.png', duration_s: 1}]},
			'width must be between 160 and 3840',
		],
		[
			'a fractional height',
			{height: 640.5, scenes: [{image: '/a.png', duration_s: 1}]},
			'height must be an integer',
		],
		[
			'an odd width',
			{width: 321, scenes: [{image: '/a.png', duration_s: 1}]},
			'width and height must be even numbers',
		],
		[
			'fps 29',
			{fps: 29, scenes: [{image: '/a.png', duration_s: 1}]},
			'fps must be 24, 25, 30 or 60',
		],
		[
			'a transition over 2s',
			{transition_s: 2.5, scenes: [{image: '/a.png', duration_s: 1}]},
			'transition_s must be between 0 and 2',
		],
		[
			'a relative voiceover',
			{voiceover: 'v.mp3', scenes: [{image: '/a.png', duration_s: 1}]},
			'voiceover must be an absolute path',
		],
		[
			'a relative music path',
			{music: 'm.mp3', scenes: [{image: '/a.png', duration_s: 1}]},
			'music must be an absolute path',
		],
		[
			'music volume above 1',
			{music_volume: 1.5, scenes: [{image: '/a.png', duration_s: 1}]},
			'music_volume must be between 0 and 1',
		],
	];

	for (const [name, raw, error] of rejections) {
		it(`rejects ${name}`, () => {
			assert.deepEqual(videoEngine.parse(raw), {ok: false, error});
		});
	}
});

describe('totalDurationS', () => {
	it('is the plain sum for one scene', () => {
		assert.equal(totalDurationS(inputOf({scenes: sceneList(['still'], 3)})), 3);
	});

	it('subtracts one overlap per join', () => {
		assert.equal(totalDurationS(inputOf({scenes: sceneList(['still', 'still'])})), 3.5);
		assert.equal(
			totalDurationS(inputOf({scenes: sceneList(['still', 'still', 'still'])})),
			5,
		);
	});

	it('is the plain sum when the transition is zero', () => {
		assert.equal(
			totalDurationS(
				inputOf({transitionS: 0, scenes: sceneList(['still', 'still', 'still'])}),
			),
			6,
		);
	});

	it('shortens the crossfade to half of the shortest scene', () => {
		const input = inputOf({
			transitionS: 2,
			scenes: [
				{image: '/t/0.png', durationS: 4, motion: 'still'},
				{image: '/t/1.png', durationS: 1, motion: 'still'},
			],
		});
		assert.equal(effectiveTransitionS(input), 0.5);
		assert.equal(totalDurationS(input), 4.5);
	});
});

describe('buildFfmpegArgs', () => {
	it('builds the exact graph for two scenes without audio', () => {
		const args = buildFfmpegArgs(inputOf({}), '/out/video.mp4');
		assert.equal(
			filterComplexOf(args),
			[
				'[0:v]scale=320:568:force_original_aspect_ratio=increase,crop=320:568,setsar=1,format=yuv420p,fps=30[v0]',
				"[1:v]scale=640:1136:force_original_aspect_ratio=increase,crop=640:1136,zoompan=z='1+0.15*in/59':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=320x568:fps=30,setsar=1,format=yuv420p,fps=30[v1]",
				'[v0][v1]xfade=transition=fade:duration=0.5:offset=1.5[vout]',
			].join(';'),
		);
		assert.deepEqual(args, [
			'-y',
			'-hide_banner',
			'-nostats',
			'-loglevel',
			'error',
			'-loop',
			'1',
			'-framerate',
			'30',
			'-t',
			'2',
			'-i',
			'/t/0.png',
			'-loop',
			'1',
			'-framerate',
			'30',
			'-t',
			'2',
			'-i',
			'/t/1.png',
			'-filter_complex',
			filterComplexOf(args),
			'-map',
			'[vout]',
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'20',
			'-pix_fmt',
			'yuv420p',
			'-movflags',
			'+faststart',
			'-t',
			'3.5',
			'/out/video.mp4',
		]);
	});

	it('builds the exact graph for three scenes with a voiceover', () => {
		const args = buildFfmpegArgs(
			inputOf({
				scenes: sceneList(['still', 'zoom_in', 'pan_left']),
				voiceover: '/t/v.wav',
			}),
			'/out/video.mp4',
		);
		assert.equal(
			filterComplexOf(args),
			[
				'[0:v]scale=320:568:force_original_aspect_ratio=increase,crop=320:568,setsar=1,format=yuv420p,fps=30[v0]',
				"[1:v]scale=640:1136:force_original_aspect_ratio=increase,crop=640:1136,zoompan=z='1+0.15*in/59':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=320x568:fps=30,setsar=1,format=yuv420p,fps=30[v1]",
				"[2:v]scale=640:1136:force_original_aspect_ratio=increase,crop=640:1136,zoompan=z='1.15':x='(iw-iw/zoom)*(1-in/59)':y='ih/2-ih/zoom/2':d=1:s=320x568:fps=30,setsar=1,format=yuv420p,fps=30[v2]",
				'[v0][v1]xfade=transition=fade:duration=0.5:offset=1.5[x1]',
				'[x1][v2]xfade=transition=fade:duration=0.5:offset=3[vout]',
				'[3:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=5,asetpts=PTS-STARTPTS,apad=whole_dur=5[a0]',
				'[a0]amix=inputs=1:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]',
			].join(';'),
		);
		assert.deepEqual(args.slice(args.indexOf('-map')), [
			'-map',
			'[vout]',
			'-map',
			'[aout]',
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'20',
			'-pix_fmt',
			'yuv420p',
			'-movflags',
			'+faststart',
			'-c:a',
			'aac',
			'-b:a',
			'192k',
			'-t',
			'5',
			'/out/video.mp4',
		]);
		assert.deepEqual(args.slice(args.indexOf('/t/2.png') + 1, args.indexOf('-filter_complex')), [
			'-i',
			'/t/v.wav',
		]);
	});

	it('mixes voiceover and music with the music faded and quieted', () => {
		const args = buildFfmpegArgs(
			inputOf({voiceover: '/t/v.wav', music: '/t/m.mp3', musicVolume: 0.4}),
			'/out/video.mp4',
		);
		const audio = filterComplexOf(args).split(';').slice(3);
		assert.deepEqual(audio, [
			'[2:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=3.5,asetpts=PTS-STARTPTS,apad=whole_dur=3.5[a0]',
			'[3:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=3.5,asetpts=PTS-STARTPTS,apad=whole_dur=3.5,volume=0.4,afade=t=out:st=2:d=1.5[a1]',
			'[a0][a1]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]',
		]);
	});

	it('numbers a music-only input from the first audio slot', () => {
		const args = buildFfmpegArgs(inputOf({music: '/t/m.mp3'}), '/out/video.mp4');
		assert.equal(
			filterComplexOf(args).split(';').at(-2),
			'[2:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=3.5,asetpts=PTS-STARTPTS,apad=whole_dur=3.5,volume=0.25,afade=t=out:st=2:d=1.5[a0]',
		);
	});

	it('fades music over the whole video when it is shorter than the fade', () => {
		const args = buildFfmpegArgs(
			inputOf({music: '/t/m.mp3', scenes: sceneList(['still'], 1)}),
			'/out/video.mp4',
		);
		assert.ok(filterComplexOf(args).includes('afade=t=out:st=0:d=1[a0]'));
	});

	it('joins with concat when the transition is zero', () => {
		const args = buildFfmpegArgs(
			inputOf({transitionS: 0, scenes: sceneList(['still', 'still', 'still'])}),
			'/out/video.mp4',
		);
		assert.equal(
			filterComplexOf(args).split(';').at(-1),
			'[v0][v1][v2]concat=n=3:v=1:a=0[vout]',
		);
		assert.equal(args[args.indexOf('-t', args.indexOf('-filter_complex')) + 1], '6');
	});

	it('passes a single scene straight through', () => {
		const args = buildFfmpegArgs(
			inputOf({scenes: sceneList(['still'], 3)}),
			'/out/video.mp4',
		);
		assert.equal(filterComplexOf(args).split(';').at(-1), '[v0]null[vout]');
	});

	it('clamps the crossfade to half of the shortest scene in the offsets', () => {
		const args = buildFfmpegArgs(
			inputOf({
				transitionS: 2,
				scenes: [
					{image: '/t/0.png', durationS: 4, motion: 'still'},
					{image: '/t/1.png', durationS: 1, motion: 'still'},
				],
			}),
			'/out/video.mp4',
		);
		assert.equal(
			filterComplexOf(args).split(';').at(-1),
			'[v0][v1]xfade=transition=fade:duration=0.5:offset=3.5[vout]',
		);
	});

	it('moves pan_right and zoom_out opposite to pan_left and zoom_in', () => {
		const args = buildFfmpegArgs(
			inputOf({scenes: sceneList(['zoom_out', 'pan_right'], 1)}),
			'/out/video.mp4',
		);
		const graph = filterComplexOf(args);
		assert.ok(graph.includes("zoompan=z='1.15-0.15*in/29':x='iw/2-iw/zoom/2'"));
		assert.ok(graph.includes("zoompan=z='1.15':x='(iw-iw/zoom)*in/29'"));
	});
});

describe('video engine real ffmpeg', () => {
	const probeTarget: {dir: string} = {dir: ''};

	before(async () => {
		probeTarget.dir = await mkdtemp(join(tmpdir(), 'studio-video-'));
		const colors = ['red', 'blue', 'green'];
		const images = colors.map(color =>
			execFileExec({
				command: 'ffmpeg',
				args: [
					'-y',
					'-f',
					'lavfi',
					'-i',
					`color=c=${color}:s=320x240`,
					'-frames:v',
					'1',
					join(probeTarget.dir, `${color}.png`),
				],
			}),
		);
		const voice = execFileExec({
			command: 'ffmpeg',
			args: [
				'-y',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=4',
				join(probeTarget.dir, 'voice.wav'),
			],
		});
		const results = await Promise.all([...images, voice]);
		assert.deepEqual(
			results.map(result => result.code),
			[0, 0, 0, 0],
		);
	});

	after(async () => {
		await rm(probeTarget.dir, {recursive: true, force: true});
	});

	async function compose(input: VideoInput): Promise<string> {
		const outDir = await mkdtemp(join(probeTarget.dir, 'out-'));
		const ctx: EngineRunContext = {
			outDir,
			cwd: outDir,
			signal: AbortSignal.any([]),
			exec: execFileExec,
			env: {},
			fetch,
		};
		const outputs = await videoEngine.run({input, ctx});
		assert.equal(outputs.length, 1);
		assert.equal(outputs[0]?.kind, 'video');
		assert.equal(outputs[0]?.path, join(outDir, 'video.mp4'));
		assert.ok((outputs[0]?.bytes ?? 0) > 1000);
		return join(outDir, 'video.mp4');
	}

	async function probe(path: string): Promise<{
		readonly duration: number;
		readonly streams: readonly {
			readonly codec_type: string;
			readonly width?: number;
			readonly height?: number;
		}[];
	}> {
		const result = await execFileExec({
			command: 'ffprobe',
			args: [
				'-v',
				'error',
				'-show_entries',
				'format=duration:stream=codec_type,width,height',
				'-of',
				'json',
				path,
			],
		});
		assert.equal(result.code, 0);
		const parsed = JSON.parse(result.stdout) as {
			readonly format: {readonly duration: string};
			readonly streams: readonly {
				readonly codec_type: string;
				readonly width?: number;
				readonly height?: number;
			}[];
		};
		return {duration: Number(parsed.format.duration), streams: parsed.streams};
	}

	function realInput(overrides: Partial<VideoInput>): VideoInput {
		return inputOf({
			scenes: ['red', 'blue', 'green'].map((color, index) => ({
				image: join(probeTarget.dir, `${color}.png`),
				durationS: 2,
				motion: (['still', 'zoom_in', 'pan_left'] as const)[index] ?? 'still',
			})),
			...overrides,
		});
	}

	it('is available', async () => {
		assert.deepEqual(await videoEngine.available({exec: execFileExec, env: {}}), {
			ok: true,
		});
	});

	it('composes three scenes with a voiceover into the expected mp4', async () => {
		const input = realInput({voiceover: join(probeTarget.dir, 'voice.wav')});
		const info = await probe(await compose(input));
		assert.ok(
			Math.abs(info.duration - totalDurationS(input)) < 0.15,
			`duration ${info.duration} vs ${totalDurationS(input)}`,
		);
		const video = info.streams.filter(stream => stream.codec_type === 'video');
		assert.equal(video.length, 1);
		assert.equal(video[0]?.width, 320);
		assert.equal(video[0]?.height, 568);
		assert.equal(info.streams.filter(stream => stream.codec_type === 'audio').length, 1);
	});

	it('composes with voiceover and music mixed', async () => {
		const input = realInput({
			voiceover: join(probeTarget.dir, 'voice.wav'),
			music: join(probeTarget.dir, 'voice.wav'),
		});
		const info = await probe(await compose(input));
		assert.ok(Math.abs(info.duration - 5) < 0.15, `duration ${info.duration}`);
		assert.equal(info.streams.filter(stream => stream.codec_type === 'audio').length, 1);
	});

	it('composes silent video with no audio stream', async () => {
		const input = realInput({});
		const info = await probe(await compose(input));
		assert.ok(Math.abs(info.duration - 5) < 0.15, `duration ${info.duration}`);
		assert.equal(info.streams.filter(stream => stream.codec_type === 'audio').length, 0);
		assert.equal(info.streams.filter(stream => stream.codec_type === 'video').length, 1);
	});

	it('throws missing_input for a file that does not exist', async () => {
		const input = realInput({voiceover: join(probeTarget.dir, 'nope.wav')});
		await assert.rejects(compose(input), error => {
			assert.ok(isEngineFailure(error));
			assert.equal(error.code, 'missing_input');
			assert.equal(error.retryable, false);
			assert.equal(error.message, `Input file not found: ${join(probeTarget.dir, 'nope.wav')}`);
			return true;
		});
	});

	it('throws compose_failed when ffmpeg rejects the media', async () => {
		const input = realInput({voiceover: join(probeTarget.dir, 'red.png')});
		await assert.rejects(compose(input), error => {
			assert.ok(isEngineFailure(error));
			assert.equal(error.code, 'compose_failed');
			assert.equal(error.retryable, true);
			return true;
		});
	});
});
