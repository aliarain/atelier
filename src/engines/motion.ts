import {spawn} from 'node:child_process';
import {access, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
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
import {findChrome, wrapHtml} from './design.ts';
import {clockInstallSource, seekExpression} from './motion-clock.ts';
import {mixAudioFilters, num} from './video.ts';

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
const PORT_FILE_TIMEOUT_MS = 10_000;
const PORT_FILE_POLL_MS = 50;
const LOAD_TIMEOUT_MS = 30_000;
// One frame is a clock seek plus a screenshot; far longer means a hung page.
const FRAME_TIMEOUT_MS = 30_000;
const ENCODE_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE_FILE = 'source.html';
const OUTPUT_FILE = 'motion.mp4';
const PROFILE_DIR = '.chrome-motion';
const FRAMES_DIR = 'frames';

const SCHEMA: JsonObjectSchema = {
	type: 'object',
	properties: {
		html: {
			type: 'string',
			description:
				'A full HTML document, or a fragment (wrapped with margin 0), whose CSS animations, transitions, SVG animation or requestAnimationFrame / Web Animations script play from time zero. Self-contained. Rendered frame by frame on a virtual clock, so playback is exact whatever the machine speed.',
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

export function chromeMotionArgs(params: {
	readonly profileDir: string;
	readonly width: number;
	readonly height: number;
}): readonly string[] {
	return [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--no-first-run',
		'--no-default-browser-check',
		'--allow-file-access-from-files',
		'--mute-audio',
		`--user-data-dir=${params.profileDir}`,
		'--remote-debugging-port=0',
		`--window-size=${params.width},${params.height}`,
		'about:blank',
	];
}

export function buildMotionFfmpegArgs(
	input: MotionInput,
	params: {readonly framesDir: string; readonly outPath: string},
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
		join(params.framesDir, '%05d.png'),
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

export function cdpRequest(
	id: number,
	method: string,
	params: Readonly<Record<string, unknown>> = {},
): string {
	return JSON.stringify({id, method, params});
}

export type CdpMessage =
	| {readonly kind: 'result'; readonly id: number; readonly result: unknown}
	| {readonly kind: 'error'; readonly id: number; readonly message: string}
	| {readonly kind: 'event'; readonly method: string; readonly params: unknown};

export function parseCdpMessage(text: string): CdpMessage | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(raw)) return undefined;
	const id = raw['id'];
	const error = raw['error'];
	if (typeof id === 'number' && isRecord(error)) {
		return {kind: 'error', id, message: String(error['message'] ?? 'unknown error')};
	}
	if (typeof id === 'number') return {kind: 'result', id, result: raw['result']};
	const method = raw['method'];
	if (typeof method === 'string') return {kind: 'event', method, params: raw['params']};
	return undefined;
}

interface Settler {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
}

interface Cdp {
	readonly call: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<unknown>;
	// Register before the call that triggers the event, or a fast event is missed.
	readonly next: (event: string) => Promise<unknown>;
	readonly close: () => void;
}

function connectCdp(url: string): Promise<Cdp> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const pending = new Map<number, Settler>();
		const waiters = new Map<string, Settler[]>();
		let lastId = 0;
		let closed: Error | undefined;

		const failAll = (error: Error): void => {
			closed = error;
			for (const settler of pending.values()) settler.reject(error);
			for (const list of waiters.values()) {
				for (const settler of list) settler.reject(error);
			}
			pending.clear();
			waiters.clear();
		};

		socket.addEventListener('message', event => {
			const message = parseCdpMessage(String(event.data));
			if (message === undefined) return;
			if (message.kind === 'event') {
				const list = waiters.get(message.method) ?? [];
				waiters.delete(message.method);
				for (const settler of list) settler.resolve(message.params);
				return;
			}
			const settler = pending.get(message.id);
			pending.delete(message.id);
			if (settler === undefined) return;
			if (message.kind === 'error') settler.reject(Error(message.message));
			else settler.resolve(message.result);
		});
		socket.addEventListener('close', () => failAll(Error('Chrome closed the DevTools connection')));
		socket.addEventListener('error', () => {
			const error = Error('DevTools connection failed');
			failAll(error);
			reject(error);
		});
		socket.addEventListener('open', () => {
			resolve({
				call: (method, params) =>
					new Promise((done, failed) => {
						if (closed !== undefined) return failed(closed);
						lastId += 1;
						pending.set(lastId, {resolve: done, reject: failed});
						socket.send(cdpRequest(lastId, method, params));
					}),
				next: event =>
					new Promise((done, failed) => {
						if (closed !== undefined) return failed(closed);
						waiters.set(event, [...(waiters.get(event) ?? []), {resolve: done, reject: failed}]);
					}),
				close: () => socket.close(),
			});
		});
	});
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const timer = AbortSignal.timeout(ms);
	const timedOut = new Promise<never>((_, reject) => {
		timer.addEventListener('abort', () => reject(Error(`${label} timed out after ${ms} ms`)), {
			once: true,
		});
	});
	return Promise.race([promise, timedOut]);
}

interface ChromeProcess {
	readonly port: number;
	readonly stop: () => Promise<void>;
}

