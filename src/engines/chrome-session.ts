import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Readable, Writable} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
import {stderrTail} from '../exec.ts';
import type {RenderSandbox, RequestDecision} from './render-sandbox.ts';

type RawRecord = Readonly<Record<string, unknown>>;

const READY_TIMEOUT_MS = 10_000;
const TERM_GRACE_MS = 500;
const PROFILE_RETRY_MS = 200;
const DEAD_PROXY = '127.0.0.1:9';
const PROFILE_PREFIX = 'atelier-chrome-';

function isRecord(value: unknown): value is RawRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cdpRequest(
	id: number,
	method: string,
	params: Readonly<Record<string, unknown>> = {},
	sessionId?: string,
): string {
	return JSON.stringify(
		sessionId === undefined ? {id, method, params} : {id, method, params, sessionId},
	);
}

export type CdpMessage =
	| {readonly kind: 'result'; readonly id: number; readonly result: unknown}
	| {readonly kind: 'error'; readonly id: number; readonly message: string}
	| {
			readonly kind: 'event';
			readonly method: string;
			readonly params: unknown;
			readonly sessionId?: string;
	  };

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
	if (typeof method !== 'string') return undefined;
	const sessionId = raw['sessionId'];
	return typeof sessionId === 'string'
		? {kind: 'event', method, params: raw['params'], sessionId}
		: {kind: 'event', method, params: raw['params']};
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const timer = AbortSignal.timeout(ms);
	const timedOut = new Promise<never>((_, reject) => {
		timer.addEventListener('abort', () => reject(Error(`${label} timed out after ${ms} ms`)), {
			once: true,
		});
	});
	return Promise.race([promise, timedOut]);
}

interface Settler {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
}

// The browser-level DevTools connection. Pipe messages end in a NUL byte instead of a frame.
interface Connection {
	readonly call: (
		method: string,
		params?: Readonly<Record<string, unknown>>,
		sessionId?: string,
	) => Promise<unknown>;
	readonly on: (sessionId: string, method: string, handler: (params: unknown) => void) => void;
	// Register before the call that triggers the event, or a fast event is missed.
	readonly next: (sessionId: string, method: string) => Promise<unknown>;
	readonly close: () => void;
}

const CLOSED_MESSAGE = 'Chrome closed the DevTools connection';

function eventKey(sessionId: string, method: string): string {
	return `${sessionId} ${method}`;
}

function connectPipe(pipe: {readonly read: Readable; readonly write: Writable}): Connection {
	const pending = new Map<number, Settler>();
	const waiters = new Map<string, Settler[]>();
	const handlers = new Map<string, (params: unknown) => void>();
	let lastId = 0;
	let closed: Error | undefined;
	let buffer = '';

	const failAll = (error: Error): void => {
		closed = error;
		for (const settler of pending.values()) settler.reject(error);
		for (const list of waiters.values()) {
			for (const settler of list) settler.reject(error);
		}
		pending.clear();
		waiters.clear();
	};

	const dispatch = (message: CdpMessage): void => {
		if (message.kind === 'event') {
			const key = eventKey(message.sessionId ?? '', message.method);
			handlers.get(key)?.(message.params);
			const list = waiters.get(key) ?? [];
			waiters.delete(key);
			for (const settler of list) settler.resolve(message.params);
			return;
		}
		const settler = pending.get(message.id);
		pending.delete(message.id);
		if (settler === undefined) return;
		if (message.kind === 'error') return settler.reject(Error(message.message));
		settler.resolve(message.result);
	};

	pipe.read.setEncoding('utf8');
	pipe.read.on('data', (chunk: string) => {
		const parts = (buffer + chunk).split('\0');
		buffer = parts.pop() ?? '';
		for (const part of parts) {
			const message = parseCdpMessage(part);
			if (message !== undefined) dispatch(message);
		}
	});
	pipe.read.on('close', () => failAll(Error(CLOSED_MESSAGE)));
	pipe.read.on('error', () => failAll(Error(CLOSED_MESSAGE)));
	pipe.write.on('error', () => failAll(Error(CLOSED_MESSAGE)));

	return {
		call: (method, params, sessionId) =>
			new Promise((done, failed) => {
				if (closed !== undefined) return failed(closed);
				lastId += 1;
				pending.set(lastId, {resolve: done, reject: failed});
				pipe.write.write(`${cdpRequest(lastId, method, params, sessionId)}\0`);
			}),
		on: (sessionId, method, handler) => {
			handlers.set(eventKey(sessionId, method), handler);
		},
		next: (sessionId, method) => {
			const event = new Promise<unknown>((done, failed) => {
				if (closed !== undefined) return failed(closed);
				const key = eventKey(sessionId, method);
				waiters.set(key, [...(waiters.get(key) ?? []), {resolve: done, reject: failed}]);
			});
			// Registered ahead of its consumer, so a close before the await must not be unhandled.
			event.catch(() => undefined);
			return event;
		},
		close: () => {
			pipe.write.destroy();
			pipe.read.destroy();
		},
	};
}

