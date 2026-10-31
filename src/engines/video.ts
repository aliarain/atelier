import {access, rm, stat} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {engineFailure, environmentFailure, stderrTail} from '../exec.ts';
import type {EngineFailure} from '../exec.ts';
import type {
	Availability,
	Engine,
	EngineRunContext,
	Exec,
	ExecResult,
	JsonObjectSchema,
	MediaOutput,
	Parsed,
} from '../types.ts';

export type VideoMotion =
	| 'still'
	| 'zoom_in'
	| 'zoom_out'
	| 'pan_left'
	| 'pan_right';

export interface VideoScene {
	readonly image: string;
	readonly durationS: number;
	readonly motion: VideoMotion;
}

// Fully resolved: parse applies every default, so buildFfmpegArgs never guesses.
export interface VideoInput {
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly scenes: readonly VideoScene[];
	readonly transitionS: number;
	readonly voiceover?: string;
	readonly music?: string;
	readonly musicVolume: number;
}

type RawRecord = Readonly<Record<string, unknown>>;

const FPS_CHOICES: readonly number[] = [24, 25, 30, 60];
const MOTIONS: readonly VideoMotion[] = [
	'still',
	'zoom_in',
	'zoom_out',
	'pan_left',
	'pan_right',
];
const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp'];
const MUSIC_FADE_S = 1.5;
const MOTION_ZOOM = 1.15;
const MOTION_TRAVEL = 0.15;
// Motion scenes are zoomed on a 2x canvas: zoompan snaps to whole pixels, so a 1x source jitters.
const MOTION_SUPERSAMPLE = 2;
const COMPOSE_BASE_TIMEOUT_MS = 60_000;
const COMPOSE_TIMEOUT_PER_SECOND_MS = 20_000;
const COMPOSE_MAX_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;
const DECODE_TIMEOUT_MS = 30_000;
const MAX_IMAGE_SIDE_PX = 16_384;

const SCHEMA: JsonObjectSchema = {
	type: 'object',
	properties: {
		width: {
			type: 'integer',
			minimum: 160,
			maximum: 3840,
			description: 'Output width in pixels, even number. Default 1080.',
		},
		height: {
			type: 'integer',
			minimum: 160,
			maximum: 3840,
			description: 'Output height in pixels, even number. Default 1920.',
		},
		fps: {
			type: 'integer',
			enum: [24, 25, 30, 60],
			description: 'Frames per second. Default 30.',
		},
		scenes: {
			type: 'array',
			minItems: 1,
			maxItems: 60,
			description: 'Stills shown in order. Each is scaled to cover the frame, then cropped.',
			items: {
				type: 'object',
				properties: {
					image: {
						type: 'string',
						description: 'Absolute path to a png, jpg or webp file.',
					},
					duration_s: {
						type: 'number',
						minimum: 0.5,
						maximum: 60,
						description: 'Seconds this scene is on screen, before crossfades overlap.',
					},
					motion: {
						type: 'string',
						enum: MOTIONS,
						description: 'Camera move over the still. Default still.',
					},
				},
				required: ['image', 'duration_s'],
			},
		},
		transition_s: {
			type: 'number',
			minimum: 0,
			maximum: 2,
			description:
				'Crossfade between scenes, shortened to half of the shortest scene if needed. Default 0.5.',
		},
		voiceover: {
			type: 'string',
			description: 'Absolute path to a narration audio file.',
		},
		music: {
			type: 'string',
			description: 'Absolute path to a music audio file. Fades out over the last 1.5 seconds.',
		},
		music_volume: {
			type: 'number',
			minimum: 0,
			maximum: 1,
			description: 'Music loudness before mixing. Default 0.25.',
		},
	},
	required: ['scenes'],
};

function isRecord(value: unknown): value is RawRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: string): {readonly ok: false; readonly error: string} {
	return {ok: false, error};
}

function numberField(params: {
	readonly source: RawRecord;
	readonly key: string;
	readonly min: number;
	readonly max: number;
	readonly fallback: number;
	readonly integer: boolean;
}): Parsed<number> {
	const {source, key, min, max, fallback, integer} = params;
	const value = source[key];
	if (value === undefined) return {ok: true, value: fallback};
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fail(`${key} must be a number`);
	}
	if (integer && !Number.isInteger(value)) return fail(`${key} must be an integer`);
	if (value < min || value > max) return fail(`${key} must be between ${min} and ${max}`);
	return {ok: true, value};
}

