import {createHash, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {basename, join, sep} from 'node:path';
import {loadJobs, outputDir} from './jobs.ts';
import type {Job, JobState, MediaKind} from './types.ts';

export interface GalleryHandle {
	readonly url: string;
	readonly port: number;
	readonly close: () => Promise<void>;
}

export type RouteDecision =
	| {readonly kind: 'index'}
	| {readonly kind: 'jobs'}
	| {
			readonly kind: 'media';
			readonly jobId: string;
			readonly file: string;
	  }
	| {readonly kind: 'reject'; readonly status: 403 | 404};

export interface RouteRequest {
	readonly method: string;
	readonly url: string;
}

interface Route {
	readonly pattern: RegExp;
	readonly decide: (groups: Readonly<Record<string, string>>) => RouteDecision;
}

const JOB_ID = /^[a-z0-9-]+$/;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const BASE = 'http://127.0.0.1';

const FORBIDDEN: RouteDecision = {kind: 'reject', status: 403};
const NOT_FOUND: RouteDecision = {kind: 'reject', status: 404};

function mediaDecision(jobId: string, file: string): RouteDecision {
	if (!JOB_ID.test(jobId)) return NOT_FOUND;
	if (!FILE_NAME.test(file) || file.startsWith('.')) return NOT_FOUND;
	return {kind: 'media', jobId, file};
}

const ROUTES: readonly Route[] = [
	{pattern: /^\/$/, decide: () => ({kind: 'index'})},
	{pattern: /^\/api\/jobs$/, decide: () => ({kind: 'jobs'})},
	{
		pattern: /^\/media\/(?<jobId>[^/]+)\/(?<file>[^/]+)$/,
		decide: groups => mediaDecision(groups.jobId ?? '', groups.file ?? ''),
	},
];

// Hashing first makes both buffers the same length, which timingSafeEqual requires.
function tokenMatches(given: string | null, expected: string): boolean {
	if (given === null) return false;
	const digest = (value: string): Buffer =>
		createHash('sha256').update(value).digest();
	return timingSafeEqual(digest(given), digest(expected));
}

// Pure on purpose: every security decision is a function of (method, url, token).
export function route(req: RouteRequest, token: string): RouteDecision {
	if (!URL.canParse(req.url, BASE)) return NOT_FOUND;
	const url = new URL(req.url, BASE);
	if (!tokenMatches(url.searchParams.get('t'), token)) return FORBIDDEN;
	if (req.method !== 'GET') return NOT_FOUND;
	for (const candidate of ROUTES) {
		const match = candidate.pattern.exec(url.pathname);
		if (match !== null) return candidate.decide(match.groups ?? {});
	}
	return NOT_FOUND;
}

export type RangeDecision =
	| {readonly kind: 'full'}
	| {readonly kind: 'partial'; readonly start: number; readonly end: number}
	| {readonly kind: 'unsatisfiable'};

const FULL: RangeDecision = {kind: 'full'};
const UNSATISFIABLE: RangeDecision = {kind: 'unsatisfiable'};
const RANGE = /^bytes=(?<from>\d*)-(?<to>\d*)$/;

// Single byte ranges only. Anything else is ignored, which RFC 9110 allows and
// which makes the browser fall back to a plain 200.
export function parseRange(header: string | undefined, size: number): RangeDecision {
	if (header === undefined) return FULL;
	const groups = RANGE.exec(header.trim())?.groups;
	if (groups === undefined) return FULL;
	const from = groups.from ?? '';
	const to = groups.to ?? '';
	if (from === '' && to === '') return FULL;
	if (from === '') {
		const suffix = Number(to);
		if (suffix === 0 || size === 0) return UNSATISFIABLE;
		return {kind: 'partial', start: Math.max(0, size - suffix), end: size - 1};
	}
	const start = Number(from);
	const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
	if (start >= size || end < start) return UNSATISFIABLE;
	return {kind: 'partial', start, end};
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	aiff: 'audio/aiff',
	// A rendered design must never execute script in the gallery origin.
	html: 'text/plain; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	json: 'application/json; charset=utf-8',
};

export function contentTypeOf(file: string): string {
	const extension = file.split('.').pop()?.toLowerCase() ?? '';
	return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export interface GalleryOutput {
	readonly kind: MediaKind;
	readonly name: string;
	readonly url: string;
	readonly bytes: number;
}

export interface GalleryJob {
	readonly id: string;
	readonly title: string;
	readonly engine: string;
	readonly state: JobState;
	readonly presented: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly error?: {readonly code: string; readonly message: string};
	readonly outputs: readonly GalleryOutput[];
}

function toGalleryOutputs(job: Job, token: string): readonly GalleryOutput[] {
	if (!JOB_ID.test(job.id)) return [];
	if (!Array.isArray(job.outputs)) return [];
	return job.outputs
		.map(output => ({output, name: basename(output.path)}))
		.filter(({name}) => FILE_NAME.test(name) && !name.startsWith('.'))
		.map(({output, name}) => ({
			kind: output.kind,
			name,
			bytes: output.bytes,
			url: `/media/${job.id}/${name}?t=${encodeURIComponent(token)}`,
		}));
}

export function toGalleryJobs(
	jobs: readonly Job[],
	token: string,
): readonly GalleryJob[] {
	return [...jobs]
		.sort((a, b) => b.createdAt - a.createdAt)
		.map(job => ({
			id: job.id,
			title: job.title,
			engine: job.engine,
			state: job.state,
			presented: job.presented === true,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			error:
				job.error === undefined
					? undefined
					: {code: job.error.code, message: job.error.message},
			outputs: toGalleryOutputs(job, token),
		}));
}

const SECURITY_HEADERS = {'X-Content-Type-Options': 'nosniff'} as const;

const INDEX_CSP =
	"default-src 'self'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

// The token rides in the URL, so nothing the page links to may see it as a referrer.
const INDEX_HEADERS = {
	...SECURITY_HEADERS,
	'Content-Type': 'text/html; charset=utf-8',
	'Content-Security-Policy': INDEX_CSP,
	'Referrer-Policy': 'no-referrer',
	'Cache-Control': 'no-store',
} as const;

function sendStatus(res: ServerResponse, status: number): void {
	res.writeHead(status, {...SECURITY_HEADERS, 'Content-Type': 'text/plain'});
	res.end(`${status}\n`);
}

function sendIndex(res: ServerResponse, token: string): void {
	res.writeHead(200, INDEX_HEADERS);
	res.end(renderIndexHtml(token));
}

async function sendJobs(
	res: ServerResponse,
	cwd: string,
	token: string,
): Promise<void> {
	const jobs = await loadJobs(cwd);
	res.writeHead(200, {
		...SECURITY_HEADERS,
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(JSON.stringify(toGalleryJobs(jobs, token)));
}

// Resolving symlinks on both sides stops a link inside the output folder from
// reaching a file outside it.
async function resolveInside(
	dir: string,
	file: string,
): Promise<string | undefined> {
	const [root, target] = await Promise.all([
		realpath(dir).catch(() => undefined),
		realpath(join(dir, file)).catch(() => undefined),
	]);
	if (root === undefined || target === undefined) return undefined;
	return target.startsWith(root + sep) ? target : undefined;
}

async function sendMedia(params: {
	readonly req: IncomingMessage;
	readonly res: ServerResponse;
	readonly cwd: string;
	readonly jobId: string;
	readonly file: string;
}): Promise<void> {
	const {req, res, cwd, jobId, file} = params;
	const path = await resolveInside(outputDir(cwd, jobId), file);
	if (path === undefined) return sendStatus(res, 404);
	const info = await stat(path);
	if (!info.isFile()) return sendStatus(res, 404);
	const range = parseRange(req.headers.range, info.size);
	const headers = {
		...SECURITY_HEADERS,
		'Content-Type': contentTypeOf(file),
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, max-age=60',
		'Content-Security-Policy': "sandbox; default-src 'none'",
	};
	if (range.kind === 'unsatisfiable') {
		res.writeHead(416, {...headers, 'Content-Range': `bytes */${info.size}`});
		return void res.end();
	}
	if (range.kind === 'full') {
		res.writeHead(200, {...headers, 'Content-Length': info.size});
		return stream(path, res, {});
	}
	res.writeHead(206, {
		...headers,
		'Content-Length': range.end - range.start + 1,
		'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
	});
	return stream(path, res, {start: range.start, end: range.end});
}

function stream(
	path: string,
	res: ServerResponse,
	window: {readonly start?: number; readonly end?: number},
): void {
	const source = createReadStream(path, window);
	source.on('error', () => res.destroy());
	res.on('close', () => source.destroy());
	source.pipe(res);
}

async function handle(params: {
	readonly cwd: string;
	readonly token: string;
	readonly req: IncomingMessage;
	readonly res: ServerResponse;
}): Promise<void> {
	const {cwd, token, req, res} = params;
	const decision = route({method: req.method ?? '', url: req.url ?? ''}, token);
	if (decision.kind === 'reject') return sendStatus(res, decision.status);
	if (decision.kind === 'index') return sendIndex(res, token);
	if (decision.kind === 'jobs') return sendJobs(res, cwd, token);
	return sendMedia({req, res, cwd, jobId: decision.jobId, file: decision.file});
}

function failRequest(res: ServerResponse): void {
	if (res.headersSent) return void res.destroy();
	sendStatus(res, 500);
}

export async function startGallery(params: {
	readonly cwd: string;
	readonly token: string;
	readonly port?: number;
}): Promise<GalleryHandle> {
	const {cwd, token, port = 0} = params;
	if (token === '') throw new Error('the gallery needs a non-empty token');
	const server = createServer((req, res) => {
		handle({cwd, token, req, res}).catch(() => failRequest(res));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the gallery server has no TCP address');
	}
	return {
		port: address.port,
		url: `http://127.0.0.1:${address.port}/?t=${encodeURIComponent(token)}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close(error => (error === undefined ? resolve() : reject(error)));
				server.closeAllConnections();
			}),
	};
}

// "<" is escaped so a token can never close the script element.
function scriptString(value: string): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

const PAGE_STYLE = `
:root{color-scheme:dark;--bg:#111214;--card:#1a1b1e;--line:#2a2c31;--text:#ececee;--muted:#9a9ca3;--run:#4c8dff;--ok:#3fb27f;--bad:#e5484d;--warn:#e0a030}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f4f5;--card:#fff;--line:#dcdce0;--text:#18181b;--muted:#63636b;--run:#2563eb;--ok:#15803d;--bad:#c62828;--warn:#a16207}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,sans-serif}
header{display:flex;align-items:baseline;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:18px;font-weight:600}
#status{color:var(--muted);font-size:12px}
main{padding:20px}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.media{display:flex;flex-direction:column;gap:1px;background:var(--line)}
.media img,.media video{display:block;width:100%;max-height:420px;object-fit:contain;background:#000}
.media audio{display:block;width:100%;padding:12px;background:var(--card)}
.placeholder{padding:28px 12px;text-align:center;color:var(--muted);background:var(--card)}
.body{padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.title{font-weight:600;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--muted);font-size:12px}
.chip{padding:1px 8px;border-radius:999px;border:1px solid currentColor;font-size:11px}
.chip.running,.chip.queued{color:var(--run);animation:pulse 1.4s ease-in-out infinite}
.chip.completed{color:var(--ok)}
.chip.failed{color:var(--bad)}
.chip.uncertain,.chip.cancelled{color:var(--warn)}
.presented{color:var(--ok)}
.err{color:var(--bad);font-size:12px;overflow-wrap:anywhere}
#empty{margin:60px auto;max-width:420px;text-align:center;color:var(--muted)}
[hidden]{display:none!important}
@keyframes pulse{50%{opacity:.4}}
@media (prefers-reduced-motion:reduce){.chip{animation:none!important}}
`;

const PAGE_SCRIPT = `
const TOKEN = __TOKEN__;
const POLL_MS = 1500;
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const status = document.getElementById('status');
const cards = new Map();
let lastText = '';

const make = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

const ago = (ms) => {
	const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (seconds < 5) return 'just now';
	if (seconds < 60) return seconds + 's ago';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return minutes + 'm ago';
	const hours = Math.round(minutes / 60);
	if (hours < 48) return hours + 'h ago';
	return Math.round(hours / 24) + 'd ago';
};

const mediaNode = (output, title) => {
	if (output.kind === 'image') {
		const img = make('img');
		img.loading = 'lazy';
		img.alt = title;
		img.src = output.url;
		return img;
	}
	const node = make(output.kind === 'video' ? 'video' : 'audio');
	node.controls = true;
	node.preload = 'metadata';
	node.playsInline = true;
	node.src = output.url;
	return node;
};

const buildCard = (job) => {
	const card = make('article', 'card');
	const media = make('div', 'media');
	job.outputs.forEach((output) => media.append(mediaNode(output, job.title)));
	if (job.outputs.length === 0) {
		const note = job.state === 'running' || job.state === 'queued' ? 'Working on it' : 'No output';
		media.append(make('div', 'placeholder', note));
	}
	const body = make('div', 'body');
	body.append(make('div', 'title', job.title));
	const meta = make('div', 'meta');
	meta.append(make('span', 'chip ' + job.state, job.state));
	meta.append(make('span', '', job.engine));
	const time = make('span', 'time', ago(job.createdAt));
	time.dataset.ts = String(job.createdAt);
	meta.append(time);
	if (job.presented) meta.append(make('span', 'presented', 'presented'));
	body.append(meta);
	if (job.error) body.append(make('div', 'err', job.error.message));
	card.append(media, body);
	return card;
};

const cardFor = (job) => {
	const signature = JSON.stringify(job);
	const cached = cards.get(job.id);
	if (cached && cached.signature === signature) return cached.node;
	const node = buildCard(job);
	cards.set(job.id, {signature, node});
	return node;
};

// Moving a media element in the DOM pauses it, so nodes that are already in place are left alone.
const render = (jobs) => {
	const nodes = jobs.map(cardFor);
	const keep = new Set(nodes);
	const ids = new Set(jobs.map((job) => job.id));
	[...cards.keys()].filter((id) => !ids.has(id)).forEach((id) => cards.delete(id));
	[...grid.children].filter((child) => !keep.has(child)).forEach((child) => child.remove());
	nodes.forEach((node, index) => {
		if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
	});
	empty.hidden = jobs.length > 0;
};

const refreshTimes = () => {
	document.querySelectorAll('.time').forEach((node) => {
		node.textContent = ago(Number(node.dataset.ts));
	});
};

const tick = async () => {
	try {
		const response = await fetch('/api/jobs?t=' + encodeURIComponent(TOKEN), {cache: 'no-store'});
		if (!response.ok) throw new Error('status ' + response.status);
		const text = await response.text();
		if (text !== lastText) {
			lastText = text;
			render(JSON.parse(text));
		}
		refreshTimes();
		status.textContent = 'Live';
	} catch (error) {
		status.textContent = 'Connection lost, retrying';
	}
	setTimeout(tick, POLL_MS);
};

tick();
`;

export function renderIndexHtml(token: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Studio</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header><h1>Studio</h1><span id="status">Connecting</span></header>
<main>
<div id="empty" hidden>Nothing made yet. Ask for a poster, a voiceover or a short video.</div>
<div id="grid"></div>
</main>
<script>${PAGE_SCRIPT.replace('__TOKEN__', () => scriptString(token))}</script>
</body>
</html>
`;
}