export interface ChromePage {
	readonly call: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<unknown>;
	readonly next: (event: string) => Promise<unknown>;
	// URLs the sandbox refused, for diagnostics and tests.
	readonly blocked: () => readonly string[];
	readonly close: () => Promise<void>;
}

export interface ChromeSession {
	readonly openPage: (params: {
		readonly width: number;
		readonly height: number;
		readonly scale: number;
	}) => Promise<ChromePage>;
}

function stringField(value: unknown, key: string): string {
	const field = isRecord(value) ? value[key] : undefined;
	if (typeof field !== 'string') throw Error(`Chrome returned no ${key}`);
	return field;
}

function pausedRequest(params: unknown): {readonly requestId: string; readonly url: string} {
	const request = isRecord(params) ? params['request'] : undefined;
	return {requestId: stringField(params, 'requestId'), url: stringField(request, 'url')};
}

// Every request the page makes pauses here. Only the sandbox origin, data: and blob: go on;
// the rest fail before Chrome touches the network.
async function openPage(params: {
	readonly connection: Connection;
	readonly sandbox: RenderSandbox;
	readonly width: number;
	readonly height: number;
	readonly scale: number;
}): Promise<ChromePage> {
	const {connection, sandbox, width, height, scale} = params;
	const target = await connection.call('Target.createTarget', {url: 'about:blank'});
	const targetId = stringField(target, 'targetId');
	const attached = await connection.call('Target.attachToTarget', {targetId, flatten: true});
	const sessionId = stringField(attached, 'sessionId');
	const blocked: string[] = [];
	const call: ChromePage['call'] = (method, args) => connection.call(method, args, sessionId);

	const answer = (requestId: string, decision: RequestDecision): Promise<unknown> => {
		if (decision.kind === 'block') {
			return call('Fetch.failRequest', {requestId, errorReason: 'BlockedByClient'});
		}
		if (decision.kind === 'rewrite') {
			return call('Fetch.continueRequest', {requestId, url: decision.url});
		}
		return call('Fetch.continueRequest', {requestId});
	};

	connection.on(sessionId, 'Fetch.requestPaused', event => {
		const {requestId, url} = pausedRequest(event);
		const decision = sandbox.decide(url);
		if (decision.kind === 'block') blocked.push(url);
		// The page may have navigated away and taken the request with it.
		answer(requestId, decision).catch(() => undefined);
	});
	await call('Page.enable');
	await call('Emulation.setDeviceMetricsOverride', {
		width,
		height,
		deviceScaleFactor: scale,
		mobile: false,
	});
	await call('Fetch.enable', {patterns: [{urlPattern: '*'}]});

	return {
		call,
		next: event => connection.next(sessionId, event),
		blocked: () => [...blocked],
		close: async () => {
			await connection.call('Target.closeTarget', {targetId}).catch(() => undefined);
		},
	};
}

export function chromeArgs(params: {
	readonly profileDir: string;
	readonly width: number;
	readonly height: number;
	readonly sandboxHost: string;
}): readonly string[] {
	return [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--mute-audio',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-networking',
		'--disable-component-update',
		'--remote-debugging-pipe',
		`--user-data-dir=${params.profileDir}`,
		`--window-size=${params.width},${params.height}`,
		// Defense in depth under the request interception: whatever it misses (popups, workers,
		// WebSocket, WebRTC) is sent to a closed port. Only the sandbox host skips the proxy.
		`--proxy-server=${DEAD_PROXY}`,
		`--proxy-bypass-list=<-loopback>;${params.sandboxHost}`,
		'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
		'about:blank',
	];
}