async function readPort(portFile: string, exited: Promise<string>): Promise<number> {
	const deadline = Date.now() + PORT_FILE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const text = await readFile(portFile, 'utf8').catch(() => '');
		const port = Number(text.split('\n')[0]);
		if (Number.isInteger(port) && port > 0) return port;
		const early = await Promise.race([exited, sleep(PORT_FILE_POLL_MS).then(() => undefined)]);
		if (early !== undefined) throw Error(`Chrome exited before it opened DevTools.\n${early}`);
	}
	throw Error('Chrome did not open its DevTools port within 10 seconds');
}

// Chrome forks helpers into its own process group (detached makes it a leader), so one group
// kill ends the browser and every renderer; killing only the lead pid leaves orphans.
async function launchChrome(params: {
	readonly chrome: string;
	readonly profileDir: string;
	readonly width: number;
	readonly height: number;
	readonly signal: AbortSignal;
}): Promise<ChromeProcess> {
	const {chrome, profileDir, width, height, signal} = params;
	const child = spawn(chrome, [...chromeMotionArgs({profileDir, width, height})], {
		detached: true,
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', chunk => {
		stderr = (stderr + String(chunk)).slice(-4000);
	});
	const exited = new Promise<string>(resolve => {
		child.once('exit', () => resolve(stderrTail(stderr)));
		child.once('error', error => resolve(error.message));
	});
	const kill = (): void => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
		} catch {
			// the group is already gone
		}
	};
	const stop = async (): Promise<void> => {
		signal.removeEventListener('abort', kill);
		kill();
		await exited;
		await rm(profileDir, {recursive: true, force: true});
	};
	signal.addEventListener('abort', kill, {once: true});
	try {
		const port = await readPort(join(profileDir, 'DevToolsActivePort'), exited);
		return {port, stop};
	} catch (error) {
		await stop();
		throw error;
	}
}

async function pageSocketUrl(port: number): Promise<string> {
	const base = `http://127.0.0.1:${port}`;
	const listed: unknown = await fetch(`${base}/json/list`).then(response => response.json());
	const pages = Array.isArray(listed) ? listed.filter(isRecord) : [];
	const existing = pages.find(target => target['type'] === 'page');
	const target =
		existing ??
		(await fetch(`${base}/json/new?about:blank`, {method: 'PUT'}).then(response => response.json()));
	const url = isRecord(target) ? target['webSocketDebuggerUrl'] : undefined;
	if (typeof url !== 'string') throw Error('Chrome reported no page target');
	return url;
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

async function renderFrames(params: {
	readonly cdp: Cdp;
	readonly input: MotionInput;
	readonly sourceUrl: string;
	readonly framesDir: string;
}): Promise<void> {
	const {cdp, input, sourceUrl, framesDir} = params;
	await cdp.call('Page.enable');
	await cdp.call('Emulation.setDeviceMetricsOverride', {
		width: input.width,
		height: input.height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await cdp.call('Page.addScriptToEvaluateOnNewDocument', {source: clockInstallSource()});
	const loaded = cdp.next('Page.loadEventFired');
	await cdp.call('Page.navigate', {url: sourceUrl});
	await withTimeout(loaded, LOAD_TIMEOUT_MS, 'Page load');
	await withTimeout(
		cdp.call('Runtime.evaluate', {expression: 'document.fonts.ready.then(() => true)', awaitPromise: true}),
		LOAD_TIMEOUT_MS,
		'Font loading',
	);
	const writes: Promise<void>[] = [];
	for (let index = 0; index < frameCount(input); index += 1) {
		const seek = await withTimeout(
			cdp.call('Runtime.evaluate', {expression: seekExpression((index * 1000) / input.fps)}),
			FRAME_TIMEOUT_MS,
			`Frame ${index} clock`,
		);
		assertNoPageError(seek);
		const shot = await withTimeout(
			cdp.call('Page.captureScreenshot', {format: 'png', optimizeForSpeed: true}),
			FRAME_TIMEOUT_MS,
			`Frame ${index} screenshot`,
		);
		writes.push(writeFile(join(framesDir, frameFileName(index)), Buffer.from(screenshotData(shot), 'base64')));
	}
	await Promise.all(writes);
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
	const sourcePath = join(ctx.outDir, SOURCE_FILE);
	await writeFile(sourcePath, wrapHtml(input.html));
	await mkdir(framesDir, {recursive: true});
	const browser = await launchChrome({
		chrome,
		profileDir: join(ctx.outDir, PROFILE_DIR),
		width: input.width,
		height: input.height,
		signal: ctx.signal,
	});
	try {
		const cdp = await connectCdp(await pageSocketUrl(browser.port));
		try {
			await renderFrames({cdp, input, sourceUrl: pathToFileURL(sourcePath).href, framesDir});
		} finally {
			cdp.close();
		}
	} finally {
		await browser.stop();
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
				'Chrome, Edge or Chromium was not found. Install Chrome or set STUDIO_CHROME to a browser binary.',
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
				message: 'No Chrome, Edge or Chromium found. Set STUDIO_CHROME.',
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
				throw engineFailure({
					code: 'render_failed',
					message: `Chrome could not render the animation: ${error instanceof Error ? error.message : String(error)}`,
					retryable: true,
				});
			});
			const result = await ctx.exec({
				command: 'ffmpeg',
				args: buildMotionFfmpegArgs(input, {framesDir, outPath}),
				cwd: ctx.cwd,
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
			await rm(framesDir, {recursive: true, force: true});
		}
		const {size} = await stat(outPath);
		return [{path: outPath, kind: 'video', bytes: size}];
	},
};
