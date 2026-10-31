import {createHash, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {basename, join, sep} from 'node:path';
import {renderIndexHtml} from './gallery-page.ts';
import {loadJob, loadJobs, outputDir} from './jobs.ts';
import {plainTitle} from './policy.ts';
import type {Job, JobState, MediaKind} from './types.ts';

export interface GalleryHandle {
	readonly url: string;
	readonly port: number;
	readonly close: () => Promise<void>;
}

export const GALLERY_ACTIONS = ['variant', 'reveal', 'present'] as const;

export type GalleryAction = (typeof GALLERY_ACTIONS)[number];

export interface GalleryActionResult {
	readonly ok: boolean;
	readonly message: string;
}

// The server only validates and dispatches; the side effects belong to the mod.
export type GalleryActionHandler = (params: {
	readonly action: GalleryAction;
	readonly job: Job;
}) => Promise<GalleryActionResult>;

export type RouteDecision =
	| {readonly kind: 'index'}
	| {readonly kind: 'jobs'}
	| {readonly kind: 'action'}
	| {
			readonly kind: 'media';
			readonly jobId: string;
			readonly file: string;
	  }
	| {readonly kind: 'reject'; readonly status: 403 | 404 | 415};

// The headers are part of the request on purpose: a page on another origin can make the
// browser send a request here, and these are what tell it apart from the gallery's own page.
export interface RouteRequest {
	readonly method: string;
	readonly url: string;
	readonly port: number;
	readonly host: string | undefined;
	readonly origin: string | undefined;
	readonly contentType: string | undefined;
}

interface Route {
	readonly method: 'GET' | 'POST';
	readonly pattern: RegExp;
	readonly decide: (groups: Readonly<Record<string, string>>) => RouteDecision;
}

const JOB_ID = /^[a-z0-9-]+$/;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const BASE = 'http://127.0.0.1';

const FORBIDDEN: RouteDecision = {kind: 'reject', status: 403};
const NOT_FOUND: RouteDecision = {kind: 'reject', status: 404};
const UNSUPPORTED: RouteDecision = {kind: 'reject', status: 415};

const LOCAL_NAMES = ['127.0.0.1', 'localhost'] as const;

// A DNS-rebinding page reaches this server under its own name, so the Host header must be ours.
function hostAllowed(req: RouteRequest): boolean {
	const host = req.host?.toLowerCase();
	return LOCAL_NAMES.some(name => host === `${name}:${req.port}`);
}

function originAllowed(req: RouteRequest): boolean {
	if (req.origin === undefined) return true;
	const origin = req.origin.toLowerCase();
	return LOCAL_NAMES.some(name => origin === `http://${name}:${req.port}`);
}

// A cross-site form can post text/plain without a preflight; only a script on our own page
// sends JSON.
function isJson(contentType: string | undefined): boolean {
	return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function mediaDecision(jobId: string, file: string): RouteDecision {
	if (!JOB_ID.test(jobId)) return NOT_FOUND;
	if (!FILE_NAME.test(file) || file.startsWith('.')) return NOT_FOUND;
	return {kind: 'media', jobId, file};
}

const ROUTES: readonly Route[] = [
	{method: 'GET', pattern: /^\/$/, decide: () => ({kind: 'index'})},
	{method: 'GET', pattern: /^\/api\/jobs$/, decide: () => ({kind: 'jobs'})},
	{method: 'POST', pattern: /^\/api\/action$/, decide: () => ({kind: 'action'})},
	{
		method: 'GET',
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
	// "//host/path" is a network-path reference, not a path on this server.
	if (!req.url.startsWith('/') || req.url.startsWith('//')) return NOT_FOUND;
	if (!URL.canParse(req.url, BASE)) return NOT_FOUND;
	if (!hostAllowed(req)) return FORBIDDEN;
	const url = new URL(req.url, BASE);
	if (!tokenMatches(url.searchParams.get('t'), token)) return FORBIDDEN;
	for (const candidate of ROUTES) {
		if (candidate.method !== req.method) continue;
		const match = candidate.pattern.exec(url.pathname);
		if (match === null) continue;
		const decision = candidate.decide(match.groups ?? {});
		if (decision.kind !== 'action') return decision;
		if (!isJson(req.contentType)) return UNSUPPORTED;
		return originAllowed(req) ? decision : FORBIDDEN;
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
			// Jobs saved before titles were decoded at the tool boundary still hold "&amp;".
			title: plainTitle(job.title, job.engine),
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
	"default-src 'self'; img-src 'self'; media-src 'self'; font-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

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

const MAX_ACTION_BODY = 4096;

function sendJson(
	res: ServerResponse,
	status: number,
	body: GalleryActionResult,
): void {
	res.writeHead(status, {
		...SECURITY_HEADERS,
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		// An oversized body is drained, not read, so the connection must not be reused.
		...(status === 413 ? {Connection: 'close'} : {}),
	});
	res.end(JSON.stringify(body));
}

// Resolves undefined as soon as the body passes the limit. The rest is still drained so the
// client can read the 413.
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
	const declared = Number(req.headers['content-length'] ?? 0);
	if (declared > limit) {
		req.resume();
		return Promise.resolve(undefined);
	}
	return new Promise(resolve => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) return resolve(undefined);
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', () => resolve(undefined));
	});
}

function isGalleryAction(value: unknown): value is GalleryAction {
	return GALLERY_ACTIONS.some(action => action === value);
}

function parseActionRequest(
	text: string,
): {readonly action: GalleryAction; readonly jobId: string} | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) return undefined;
	const {action, jobId} = value as {readonly action?: unknown; readonly jobId?: unknown};
	if (!isGalleryAction(action)) return undefined;
	if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return undefined;
	return {action, jobId};
}