// Chrome forks helpers into its own process group (detached makes it a leader), so one group
// kill ends the browser and every renderer; killing only the lead pid leaves orphans.
function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// the group is already gone
	}
}

const liveGroups = new Set<number>();
let exitHookInstalled = false;

// A host that exits mid-render must not leave Chrome running.
function trackGroup(pid: number): void {
	liveGroups.add(pid);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once('exit', () => {
		for (const group of liveGroups) killGroup(group, 'SIGKILL');
	});
}

async function removeProfile(profileDir: string): Promise<void> {
	const attempt = (): Promise<void> => rm(profileDir, {recursive: true, force: true});
	// Helpers can write into the profile while it is deleted, so one retry settles it.
	await attempt().catch(async () => {
		await sleep(PROFILE_RETRY_MS);
		await attempt();
	});
}

interface Launched {
	readonly connection: Connection;
	readonly stop: () => Promise<void>;
	readonly exitTail: () => Promise<string>;
}

async function launch(params: {
	readonly chrome: string;
	readonly sandbox: RenderSandbox;
	readonly width: number;
	readonly height: number;
	readonly signal: AbortSignal;
}): Promise<Launched> {
	const {chrome, sandbox, width, height, signal} = params;
	signal.throwIfAborted();
	const profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
	const args = chromeArgs({
		profileDir,
		width,
		height,
		sandboxHost: new URL(sandbox.origin).host,
	});
	const child = spawn(chrome, [...args], {
		detached: true,
		stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
	});
	const pid = child.pid;
	let stderr = '';
	child.stderr?.on('data', chunk => {
		stderr = (stderr + String(chunk)).slice(-4000);
	});
	let exitedFlag = false;
	const exited = new Promise<string>(resolve => {
		child.once('exit', () => {
			exitedFlag = true;
			resolve(stderrTail(stderr));
		});
		child.once('error', error => {
			exitedFlag = true;
			resolve(error.message);
		});
	});
	const [writer, reader] = [child.stdio[3], child.stdio[4]];
	if (pid === undefined || !isDuplex(writer) || !isDuplex(reader)) {
		if (pid !== undefined) killGroup(pid, 'SIGKILL');
		const reason = await Promise.race([exited, sleep(READY_TIMEOUT_MS).then(() => '')]);
		await removeProfile(profileDir);
		throw Error(`Chrome did not start.\n${reason}`);
	}
	trackGroup(pid);
	const connection = connectPipe({read: reader, write: writer});

	const kill = (): void => killGroup(pid, 'SIGKILL');
	signal.addEventListener('abort', kill, {once: true});
	let stopping: Promise<void> | undefined;
	const stopOnce = async (): Promise<void> => {
		signal.removeEventListener('abort', kill);
		connection.close();
		if (!exitedFlag) {
			killGroup(pid, 'SIGTERM');
			await Promise.race([exited, sleep(TERM_GRACE_MS)]);
		}
		killGroup(pid, 'SIGKILL');
		await exited;
		liveGroups.delete(pid);
		await removeProfile(profileDir);
	};
	return {
		connection,
		stop: () => (stopping ??= stopOnce()),
		exitTail: () => Promise.race([exited, sleep(READY_TIMEOUT_MS).then(() => '')]),
	};
}

function isDuplex(value: unknown): value is Readable & Writable {
	return typeof value === 'object' && value !== null && 'write' in value && 'on' in value;
}

// Runs `body` against a sandboxed Chrome and always tears it down: process group, pipes and
// profile directory. A dead Chrome carries its last stderr lines into the error.
export async function withChrome<T>(
	params: {
		readonly chrome: string;
		readonly sandbox: RenderSandbox;
		readonly width: number;
		readonly height: number;
		readonly signal: AbortSignal;
	},
	body: (session: ChromeSession) => Promise<T>,
): Promise<T> {
	const launched = await launch(params);
	try {
		await withTimeout(launched.connection.call('Browser.getVersion'), READY_TIMEOUT_MS, 'Chrome start');
		return await body({
			openPage: size => openPage({connection: launched.connection, sandbox: params.sandbox, ...size}),
		});
	} catch (error) {
		await launched.stop();
		if (!(error instanceof Error) || error.message !== CLOSED_MESSAGE) throw error;
		throw Error(`${error.message}.\n${await launched.exitTail()}`);
	} finally {
		await launched.stop();
	}
}
