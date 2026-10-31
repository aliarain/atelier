import {access, mkdir, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {engineFailure, stderrTail} from '../exec.ts';
import type {
	Availability,
	Engine,
	EngineRunContext,
	Exec,
	JsonObjectSchema,
	MediaOutput,
	Parsed,
} from '../types.ts';
import {withChrome, withTimeout} from './chrome-session.ts';
import type {ChromePage} from './chrome-session.ts';
import {findChrome, wrapHtml} from './design.ts';
import {clockInstallSource, seekExpression} from './motion-clock.ts';
import {startRenderSandbox} from './render-sandbox.ts';
import {mixAudioFilters, num} from './video.ts';

export {cdpRequest, parseCdpMessage} from './chrome-session.ts';
export type {CdpMessage} from './chrome-session.ts';

export interface MotionInput {
	readonly html: string;
	readonly width: number;
	readonly height: number;
	readonly fps: number;
	readonly durationS: number;
	readonly voiceover?: string;
	readonly music?: string;
	readonly musicVolume: number;
}

type RawRecord = Readonly<Record<string, unknown>>;

const MAX_HTML_CHARS = 400_000;
const FPS_CHOICES: readonly number[] = [24, 30];
const LOAD_TIMEOUT_MS = 30_000;
// One frame is a clock seek plus a screenshot; far longer means a hung page.
const FRAME_TIMEOUT_MS = 30_000;
const ENCODE_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE_FILE = 'source.html';
const OUTPUT_FILE = 'motion.mp4';
const FRAMES_DIR = 'frames';
const FRAME_PATTERN = '%05d.png';

const SCHEMA: JsonObjectSchema = {
	type: 'object',
	properties: {
		html: {
			type: 'string',
			description:
				'A full HTML document, or a fragment (wrapped with margin 0), whose CSS animations, transitions, SVG animation or requestAnimationFrame / Web Animations script play from time zero. Self-contained: the page has no network, so https and file assets do not load. Rendered frame by frame on a virtual clock, so playback is exact whatever the machine speed.',
		},
		width: {
			type: 'integer',
			minimum: 160,
			maximum: 2160,
			description: 'Frame width in pixels, even number. Default 1080.',
		},
		height: {
			type: 'integer',
			minimum: 160,
			maximum: 3840,
			description: 'Frame height in pixels, even number. Default 1920.',
		},
		fps: {
			type: 'integer',
			enum: FPS_CHOICES,
			description: 'Frames per second. Default 30.',
		},
		duration_s: {
			type: 'number',
			minimum: 0.5,
			maximum: 30,
			description: 'Length of the clip in seconds. The animation should finish before it ends.',
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
	required: ['html', 'duration_s'],
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
	readonly fallback?: number;
	readonly integer: boolean;
}): Parsed<number> {
	const {source, key, min, max, fallback, integer} = params;
	const value = source[key];
	if (value === undefined && fallback !== undefined) return {ok: true, value: fallback};
	if (value === undefined) return fail(`${key} is required`);
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fail(`${key} must be a number`);
	}
	if (integer && !Number.isInteger(value)) return fail(`${key} must be an integer`);
	if (value < min || value > max) return fail(`${key} must be between ${min} and ${max}`);
	return {ok: true, value};
}

function pathField(source: RawRecord, key: string): Parsed<string | undefined> {
	const value = source[key];
	if (value === undefined) return {ok: true, value: undefined};
	if (typeof value !== 'string' || !isAbsolute(value)) {
		return fail(`${key} must be an absolute path`);
	}
	return {ok: true, value};
}

export function parseMotionInput(raw: unknown): Parsed<MotionInput> {
	if (!isRecord(raw)) return fail('input must be an object');
	const html = raw['html'];
	if (typeof html !== 'string' || html.trim() === '') return fail('html must be a non-empty string');
	if (html.length > MAX_HTML_CHARS) return fail(`html must be at most ${MAX_HTML_CHARS} characters`);
	const width = numberField({source: raw, key: 'width', min: 160, max: 2160, fallback: 1080, integer: true});
	if (!width.ok) return width;
	const height = numberField({source: raw, key: 'height', min: 160, max: 3840, fallback: 1920, integer: true});
	if (!height.ok) return height;
	if (width.value % 2 !== 0 || height.value % 2 !== 0) {
		return fail('width and height must be even numbers');
	}
	const fps = numberField({source: raw, key: 'fps', min: 24, max: 30, fallback: 30, integer: true});
	if (!fps.ok) return fps;
	if (!FPS_CHOICES.includes(fps.value)) return fail('fps must be 24 or 30');
	const duration = numberField({source: raw, key: 'duration_s', min: 0.5, max: 30, integer: false});
	if (!duration.ok) return duration;
	const voiceover = pathField(raw, 'voiceover');
	if (!voiceover.ok) return voiceover;
	const music = pathField(raw, 'music');
	if (!music.ok) return music;
	const volume = numberField({source: raw, key: 'music_volume', min: 0, max: 1, fallback: 0.25, integer: false});
	if (!volume.ok) return volume;
	return {
		ok: true,
		value: {
			html,
			width: width.value,
			height: height.value,
			fps: fps.value,
			durationS: duration.value,
			voiceover: voiceover.value,
			music: music.value,
			musicVolume: volume.value,
		},
	};
}

export function frameCount(input: MotionInput): number {
	return Math.round(input.durationS * input.fps);
}

export function frameFileName(index: number): string {
	return `${String(index).padStart(5, '0')}.png`;
}

// ffmpeg reads the frames by pattern from its working directory, because `%` in an absolute
// project path would be taken for part of the pattern.
export function buildMotionFfmpegArgs(
	input: MotionInput,
	params: {readonly outPath: string},
): readonly string[] {
	const audioPaths = [input.voiceover, input.music].filter(
		(path): path is string => path !== undefined,
	);
	const audio = mixAudioFilters({
		voiceover: input.voiceover,
		music: input.music,
		musicVolume: input.musicVolume,
		totalS: input.durationS,
		firstAudioInput: 1,
	});
	const audioArgs =
		audio.length === 0
			? []
			: ['-filter_complex', audio.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'];
	return [
		'-y',
		'-hide_banner',
		'-nostats',
		'-loglevel',
		'error',
		'-framerate',
		String(input.fps),
		'-i',
		FRAME_PATTERN,
		...audioPaths.flatMap(path => ['-i', path]),
		'-map',
		'0:v',
		...audioArgs,
		'-c:v',
		'libx264',
		'-preset',
		'medium',
		'-crf',
		'18',
		'-pix_fmt',
		'yuv420p',
		'-movflags',
		'+faststart',
		'-t',
		num(input.durationS),
		params.outPath,
	];
}

function screenshotData(result: unknown): string {
	const data = isRecord(result) ? result['data'] : undefined;
	if (typeof data !== 'string') throw Error('Chrome returned no screenshot data');
	return data;
}

function assertNoPageError(evaluated: unknown): void {
	const details = isRecord(evaluated) ? evaluated['exceptionDetails'] : undefined;
	if (!isRecord(details)) return;
	const exception = details['exception'];
	const description = isRecord(exception) ? exception['description'] : undefined;
	throw Error(`The page threw while advancing the clock: ${String(description ?? details['text'])}`);
}

// Each frame is written before the next is captured, so a failed write stops the render at
// once instead of surfacing as an unhandled rejection later.
async function renderFrames(params: {
	readonly page: ChromePage;
	readonly input: MotionInput;
	readonly sourceUrl: string;
	readonly framesDir: string;
}): Promise<void> {
	const {page, input, sourceUrl, framesDir} = params;
	await page.call('Page.addScriptToEvaluateOnNewDocument', {source: clockInstallSource()});
	const loaded = page.next('Page.loadEventFired');
	const navigation = await page.call('Page.navigate', {url: sourceUrl});
	const errorText = isRecord(navigation) ? navigation['errorText'] : undefined;
	if (typeof errorText === 'string') throw Error(`The page did not load: ${errorText}`);
	await withTimeout(loaded, LOAD_TIMEOUT_MS, 'Page load');
	await withTimeout(
		page.call('Runtime.evaluate', {expression: 'document.fonts.ready.then(() => true)', awaitPromise: true}),
		LOAD_TIMEOUT_MS,
		'Font loading',
	);
	for (let index = 0; index < frameCount(input); index += 1) {
		const seek = await withTimeout(
			page.call('Runtime.evaluate', {expression: seekExpression((index * 1000) / input.fps)}),
			FRAME_TIMEOUT_MS,
			`Frame ${index} clock`,
		);
		assertNoPageError(seek);
		const shot = await withTimeout(
			page.call('Page.captureScreenshot', {format: 'png', optimizeForSpeed: true}),
			FRAME_TIMEOUT_MS,
			`Frame ${index} screenshot`,
		);
		await writeFile(join(framesDir, frameFileName(index)), Buffer.from(screenshotData(shot), 'base64'));
	}
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function firstMissing(input: MotionInput): Promise<string | undefined> {
	const paths = [input.voiceover, input.music].filter(
		(path): path is string => path !== undefined,
	);
	const found = await Promise.all(paths.map(exists));
	return paths.find((_, index) => !found[index]);
}

async function renderWithChrome(params: {
	readonly chrome: string;
	readonly input: MotionInput;
	readonly ctx: EngineRunContext;
	readonly framesDir: string;
}): Promise<void> {
	const {chrome, input, ctx, framesDir} = params;
	const source = wrapHtml(input.html);
	await writeFile(join(ctx.outDir, SOURCE_FILE), source);
	await mkdir(framesDir, {recursive: true});
	const sandbox = await startRenderSandbox({cwd: ctx.cwd, documents: {[SOURCE_FILE]: source}});
	try {
		await withChrome(
			{chrome, sandbox, width: input.width, height: input.height, signal: ctx.signal},
			async session => {
				const page = await session.openPage({width: input.width, height: input.height, scale: 1});
				await renderFrames({page, input, sourceUrl: sandbox.url(SOURCE_FILE), framesDir});
			},
		);
	} finally {
		await sandbox.close();
	}
}

async function checkAvailable(params: {
	readonly exec: Exec;
	readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<Availability> {
	if ((await findChrome(params.env)) === undefined) {
		return {
			ok: false,
			reason:
				'Chrome, Edge or Chromium was not found. Install Chrome or set ATELIER_CHROME to a browser binary.',
		};
	}
	const ffmpeg = await params.exec({command: 'ffmpeg', args: ['-version']});
	if (ffmpeg.code !== 0) return {ok: false, reason: 'ffmpeg is not installed or not on PATH'};
	return {ok: true};
}

export const motionEngine: Engine<MotionInput> = {
	id: 'motion',
	kind: 'video',
	paid: false,
	summary:
		'Render animated HTML (CSS keyframes, SVG, Web Animations or requestAnimationFrame) to an MP4, frame by frame on a virtual clock. Use for kinetic typography, animated titles, logo reveals, animated charts and lower thirds. Free, local, optional voiceover and music.',
	inputSchema: SCHEMA,
	parse: parseMotionInput,
	available: checkAvailable,
	run: async ({input, ctx}): Promise<readonly MediaOutput[]> => {
		const chrome = await findChrome(ctx.env);
		if (chrome === undefined) {
			throw engineFailure({
				code: 'chrome_missing',
				message: 'No Chrome, Edge or Chromium found. Set ATELIER_CHROME.',
				retryable: false,
			});
		}
		const missing = await firstMissing(input);
		if (missing !== undefined) {
			throw engineFailure({
				code: 'missing_input',
				message: `Input file not found: ${missing}`,
				retryable: false,
			});
		}
		const framesDir = join(ctx.outDir, FRAMES_DIR);
		const outPath = join(ctx.outDir, OUTPUT_FILE);
		try {
			await renderWithChrome({chrome, input, ctx, framesDir}).catch((error: unknown) => {
				// A cancelled run reports as cancelled, whatever Chrome said while it was killed.
				ctx.signal.throwIfAborted();
				throw engineFailure({
					code: 'render_failed',
					message: `Chrome could not render the animation: ${error instanceof Error ? error.message : String(error)}`,
					retryable: true,
				});
			});
			const result = await ctx.exec({
				command: 'ffmpeg',
				args: buildMotionFfmpegArgs(input, {outPath}),
				cwd: framesDir,
				signal: ctx.signal,
				timeoutMs: ENCODE_TIMEOUT_MS,
			});
			if (result.code !== 0) {
				throw engineFailure({
					code: 'encode_failed',
					message: `ffmpeg exited with code ${result.code}: ${stderrTail(result.stderr)}`,
					retryable: true,
				});
			}
		} finally {
			// Failing to clean up must not hide why the render failed.
			await rm(framesDir, {recursive: true, force: true}).catch(() => undefined);
		}
		const {size} = await stat(outPath);
		return [{path: outPath, kind: 'video', bytes: size}];
	},
};
