import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {join, sep} from 'node:path';

// The only way model-written HTML reaches Chrome. A per-render loopback server hands out the
// documents of this render and earlier outputs; everything else the page asks for is refused.

export interface RenderSandbox {
	readonly origin: string;
	// Absolute URL of a served document.
	readonly url: (name: string) => string;
	readonly decide: (url: string) => RequestDecision;
	readonly close: () => Promise<void>;
}

export type RequestDecision =
	| {readonly kind: 'allow'}
	| {readonly kind: 'rewrite'; readonly url: string}
	| {readonly kind: 'block'};

export type SandboxRoute =
	| {readonly kind: 'document'; readonly name: string}
	| {readonly kind: 'media'; readonly jobId: string; readonly file: string}
	| {readonly kind: 'reject'; readonly status: 404 | 405};

const JOB_ID = /^[a-z0-9-]+$/;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const BASE = 'http://127.0.0.1';
const OUT_SEGMENT = 'out';

// Only what a design can embed. Html, svg and json from another job could run script or leak data.
const MEDIA_TYPES: Readonly<Record<string, string>> = {
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
};

export function mediaTypeOf(file: string): string | undefined {
	const extension = file.split('.').pop()?.toLowerCase() ?? '';
	return MEDIA_TYPES[extension];
}

const REJECT_NOT_FOUND: SandboxRoute = {kind: 'reject', status: 404};

function digest(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

function tokenMatches(given: string | undefined, expected: string): boolean {
	if (given === undefined) return false;
	return timingSafeEqual(digest(given), digest(expected));
}

// Pure on purpose: every serving decision is a function of (method, path, token, documents).
export function routeSandbox(params: {
	readonly method: string;
	readonly url: string;
	readonly token: string;
	readonly documents: readonly string[];
}): SandboxRoute {
	if (params.method !== 'GET' && params.method !== 'HEAD') {
		return {kind: 'reject', status: 405};
	}
	if (!URL.canParse(params.url, BASE)) return REJECT_NOT_FOUND;
	const [, token, ...rest] = new URL(params.url, BASE).pathname.split('/');
	if (!tokenMatches(token, params.token)) return REJECT_NOT_FOUND;
	const [first, jobId, file] = rest;
	if (rest.length === 1 && first !== undefined && params.documents.includes(first)) {
		return {kind: 'document', name: first};
	}
	if (rest.length !== 3 || first !== OUT_SEGMENT) return REJECT_NOT_FOUND;
	if (jobId === undefined || !JOB_ID.test(jobId)) return REJECT_NOT_FOUND;
	if (file === undefined || !FILE_NAME.test(file) || file.startsWith('.')) {
		return REJECT_NOT_FOUND;
	}
	return {kind: 'media', jobId, file};
}

// What Chrome may fetch on behalf of the page: the sandbox origin, data: and blob: of that
// origin. A root-relative /out/... URL has no token, so it is rewritten to the tokened path.
export function decideRequest(params: {
	readonly url: string;
	readonly origin: string;
	readonly token: string;
}): RequestDecision {
	const {url, origin, token} = params;
	if (!URL.canParse(url)) return {kind: 'block'};
	const parsed = new URL(url);
	if (parsed.protocol === 'data:' || parsed.protocol === 'about:') return {kind: 'allow'};
	if (parsed.protocol === 'blob:') {
		return URL.canParse(parsed.pathname) && new URL(parsed.pathname).origin === origin
			? {kind: 'allow'}
			: {kind: 'block'};
	}
	if (parsed.origin !== origin) return {kind: 'block'};
	if (parsed.pathname.startsWith(`/${OUT_SEGMENT}/`)) {
		return {
			kind: 'rewrite',
			url: `${origin}/${token}${parsed.pathname}${parsed.search}`,
		};
	}
	return {kind: 'allow'};
}

const DOCUMENT_CSP =
	"default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob:; form-action 'none'";

const SECURITY_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'Cache-Control': 'no-store',
} as const;

function sendStatus(res: ServerResponse, status: number): void {
	res.writeHead(status, {...SECURITY_HEADERS, 'Content-Type': 'text/plain'});
	res.end(`${status}\n`);
}

// Resolving symlinks on both sides stops a link inside the output folder from reaching a
// file outside it.
async function resolveInside(dir: string, file: string): Promise<string | undefined> {
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
	readonly outRoot: string;
	readonly jobId: string;
	readonly file: string;
}): Promise<void> {
	const {req, res, outRoot, jobId, file} = params;
	const contentType = mediaTypeOf(file);
	if (contentType === undefined) return sendStatus(res, 404);
	const path = await resolveInside(join(outRoot, jobId), file);
	if (path === undefined) return sendStatus(res, 404);
	const info = await stat(path);
	if (!info.isFile()) return sendStatus(res, 404);
	res.writeHead(200, {
		...SECURITY_HEADERS,
		'Content-Type': contentType,
		'Content-Length': info.size,
		'Content-Security-Policy': "sandbox; default-src 'none'",
	});
	if (req.method === 'HEAD') return void res.end();
	const source = createReadStream(path);
	source.on('error', () => res.destroy());
	res.on('close', () => source.destroy());
	source.pipe(res);
}

function sendDocument(res: ServerResponse, method: string | undefined, body: string): void {
	res.writeHead(200, {
		...SECURITY_HEADERS,
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Security-Policy': DOCUMENT_CSP,
	});
	res.end(method === 'HEAD' ? undefined : body);
}

export async function startRenderSandbox(params: {
	readonly cwd: string;
	// Name to HTML. Served from memory, so nothing on disk is reachable through them.
	readonly documents: Readonly<Record<string, string>>;
}): Promise<RenderSandbox> {
	const token = randomBytes(18).toString('hex');
	const outRoot = join(params.cwd, '.atelier', OUT_SEGMENT);
	const names = Object.keys(params.documents);
	let hostHeader = '';

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		// A hostname that is not the literal loopback address is a DNS rebinding attempt.
		if (req.headers.host !== hostHeader) return sendStatus(res, 404);
		const route = routeSandbox({
			method: req.method ?? '',
			url: req.url ?? '',
			token,
			documents: names,
		});
		if (route.kind === 'reject') return sendStatus(res, route.status);
		if (route.kind === 'document') {
			return sendDocument(res, req.method, params.documents[route.name] ?? '');
		}
		return sendMedia({req, res, outRoot, jobId: route.jobId, file: route.file});
	};

	const server = createServer((req, res) => {
		handle(req, res).catch(() => {
			if (res.headersSent) return void res.destroy();
			sendStatus(res, 500);
		});
	});
	server.on('upgrade', (_req, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the render sandbox has no TCP address');
	}
	hostHeader = `127.0.0.1:${address.port}`;
	const origin = `http://${hostHeader}`;
	return {
		origin,
		url: name => `${origin}/${token}/${name}`,
		decide: url => decideRequest({url, origin, token}),
		close: () =>
			new Promise<void>(resolve => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
