import {constants} from 'node:fs';
import {access, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {engineFailure, stderrTail} from '../exec.ts';
import type {
	Availability,
	Engine,
	Env,
	MediaOutput,
	Parsed,
} from '../types.ts';

const MAX_HTML_CHARS = 400_000;
const MIN_SIDE = 64;
const MAX_SIDE = 4096;
const RENDER_TIMEOUT_MS = 60_000;

export interface DesignInput {
	readonly html: string;
	readonly width: number;
	readonly height: number;
	readonly scale: 1 | 2;
}

type RawInput = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RawInput {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSide(
	raw: RawInput,
	key: 'width' | 'height',
	fallback: number,
): Parsed<number> {
	const value = raw[key] ?? fallback;
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < MIN_SIDE ||
		value > MAX_SIDE
	) {
		return {
			ok: false,
			error: `${key} must be an integer from ${MIN_SIDE} to ${MAX_SIDE}`,
		};
	}
	return {ok: true, value};
}

export function parseDesignInput(raw: unknown): Parsed<DesignInput> {
	if (!isRecord(raw)) return {ok: false, error: 'input must be an object'};

	const html = raw.html;
	if (typeof html !== 'string' || html.trim() === '') {
		return {ok: false, error: 'html is required and must be a non-empty string'};
	}
	if (html.length > MAX_HTML_CHARS) {
		return {ok: false, error: `html must be at most ${MAX_HTML_CHARS} characters`};
	}

	const width = readSide(raw, 'width', 1080);
	if (!width.ok) return width;
	const height = readSide(raw, 'height', 1350);
	if (!height.ok) return height;

	const scale = raw.scale ?? 1;
	if (scale !== 1 && scale !== 2) {
		return {ok: false, error: 'scale must be 1 or 2'};
	}

	return {
		ok: true,
		value: {html, width: width.value, height: height.value, scale},
	};
}

const DOCUMENT_START = /^\s*(<!doctype\s|<html[\s>])/i;

// A fragment gets a zero-margin page so the screenshot is exactly the model's artboard.
export function wrapHtml(html: string): string {
	if (DOCUMENT_START.test(html)) return html;
	return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>${html}</body></html>`;
}

export function chromeCandidates(env: Env): readonly string[] {
	const fromEnv = env.STUDIO_CHROME;
	const installed = [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
	];
	if (fromEnv === undefined || fromEnv === '') return installed;
	return [fromEnv, ...installed];
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findChrome(env: Env): Promise<string | undefined> {
	for (const candidate of chromeCandidates(env)) {
		if (await isExecutable(candidate)) return candidate;
	}
	return undefined;
}

async function fileBytes(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
}

export function chromeArgs(params: {
	readonly profileDir: string;
	readonly pngPath: string;
	readonly sourceUrl: string;
	readonly width: number;
	readonly height: number;
	readonly scale: number;
}): readonly string[] {
	return [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--no-first-run',
		'--no-default-browser-check',
		'--allow-file-access-from-files',
		`--user-data-dir=${params.profileDir}`,
		`--force-device-scale-factor=${params.scale}`,
		`--window-size=${params.width},${params.height}`,
		'--virtual-time-budget=3000',
		`--screenshot=${params.pngPath}`,
		params.sourceUrl,
	];
}

export const designEngine: Engine<DesignInput> = {
	id: 'design',
	kind: 'image',
	paid: false,
	summary:
		'Render a designed image (poster, social card, slide, diagram) from HTML/CSS/SVG you write, to PNG. Free, local, exact pixels.',
	inputSchema: {
		type: 'object',
		properties: {
			html: {
				type: 'string',
				description:
					'A full HTML document, or an HTML/SVG fragment (wrapped with margin 0). Self-contained: inline CSS, inline SVG, data: URIs or https assets.',
			},
			width: {
				type: 'integer',
				minimum: MIN_SIDE,
				maximum: MAX_SIDE,
				description: 'Canvas width in CSS pixels. Default 1080.',
			},
			height: {
				type: 'integer',
				minimum: MIN_SIDE,
				maximum: MAX_SIDE,
				description: 'Canvas height in CSS pixels. Default 1350.',
			},
			scale: {
				type: 'integer',
				enum: [1, 2],
				description: 'Device pixel ratio. 2 doubles the output resolution. Default 1.',
			},
		},
		required: ['html'],
	},
	parse: parseDesignInput,
	available: async ({env}): Promise<Availability> =>
		(await findChrome(env)) === undefined
			? {
					ok: false,
					reason:
						'Chrome, Edge or Chromium was not found. Install Chrome or set STUDIO_CHROME to a browser binary.',
				}
			: {ok: true},
	run: async ({input, ctx}): Promise<readonly MediaOutput[]> => {
		const chrome = await findChrome(ctx.env);
		if (chrome === undefined) {
			throw engineFailure({
				code: 'chrome_missing',
				message: 'No Chrome, Edge or Chromium found. Set STUDIO_CHROME.',
				retryable: false,
			});
		}

		const sourcePath = join(ctx.outDir, 'source.html');
		const pngPath = join(ctx.outDir, 'design.png');
		const profileDir = join(ctx.outDir, '.chrome-profile');
		await writeFile(sourcePath, wrapHtml(input.html));

		const result = await ctx.exec({
			command: chrome,
			args: chromeArgs({
				profileDir,
				pngPath,
				sourceUrl: pathToFileURL(sourcePath).href,
				width: input.width,
				height: input.height,
				scale: input.scale,
			}),
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeoutMs: RENDER_TIMEOUT_MS,
		});
		await rm(profileDir, {recursive: true, force: true});

		const bytes = result.code === 0 ? await fileBytes(pngPath) : undefined;
		if (bytes === undefined || bytes === 0) {
			throw engineFailure({
				code: 'render_failed',
				message: `Chrome exited with code ${result.code} and wrote no PNG.\n${stderrTail(result.stderr)}`,
				retryable: true,
			});
		}
		return [{path: pngPath, kind: 'image', bytes}];
	},
};