function pathField(
	source: RawRecord,
	key: string,
): Parsed<string | undefined> {
	const value = source[key];
	if (value === undefined) return {ok: true, value: undefined};
	if (typeof value !== 'string' || !isAbsolute(value)) {
		return fail(`${key} must be an absolute path`);
	}
	return {ok: true, value};
}

function hasImageExtension(path: string): boolean {
	const extension = path.split('.').pop()?.toLowerCase() ?? '';
	return IMAGE_EXTENSIONS.includes(extension);
}

function parseScene(raw: unknown, index: number): Parsed<VideoScene> {
	const label = `scenes[${index}]`;
	if (!isRecord(raw)) return fail(`${label} must be an object`);
	const image = raw['image'];
	if (typeof image !== 'string' || !isAbsolute(image)) {
		return fail(`${label}.image must be an absolute path`);
	}
	if (!hasImageExtension(image)) {
		return fail(`${label}.image must be a png, jpg or webp file`);
	}
	if (raw['duration_s'] === undefined) return fail(`${label}.duration_s is required`);
	const duration = numberField({
		source: raw,
		key: 'duration_s',
		min: 0.5,
		max: 60,
		fallback: 0.5,
		integer: false,
	});
	if (!duration.ok) return fail(`${label}.${duration.error}`);
	const motion = raw['motion'] ?? 'still';
	if (!MOTIONS.includes(motion as VideoMotion)) {
		return fail(`${label}.motion must be one of ${MOTIONS.join(', ')}`);
	}
	return {
		ok: true,
		value: {image, durationS: duration.value, motion: motion as VideoMotion},
	};
}

function parseScenes(raw: unknown): Parsed<readonly VideoScene[]> {
	if (!Array.isArray(raw)) return fail('scenes must be an array');
	if (raw.length < 1 || raw.length > 60) return fail('scenes must hold 1 to 60 items');
	const scenes: VideoScene[] = [];
	for (const [index, item] of raw.entries()) {
		const scene = parseScene(item, index);
		if (!scene.ok) return scene;
		scenes.push(scene.value);
	}
	return {ok: true, value: scenes};
}

function parseVideoInput(raw: unknown): Parsed<VideoInput> {
	if (!isRecord(raw)) return fail('input must be an object');
	const width = numberField({source: raw, key: 'width', min: 160, max: 3840, fallback: 1080, integer: true});
	if (!width.ok) return width;
	const height = numberField({source: raw, key: 'height', min: 160, max: 3840, fallback: 1920, integer: true});
	if (!height.ok) return height;
	if (width.value % 2 !== 0 || height.value % 2 !== 0) {
		return fail('width and height must be even numbers');
	}
	const fps = numberField({source: raw, key: 'fps', min: 24, max: 60, fallback: 30, integer: true});
	if (!fps.ok) return fps;
	if (!FPS_CHOICES.includes(fps.value)) return fail('fps must be 24, 25, 30 or 60');
	const scenes = parseScenes(raw['scenes']);
	if (!scenes.ok) return scenes;
	const transition = numberField({source: raw, key: 'transition_s', min: 0, max: 2, fallback: 0.5, integer: false});
	if (!transition.ok) return transition;
	const voiceover = pathField(raw, 'voiceover');
	if (!voiceover.ok) return voiceover;
	const music = pathField(raw, 'music');
	if (!music.ok) return music;
	const volume = numberField({source: raw, key: 'music_volume', min: 0, max: 1, fallback: 0.25, integer: false});
	if (!volume.ok) return volume;
	return {
		ok: true,
		value: {
			width: width.value,
			height: height.value,
			fps: fps.value,
			scenes: scenes.value,
			transitionS: transition.value,
			voiceover: voiceover.value,
			music: music.value,
			musicVolume: volume.value,
		},
	};
}

// Short enough to read in a filter graph, exact enough that 0.1 + 0.2 never prints as 0.30000000000000004.
export function num(value: number): string {
	return String(Number(value.toFixed(4)));
}

