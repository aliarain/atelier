import {constants} from 'node:fs';
import {access, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {engineFailure, stderrTail} from '../exec.ts';
import type {
	Availability,
	Engine,
	EngineRunContext,
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
const QA_TIMEOUT_MS = 30_000;

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
	const shared = intersection(a.rect, b.rect);
	if (shared === undefined) return undefined;
	const smaller = Math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
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
		typeof value.clipped === 'boolean' &&
		typeof value.decoration === 'boolean'
	);
}

const LAYOUT_ELEMENT =
	/<script[^>]*id="studio-layout"[^>]*>([\s\S]*?)<\/script>/;

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
  var frame = document.getElementById("studio-frame");
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
  function textRect(el) {
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    var range = d.createRange();
    el.childNodes.forEach(function (c) {
      if (c.nodeType !== 3 || !c.nodeValue.trim()) return;
      range.selectNodeContents(c);
      Array.prototype.forEach.call(range.getClientRects(), function (q) {
        if (q.width <= 0 || q.height <= 0) return;
        l = Math.min(l, q.left); t = Math.min(t, q.top);
        r = Math.max(r, q.right); b = Math.max(b, q.bottom);
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
      var rc = textRect(el);
      if (!rc) return;
      var s = w.getComputedStyle(el);
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
        clipped: isClipped(el, rc),
        decoration: s.position === "absolute" && parseFloat(s.opacity) < 0.35
      });
    });
    var out = document.createElement("script");
    out.type = "application/json";
    out.id = "studio-layout";
    out.textContent = JSON.stringify({boxes: boxes}).replace(/</g, "\\u003c");
    document.body.appendChild(out);
  }
  frame.addEventListener("load", function () {
    d = frame.contentDocument;
    w = frame.contentWindow;
    var ready = d.fonts && d.fonts.ready ? d.fonts.ready : Promise.resolve();
    ready.then(function () { setTimeout(measure, 0); });
  });
})();`;

const QA_SOURCE_FILE = 'source.html';

// Headless Chrome clamps --window-size to the screen when dumping the DOM, so the page is
// laid out inside an iframe of the exact canvas size. That keeps vw, vh and percentages true.
export function qaDocument(params: {
	readonly width: number;
	readonly height: number;
}): string {
	const frame = `<iframe id="studio-frame" src="${QA_SOURCE_FILE}" style="display:block;border:0;width:${params.width}px;height:${params.height}px"></iframe>`;
	return `<!doctype html><html><body style="margin:0">${frame}<script>${MEASURE_SCRIPT}</script></body></html>`;
}

export function chromeQaArgs(params: {
	readonly profileDir: string;
	readonly sourceUrl: string;
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
		`--user-data-dir=${params.profileDir}`,
		`--window-size=${params.width},${params.height}`,
		'--virtual-time-budget=3000',
		'--dump-dom',
		params.sourceUrl,
	];
}

// A second Chrome pass over the same document. It is advice for the model, so any failure
// here leaves the render untouched and just yields no layout.json.
async function writeLayoutReport(params: {
	readonly chrome: string;
	readonly input: DesignInput;
	readonly ctx: EngineRunContext;
}): Promise<void> {
	const {chrome, input, ctx} = params;
	const qaPath = join(ctx.outDir, 'qa.html');
	const profileDir = join(ctx.outDir, '.chrome-profile-qa');
	try {
		await writeFile(qaPath, qaDocument(input));
		const result = await ctx.exec({
			command: chrome,
			args: chromeQaArgs({
				profileDir,
				sourceUrl: pathToFileURL(qaPath).href,
				width: input.width,
				height: input.height,
			}),
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeoutMs: QA_TIMEOUT_MS,
		});
		if (result.code !== 0) return;
		const boxes = parseLayoutDom(result.stdout);
		if (boxes === undefined) return;
		const report = classifyLayout({
			width: input.width,
			height: input.height,
			boxes,
		});
		await writeFile(join(ctx.outDir, 'layout.json'), JSON.stringify(report));
	} catch {
		return;
	} finally {
		await rm(qaPath, {force: true});
		await rm(profileDir, {recursive: true, force: true});
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

		const sourcePath = join(ctx.outDir, QA_SOURCE_FILE);
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
		await writeLayoutReport({chrome, input, ctx});
		return [{path: pngPath, kind: 'image', bytes}];
	},
};
