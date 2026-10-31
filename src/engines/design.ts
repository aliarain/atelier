import {constants} from 'node:fs';
import {access, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {engineFailure, isEngineFailure} from '../exec.ts';
import type {
	Availability,
	Engine,
	EngineRunContext,
	Env,
	MediaOutput,
	Parsed,
} from '../types.ts';
import {withChrome, withTimeout} from './chrome-session.ts';
import type {ChromeSession} from './chrome-session.ts';
import {clockInstallSource, settleExpression} from './motion-clock.ts';
import {startRenderSandbox} from './render-sandbox.ts';
import type {RenderSandbox} from './render-sandbox.ts';

const MAX_HTML_CHARS = 400_000;
const MIN_SIDE = 64;
const MAX_SIDE = 4096;
const LOAD_TIMEOUT_MS = 30_000;
// Timers and animations in the first three seconds have played out before the shot, as they
// did under Chrome's virtual time budget.
const SETTLE_MS = 3000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
	const fromEnv = env.ATELIER_CHROME;
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

export async function findChrome(env: Env): Promise<string | undefined> {
	for (const candidate of chromeCandidates(env)) {
		if (await isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export interface LayoutRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

// One text-bearing element as measured in the page. `ancestors` holds the ids of the
// text-bearing elements that contain it, so the classifier can skip parent/child pairs.
export interface LayoutBox {
	readonly id: number;
	readonly ancestors: readonly number[];
	readonly text: string;
	readonly rect: LayoutRect;
	// Each line trimmed to a one-em band around its middle. A font's content box (what `rect`
	// holds) reaches well past the letters, so tight display leading would read as overlap.
	readonly ink?: LayoutRect;
	readonly clipped: boolean;
	readonly decoration: boolean;
}

export type LayoutIssueKind =
	| 'clipped_text'
	| 'off_canvas'
	| 'overlap'
	| 'safe_area'
	| 'tight_edge';

export interface LayoutIssue {
	readonly kind: LayoutIssueKind;
	readonly text: string;
	readonly rect: LayoutRect;
}

export interface LayoutReport {
	readonly issues: readonly LayoutIssue[];
	readonly checked: number;
}

const MAX_LAYOUT_ISSUES = 20;
const TEXT_PREVIEW_CHARS = 40;
const OFF_CANVAS_SLACK_PX = 2;
const OVERLAP_RATIO = 0.25;
const TALL_FRAME_RATIO = 1.7;
const SAFE_TOP_RATIO = 0.12;
const SAFE_BOTTOM_RATIO = 0.18;
const TIGHT_EDGE_RATIO = 0.03;
const QA_TIMEOUT_MS = 15_000;
const QA_POLL_MS = 25;

function layoutIssue(
	kind: LayoutIssueKind,
	box: LayoutBox,
	rect: LayoutRect = box.rect,
): LayoutIssue {
	return {
		kind,
		text: box.text.slice(0, TEXT_PREVIEW_CHARS),
		rect: {
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			w: Math.round(rect.w),
			h: Math.round(rect.h),
		},
	};
}

function intersection(a: LayoutRect, b: LayoutRect): LayoutRect | undefined {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.w, b.x + b.w);
	const bottom = Math.min(a.y + a.h, b.y + b.h);
	if (right <= x || bottom <= y) return undefined;
	return {x, y, w: right - x, h: bottom - y};
}

function overlapIssue(a: LayoutBox, b: LayoutBox): LayoutIssue | undefined {
	if (a.decoration || b.decoration) return undefined;
	if (a.ancestors.includes(b.id) || b.ancestors.includes(a.id)) return undefined;
	const inkA = a.ink ?? a.rect;
	const inkB = b.ink ?? b.rect;
	const shared = intersection(inkA, inkB);
	if (shared === undefined) return undefined;
	const smaller = Math.min(inkA.w * inkA.h, inkB.w * inkB.h);
	if (shared.w * shared.h <= smaller * OVERLAP_RATIO) return undefined;
	return layoutIssue('overlap', a, shared);
}

function isIssue(value: LayoutIssue | undefined): value is LayoutIssue {
	return value !== undefined;
}

function pairIssues(a: LayoutBox, rest: readonly LayoutBox[]): readonly LayoutIssue[] {
	return rest.map(b => overlapIssue(a, b)).filter(isIssue);
}

function boxIssues(
	box: LayoutBox,
	width: number,
	height: number,
): readonly LayoutIssue[] {
	const {x, y, w, h} = box.rect;
	const offCanvas =
		x < -OFF_CANVAS_SLACK_PX ||
		y < -OFF_CANVAS_SLACK_PX ||
		x + w > width + OFF_CANVAS_SLACK_PX ||
		y + h > height + OFF_CANVAS_SLACK_PX;
	const margin = Math.min(width, height) * TIGHT_EDGE_RATIO;
	const nearEdge =
		x < margin ||
		y < margin ||
		width - (x + w) < margin ||
		height - (y + h) < margin;
	const inSafeArea =
		height / width >= TALL_FRAME_RATIO &&
		(y < height * SAFE_TOP_RATIO || y + h > height * (1 - SAFE_BOTTOM_RATIO));

	const checks: readonly (readonly [LayoutIssueKind, boolean])[] = [
		['clipped_text', box.clipped],
		['off_canvas', offCanvas],
		['safe_area', inSafeArea],
		['tight_edge', nearEdge && !offCanvas],
	];
	return checks
		.filter(([, hit]) => hit)
		.map(([kind]) => layoutIssue(kind, box));
}

export function classifyLayout(params: {
	readonly width: number;
	readonly height: number;
	readonly boxes: readonly LayoutBox[];
}): LayoutReport {
	const boxes = params.boxes.filter(box => box.rect.w > 0 && box.rect.h > 0);
	const issues = [
		...boxes.flatMap(box => boxIssues(box, params.width, params.height)),
		...boxes.flatMap((box, index) => pairIssues(box, boxes.slice(index + 1))),
	];
	return {issues: issues.slice(0, MAX_LAYOUT_ISSUES), checked: boxes.length};
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isLayoutRect(value: unknown): value is LayoutRect {
	return (
		isRecord(value) &&
		isNumber(value.x) &&
		isNumber(value.y) &&
		isNumber(value.w) &&
		isNumber(value.h)
	);
}

function isLayoutBox(value: unknown): value is LayoutBox {
	return (
		isRecord(value) &&
		isNumber(value.id) &&
		Array.isArray(value.ancestors) &&
		value.ancestors.every(isNumber) &&
		typeof value.text === 'string' &&
		isLayoutRect(value.rect) &&
		(value.ink === undefined || isLayoutRect(value.ink)) &&
		typeof value.clipped === 'boolean' &&
		typeof value.decoration === 'boolean'
	);
}

const LAYOUT_ELEMENT =
	/<script[^>]*id="atelier-layout"[^>]*>([\s\S]*?)<\/script>/;

// Reads the measurement the injected script left in the dumped DOM.
export function parseLayoutDom(dom: string): readonly LayoutBox[] | undefined {
	const json = LAYOUT_ELEMENT.exec(dom)?.[1];
	if (json === undefined) return undefined;
	try {
		const raw: unknown = JSON.parse(json);
		if (!isRecord(raw) || !Array.isArray(raw.boxes)) return undefined;
		return raw.boxes.every(isLayoutBox) ? raw.boxes : undefined;
	} catch {
		return undefined;
	}
}

// Measures text boxes only; every judgement lives in classifyLayout. `<` is escaped in the
// JSON so page text containing a closing script tag cannot end the element early.
const MEASURE_SCRIPT = String.raw`(function () {
  var frame = document.getElementById("atelier-frame");
  var d, w;
  var SKIP = {SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TITLE: 1, TEMPLATE: 1};
  var CLIP = /^(hidden|clip)$/;
  var ids = new Map();
  var boxes = [];
  function isHidden(el) {
    if (w.getComputedStyle(el).visibility === "hidden") return true;
    for (var n = el; n; n = n.parentElement) {
      var s = w.getComputedStyle(n);
      if (s.display === "none" || parseFloat(s.opacity) === 0) return true;
    }
    return false;
  }
  function ownText(el) {
    var t = "";
    el.childNodes.forEach(function (c) {
      if (c.nodeType === 3) t += c.nodeValue + " ";
    });
    return t.replace(/\s+/g, " ").trim();
  }
  function textRect(el, fontSize, ink) {
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    var range = d.createRange();
    el.childNodes.forEach(function (c) {
      if (c.nodeType !== 3 || !c.nodeValue.trim()) return;
      range.selectNodeContents(c);
      Array.prototype.forEach.call(range.getClientRects(), function (q) {
        if (q.width <= 0 || q.height <= 0) return;
        var inset = ink ? Math.max(0, (q.height - fontSize) / 2) : 0;
        l = Math.min(l, q.left); t = Math.min(t, q.top + inset);
        r = Math.max(r, q.right); b = Math.max(b, q.bottom - inset);
      });
    });
    return r > l && b > t ? {x: l, y: t, w: r - l, h: b - t} : null;
  }
  function isClipped(el, rc) {
    for (var n = el; n && n !== d.body && n !== d.documentElement; n = n.parentElement) {
      var s = w.getComputedStyle(n);
      var cx = CLIP.test(s.overflowX), cy = CLIP.test(s.overflowY);
      if (!cx && !cy) continue;
      var cr = n.getBoundingClientRect();
      var x0 = cr.left + n.clientLeft, y0 = cr.top + n.clientTop;
      if (cx && n.scrollWidth > n.clientWidth + 1 && (rc.x < x0 - 1 || rc.x + rc.w > x0 + n.clientWidth + 1)) return true;
      if (cy && n.scrollHeight > n.clientHeight + 1 && (rc.y < y0 - 1 || rc.y + rc.h > y0 + n.clientHeight + 1)) return true;
    }
    return false;
  }
  function measure() {
    d.querySelectorAll("body, body *").forEach(function (el) {
      if (SKIP[el.nodeName.toUpperCase()]) return;
      var text = ownText(el);
      if (!text || isHidden(el)) return;
      var s = w.getComputedStyle(el);
      var fontSize = parseFloat(s.fontSize) || 16;
      var rc = textRect(el, fontSize, false);
      if (!rc) return;
      var ancestors = [];
      for (var p = el.parentElement; p; p = p.parentElement) {
        if (ids.has(p)) ancestors.push(ids.get(p));
      }
      var id = boxes.length;
      ids.set(el, id);
      boxes.push({
        id: id,
        ancestors: ancestors,
        text: text.slice(0, 40),
        rect: rc,
        ink: textRect(el, fontSize, true) || rc,
        clipped: isClipped(el, rc),
        decoration: s.position === "absolute" && parseFloat(s.opacity) < 0.35
      });
    });
    emit(boxes);
  }
  function emit(result) {
    var out = document.createElement("script");
    out.type = "application/json";
    out.id = "atelier-layout";
    out.textContent = JSON.stringify({boxes: result}).replace(/</g, "\\u003c");
    document.body.appendChild(out);
  }
  function run() {
    try { measure(); } catch (e) { emit(null); }
  }
  frame.addEventListener("load", function () {
    d = frame.contentDocument;
    w = frame.contentWindow;
    var ready = d.fonts && d.fonts.ready ? d.fonts.ready : Promise.resolve();
    ready.then(function () { setTimeout(run, 0); });
  });
})();`;

const SOURCE_FILE = 'source.html';
const QA_FILE = 'qa.html';

// The page is laid out inside an iframe of the exact canvas size, so vw, vh and percentages
// stay true whatever the window around it.
export function qaDocument(params: {
	readonly width: number;
	readonly height: number;
}): string {
	const frame = `<iframe id="atelier-frame" src="${SOURCE_FILE}" style="display:block;border:0;width:${params.width}px;height:${params.height}px"></iframe>`;
	return `<!doctype html><html><body style="margin:0">${frame}<script>${MEASURE_SCRIPT}</script></body></html>`;
}

const LAYOUT_PROBE =
	"document.getElementById('atelier-layout')?.outerHTML ?? ''";

function evaluatedString(result: unknown): string {
	const inner = isRecord(result) ? result['result'] : undefined;
	const value = isRecord(inner) ? inner['value'] : undefined;
	return typeof value === 'string' ? value : '';
}

// Waits for the injected script to leave its measurement in the page.
async function readLayoutDom(params: {
	readonly session: ChromeSession;
	readonly sandbox: RenderSandbox;
	readonly input: DesignInput;
	readonly signal: AbortSignal;
}): Promise<string> {
	const {session, sandbox, input, signal} = params;
	const page = await session.openPage({
		width: input.width,
		height: input.height,
		scale: 1,
	});
	try {
		await page.call('Page.navigate', {url: sandbox.url(QA_FILE)});
		const deadline = Date.now() + QA_TIMEOUT_MS;
		while (Date.now() < deadline) {
			signal.throwIfAborted();
			const dom = evaluatedString(
				await page.call('Runtime.evaluate', {expression: LAYOUT_PROBE}),
			);
			if (dom !== '') return dom;
			await sleep(QA_POLL_MS);
		}
		throw Error('The layout check did not finish');
	} finally {
		await page.close();
	}
}

// A second page over the same document. It is advice for the model, so any failure here
// leaves the render untouched and just yields no layout.json. An abort is not a failure: the
// caller checks the signal once this returns.
async function writeLayoutReport(params: {
	readonly session: ChromeSession;
	readonly sandbox: RenderSandbox;
	readonly input: DesignInput;
	readonly ctx: EngineRunContext;
}): Promise<void> {
	const {session, sandbox, input, ctx} = params;
	try {
		const boxes = parseLayoutDom(
			await readLayoutDom({session, sandbox, input, signal: ctx.signal}),
		);
		if (boxes === undefined) return;
		const report = classifyLayout({
			width: input.width,
			height: input.height,
			boxes,
		});
		await writeFile(join(ctx.outDir, 'layout.json'), JSON.stringify(report));
	} catch {
		return;
	}
}

export function readPngSize(
	png: Buffer,
): {readonly width: number; readonly height: number} | undefined {
	if (png.length < 24) return undefined;
	if (PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) return undefined;
	if (png.toString('latin1', 12, 16) !== 'IHDR') return undefined;
	return {width: png.readUInt32BE(16), height: png.readUInt32BE(20)};
}

function screenshotData(result: unknown): string {
	const data = isRecord(result) ? result['data'] : undefined;
	if (typeof data !== 'string') throw Error('Chrome returned no screenshot data');
	return data;
}

async function captureDesign(params: {
	readonly session: ChromeSession;
	readonly sandbox: RenderSandbox;
	readonly input: DesignInput;
}): Promise<Buffer> {
	const {session, sandbox, input} = params;
	const page = await session.openPage({
		width: input.width,
		height: input.height,
		scale: input.scale,
	});
	try {
		await page.call('Page.addScriptToEvaluateOnNewDocument', {
			source: clockInstallSource(),
		});
		const loaded = page.next('Page.loadEventFired');
		const navigation = await page.call('Page.navigate', {
			url: sandbox.url(SOURCE_FILE),
		});
		const errorText = isRecord(navigation) ? navigation['errorText'] : undefined;
		if (typeof errorText === 'string') throw Error(`The page did not load: ${errorText}`);
		await withTimeout(loaded, LOAD_TIMEOUT_MS, 'Page load');
		await withTimeout(
			page.call('Runtime.evaluate', {
				expression: 'document.fonts.ready.then(() => true)',
				awaitPromise: true,
			}),
			LOAD_TIMEOUT_MS,
			'Font loading',
		);
		await page.call('Runtime.evaluate', {expression: settleExpression(SETTLE_MS)});
		const shot = await withTimeout(
			page.call('Page.captureScreenshot', {format: 'png'}),
			LOAD_TIMEOUT_MS,
			'Screenshot',
		);
		return Buffer.from(screenshotData(shot), 'base64');
	} finally {
		await page.close();
	}
}

// What Chrome produced is checked, not how Chrome exited: it is killed once the shot is taken.
function assertExpectedPng(png: Buffer, input: DesignInput): void {
	const size = readPngSize(png);
	const width = input.width * input.scale;
	const height = input.height * input.scale;
	if (size?.width === width && size.height === height) return;
	throw Error(
		size === undefined
			? 'Chrome returned data that is not a PNG'
			: `Chrome returned a ${size.width}x${size.height} PNG, expected ${width}x${height}`,
	);
}

async function renderDesign(params: {
	readonly chrome: string;
	readonly input: DesignInput;
	readonly ctx: EngineRunContext;
	readonly pngPath: string;
}): Promise<number> {
	const {chrome, input, ctx, pngPath} = params;
	const source = wrapHtml(input.html);
	await writeFile(join(ctx.outDir, SOURCE_FILE), source);
	const sandbox = await startRenderSandbox({
		cwd: ctx.cwd,
		documents: {[SOURCE_FILE]: source, [QA_FILE]: qaDocument(input)},
	});
	try {
		return await withChrome(
			{
				chrome,
				sandbox,
				width: input.width,
				height: input.height,
				signal: ctx.signal,
			},
			async session => {
				const png = await captureDesign({session, sandbox, input});
				assertExpectedPng(png, input);
				await writeFile(pngPath, png);
				await writeLayoutReport({session, sandbox, input, ctx});
				ctx.signal.throwIfAborted();
				return png.length;
			},
		);
	} finally {
		await sandbox.close();
	}
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
					'A full HTML document, or an HTML/SVG fragment (wrapped with margin 0). Self-contained: inline CSS, inline SVG, data: URIs. The page has no network, so https and file assets do not load. An earlier output of this project loads from /out/<jobId>/<file>.',
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
						'Chrome, Edge or Chromium was not found. Install Chrome or set ATELIER_CHROME to a browser binary.',
				}
			: {ok: true},
	run: async ({input, ctx}): Promise<readonly MediaOutput[]> => {
		const chrome = await findChrome(ctx.env);
		if (chrome === undefined) {
			throw engineFailure({
				code: 'chrome_missing',
				message: 'No Chrome, Edge or Chromium found. Set ATELIER_CHROME.',
				retryable: false,
			});
		}

		const pngPath = join(ctx.outDir, 'design.png');
		const bytes = await renderDesign({chrome, input, ctx, pngPath}).catch(
			(error: unknown) => {
				// A cancelled run reports as cancelled, whatever Chrome said while it was killed.
				ctx.signal.throwIfAborted();
				if (isEngineFailure(error)) throw error;
				throw engineFailure({
					code: 'render_failed',
					message: `Chrome could not render the design: ${error instanceof Error ? error.message : String(error)}`,
					retryable: true,
				});
			},
		);
		return [{path: pngPath, kind: 'image', bytes}];
	},
};