// The crossfade can never exceed half of the shortest scene, or a scene would be mostly blend.
// It is snapped to a whole number of frames: xfade drops a scene whose overlap is shorter than
// one frame, and a fade under one frame is invisible anyway, so that case falls back to a cut.
export function effectiveTransitionS(input: VideoInput): number {
	if (input.scenes.length < 2) return 0;
	const shortest = Math.min(...input.scenes.map(scene => scene.durationS));
	const capped = Math.min(input.transitionS, shortest / 2);
	return Math.round(capped * input.fps) / input.fps;
}

export function totalDurationS(input: VideoInput): number {
	const sum = input.scenes.reduce((total, scene) => total + scene.durationS, 0);
	return sum - (input.scenes.length - 1) * effectiveTransitionS(input);
}

// `in` is the input frame number; each scene input is one frame per output frame, so zoompan emits d=1 per frame.
function motionExpressions(frames: number): Readonly<Record<VideoMotion, string | undefined>> {
	const last = Math.max(frames - 1, 1);
	const progress = `in/${last}`;
	const centerX = `x='iw/2-iw/zoom/2'`;
	const centerY = `y='ih/2-ih/zoom/2'`;
	const travelX = `(iw-iw/zoom)`;
	const fixedZoom = `z='${MOTION_ZOOM}'`;
	return {
		still: undefined,
		zoom_in: `z='1+${MOTION_TRAVEL}*${progress}':${centerX}:${centerY}`,
		zoom_out: `z='${MOTION_ZOOM}-${MOTION_TRAVEL}*${progress}':${centerX}:${centerY}`,
		pan_left: `${fixedZoom}:x='${travelX}*(1-${progress})':${centerY}`,
		pan_right: `${fixedZoom}:x='${travelX}*${progress}':${centerY}`,
	};
}

function sceneFilter(index: number, scene: VideoScene, input: VideoInput): string {
	const {width, height, fps} = input;
	const frames = Math.round(scene.durationS * fps);
	const expressions = motionExpressions(frames)[scene.motion];
	const scale = expressions === undefined ? 1 : MOTION_SUPERSAMPLE;
	const cover = `scale=${width * scale}:${height * scale}:force_original_aspect_ratio=increase,crop=${width * scale}:${height * scale}`;
	const move =
		expressions === undefined
			? ''
			: `,zoompan=${expressions}:d=1:s=${width}x${height}:fps=${fps}`;
	return `[${index}:v]${cover}${move},setsar=1,format=yuv420p,fps=${fps}[v${index}]`;
}

function videoChain(input: VideoInput): readonly string[] {
	const labels = input.scenes.map((_, index) => `[v${index}]`);
	const transition = effectiveTransitionS(input);
	if (labels.length === 1) return [`[v0]null[vout]`];
	if (transition === 0) {
		return [`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vout]`];
	}
	// Join k fades scene k+1 into the stream so far, which is the first k+1 scenes minus k earlier overlaps.
	return labels.slice(1).map((right, step) => {
		const joined = input.scenes
			.slice(0, step + 1)
			.reduce((total, scene) => total + scene.durationS, 0);
		const offset = joined - (step + 1) * transition;
		const left = step === 0 ? '[v0]' : `[x${step}]`;
		const out = step === labels.length - 2 ? '[vout]' : `[x${step + 1}]`;
		return `${left}${right}xfade=transition=fade:duration=${num(transition)}:offset=${num(offset)}${out}`;
	});
}

function audioFilters(input: VideoInput): readonly string[] {
	return mixAudioFilters({
		voiceover: input.voiceover,
		music: input.music,
		musicVolume: input.musicVolume,
		totalS: totalDurationS(input),
		firstAudioInput: input.scenes.length,
	});
}

// Voiceover and music become one loudness-normalised [aout]; empty when there is no audio.
export function mixAudioFilters(params: {
	readonly voiceover?: string;
	readonly music?: string;
	readonly musicVolume: number;
	readonly totalS: number;
	readonly firstAudioInput: number;
}): readonly string[] {
	const total = params.totalS;
	const first = params.firstAudioInput;
	const sources: {readonly path?: string; readonly tail: string}[] = [
		{path: params.voiceover, tail: ''},
		{
			path: params.music,
			tail: `,volume=${num(params.musicVolume)},afade=t=out:st=${num(Math.max(total - MUSIC_FADE_S, 0))}:d=${num(Math.min(MUSIC_FADE_S, total))}`,
		},
	];
	const present = sources.filter(source => source.path !== undefined);
	if (present.length === 0) return [];
	const branches = present.map(
		(source, offset) =>
			`[${first + offset}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${num(total)},asetpts=PTS-STARTPTS,apad=whole_dur=${num(total)}${source.tail}[a${offset}]`,
	);
	const inputs = present.map((_, offset) => `[a${offset}]`).join('');
	return [
		...branches,
		`${inputs}amix=inputs=${present.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`,
	];
}