async function handleAction(params: {
	readonly req: IncomingMessage;
	readonly res: ServerResponse;
	readonly cwd: string;
	readonly onAction: GalleryActionHandler | undefined;
}): Promise<void> {
	const {req, res, cwd, onAction} = params;
	if (onAction === undefined) {
		return sendJson(res, 404, {ok: false, message: 'Actions are not available.'});
	}
	const text = await readBody(req, MAX_ACTION_BODY);
	if (text === undefined) {
		return sendJson(res, 413, {ok: false, message: 'That request is too large.'});
	}
	const request = parseActionRequest(text);
	if (request === undefined) {
		return sendJson(res, 400, {ok: false, message: 'That action is not supported.'});
	}
	const job = await loadJob(cwd, request.jobId);
	if (job === undefined) {
		return sendJson(res, 404, {ok: false, message: 'That render no longer exists.'});
	}
	const result = await onAction({action: request.action, job}).catch(
		(): GalleryActionResult => ({ok: false, message: 'That did not work. Try again.'}),
	);
	return sendJson(res, 200, {ok: result.ok, message: result.message});
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
	readonly port: number;
	readonly onAction: GalleryActionHandler | undefined;
	readonly req: IncomingMessage;
	readonly res: ServerResponse;
}): Promise<void> {
	const {cwd, token, port, onAction, req, res} = params;
	const decision = route(
		{
			method: req.method ?? '',
			url: req.url ?? '',
			port,
			host: req.headers.host,
			origin: req.headers.origin,
			contentType: req.headers['content-type'],
		},
		token,
	);
	if (decision.kind === 'reject') return sendStatus(res, decision.status);
	if (decision.kind === 'index') return sendIndex(res, token);
	if (decision.kind === 'jobs') return sendJobs(res, cwd, token);
	if (decision.kind === 'action') return handleAction({req, res, cwd, onAction});
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
	readonly onAction?: GalleryActionHandler;
}): Promise<GalleryHandle> {
	const {cwd, token, port = 0, onAction} = params;
	if (token === '') throw new Error('the gallery needs a non-empty token');
	// The port is known only once listening; requests cannot arrive before that.
	const bound: {port: number} = {port};
	const server = createServer((req, res) => {
		handle({cwd, token, port: bound.port, onAction, req, res}).catch(() => failRequest(res));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the gallery server has no TCP address');
	}
	bound.port = address.port;
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