export function buildFfmpegArgs(
	input: VideoInput,
	outPath: string,
): readonly string[] {
	const sceneInputs = input.scenes.flatMap(scene => [
		'-loop',
		'1',
		'-framerate',
		String(input.fps),
		'-t',
		num(scene.durationS),
		'-i',
		scene.image,
	]);
	const audioPaths = [input.voiceover, input.music].filter(
		(path): path is string => path !== undefined,
	);
	const audioInputs = audioPaths.flatMap(path => ['-i', path]);
	const filters = [
		...input.scenes.map((scene, index) => sceneFilter(index, scene, input)),
		...videoChain(input),
		...audioFilters(input),
	];
	const audioMap = audioPaths.length === 0 ? [] : ['-map', '[aout]'];
	const audioCodec =
		audioPaths.length === 0 ? [] : ['-c:a', 'aac', '-b:a', '192k'];
	return [
		'-y',
		'-hide_banner',
		'-nostats',
		'-loglevel',
		'error',
		...sceneInputs,
		...audioInputs,
		'-filter_complex',
		filters.join(';'),
		'-map',
		'[vout]',
		...audioMap,
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
		...audioCodec,
		'-t',
		num(totalDurationS(input)),
		outPath,
	];
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function firstMissing(input: VideoInput): Promise<string | undefined> {
	const paths = [
		...input.scenes.map(scene => scene.image),
		...[input.voiceover, input.music].filter(
			(path): path is string => path !== undefined,
		),
	];
	const found = await Promise.all(paths.map(exists));
	return paths.find((_, index) => !found[index]);
}

async function checkAvailable(params: {
	readonly exec: Exec;
}): Promise<Availability> {
	const result = await params.exec({command: 'ffmpeg', args: ['-version']});
	if (result.code === 0) return {ok: true};
	return {ok: false, reason: 'ffmpeg is not installed or not on PATH'};
}

// A long compose gets proportionally longer, but never past a cap: a stuck ffmpeg must not hold a job forever.
export function composeTimeoutMs(input: VideoInput): number {
	const scaled =
		COMPOSE_BASE_TIMEOUT_MS + totalDurationS(input) * COMPOSE_TIMEOUT_PER_SECOND_MS;
	return Math.round(Math.min(scaled, COMPOSE_MAX_TIMEOUT_MS));
}

function cancelled(): EngineFailure {
	return engineFailure({code: 'cancelled', message: 'The job was cancelled.', retryable: false});
}

function badInput(path: string, reason: string): EngineFailure {
	return engineFailure({
		code: 'bad_input',
		message: `${path} cannot be used: ${reason}`,
		retryable: false,
	});
}

function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}

async function runTool(params: {
	readonly ctx: EngineRunContext;
	readonly tool: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
}): Promise<ExecResult> {
	const {ctx, tool, args, timeoutMs} = params;
	const result = await ctx.exec({
		command: tool,
		args,
		cwd: ctx.cwd,
		signal: ctx.signal,
		timeoutMs,
	});
	if (ctx.signal.aborted) throw cancelled();
	const environment = environmentFailure({tool, result, timeoutMs});
	if (environment !== undefined) throw environment;
	return result;
}

interface ProbedStream {
	readonly type: string;
	readonly width: number;
	readonly height: number;
}

function asRecord(value: unknown): RawRecord | undefined {
	return isRecord(value) ? value : undefined;
}

function probedStreams(stdout: string): readonly ProbedStream[] {
	try {
		const streams = asRecord(JSON.parse(stdout))?.['streams'];
		if (!Array.isArray(streams)) return [];
		return streams.flatMap((raw): readonly ProbedStream[] => {
			const stream = asRecord(raw);
			if (stream === undefined) return [];
			return [
				{
					type: String(stream['codec_type'] ?? ''),
					width: Number(stream['width'] ?? 0),
					height: Number(stream['height'] ?? 0),
				},
			];
		});
	} catch {
		return [];
	}
}

async function probeStreams(
	ctx: EngineRunContext,
	path: string,
): Promise<readonly ProbedStream[]> {
	const result = await runTool({
		ctx,
		tool: 'ffprobe',
		args: ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', '-i', path],
		timeoutMs: PROBE_TIMEOUT_MS,
	});
	return result.code === 0 ? probedStreams(result.stdout) : [];
}

function sideIsSane(side: number): boolean {
	return Number.isInteger(side) && side >= 1 && side <= MAX_IMAGE_SIDE_PX;
}

// Decoding one frame is what catches a truncated file whose header still reads fine.
async function checkImage(ctx: EngineRunContext, path: string): Promise<void> {
	const frame = (await probeStreams(ctx, path)).find(stream => stream.type === 'video');
	if (frame === undefined) throw badInput(path, 'it is not an image ffmpeg can read');
	if (!sideIsSane(frame.width) || !sideIsSane(frame.height)) {
		throw badInput(path, `its size ${frame.width}x${frame.height} is not valid, the file is corrupt`);
	}
	const decoded = await runTool({
		ctx,
		tool: 'ffmpeg',
		args: ['-nostdin', '-v', 'error', '-i', path, '-frames:v', '1', '-f', 'null', '-'],
		timeoutMs: DECODE_TIMEOUT_MS,
	});
	if (decoded.code === 0) return;
	throw badInput(path, `it does not decode (${firstLine(decoded.stderr)})`);
}

async function checkAudio(ctx: EngineRunContext, path: string): Promise<void> {
	const streams = await probeStreams(ctx, path);
	if (!streams.some(stream => stream.type === 'audio')) {
		throw badInput(path, 'it has no audio stream');
	}
	const decoded = await runTool({
		ctx,
		tool: 'ffmpeg',
		args: ['-nostdin', '-v', 'error', '-i', path, '-vn', '-t', '1', '-f', 'null', '-'],
		timeoutMs: DECODE_TIMEOUT_MS,
	});
	if (decoded.code === 0) return;
	throw badInput(path, `its audio does not decode (${firstLine(decoded.stderr)})`);
}

// ffmpeg can hang for good on a corrupt still, so every input is proven before the compose starts.
async function validateInputs(input: VideoInput, ctx: EngineRunContext): Promise<void> {
	const images = new Set(input.scenes.map(scene => scene.image));
	for (const path of images) await checkImage(ctx, path);
	const audio = new Set(
		[input.voiceover, input.music].filter((path): path is string => path !== undefined),
	);
	for (const path of audio) await checkAudio(ctx, path);
}

async function compose(
	input: VideoInput,
	ctx: EngineRunContext,
	path: string,
): Promise<readonly MediaOutput[]> {
	const result = await runTool({
		ctx,
		tool: 'ffmpeg',
		args: buildFfmpegArgs(input, path),
		timeoutMs: composeTimeoutMs(input),
	});
	if (result.code !== 0) {
		throw engineFailure({
			code: 'compose_failed',
			message: `ffmpeg exited with code ${result.code}: ${stderrTail(result.stderr)}`,
			retryable: true,
		});
	}
	const {size} = await stat(path);
	return [{path, kind: 'video', bytes: size}];
}

export const videoEngine: Engine<VideoInput> = {
	id: 'video',
	kind: 'video',
	paid: false,
	summary:
		'Compose an MP4 from still images (such as design PNGs) with crossfades, slow zoom or pan, optional voiceover and background music.',
	inputSchema: SCHEMA,
	parse: parseVideoInput,
	available: checkAvailable,
	run: async ({input, ctx}): Promise<readonly MediaOutput[]> => {
		const missing = await firstMissing(input);
		if (missing !== undefined) {
			throw engineFailure({
				code: 'missing_input',
				message: `Input file not found: ${missing}`,
				retryable: false,
			});
		}
		const path = join(ctx.outDir, 'video.mp4');
		try {
			await validateInputs(input, ctx);
			return await compose(input, ctx, path);
		} catch (error) {
			await rm(path, {force: true});
			throw error;
		}
	},
};
