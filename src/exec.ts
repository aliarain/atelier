import {spawn} from 'node:child_process';
import type {Exec, ExecParams, ExecResult, MediaKind} from './types.ts';

const MAX_BUFFER = 32 * 1024 * 1024;
// ffmpeg ignores SIGTERM while it is stuck in a decoder, so a stop has to escalate.
const KILL_GRACE_MS = 1500;

function tailOf(text: string): string {
	return text.length > MAX_BUFFER ? text.slice(-MAX_BUFFER) : text;
}

// No shell: arguments go to the program as-is, so model-written text can never become a command.
// Resolves only after the child has exited, so "cancelled" never leaves a process running.
export const execFileExec: Exec = ({
	command,
	args,
	cwd,
	signal,
	timeoutMs,
}: ExecParams): Promise<ExecResult> =>
	new Promise(resolve => {
		if (signal?.aborted === true) {
			resolve({code: 1, stdout: '', stderr: ''});
			return;
		}
		const child = spawn(command, [...args], {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let spawnError: NodeJS.ErrnoException | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let settled = false;

		const terminate = (): void => {
			if (killTimer !== undefined) return;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
		};
		const timeoutTimer =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						terminate();
					}, timeoutMs);
		signal?.addEventListener('abort', terminate, {once: true});

		const settle = (result: ExecResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(killTimer);
			signal?.removeEventListener('abort', terminate);
			resolve(result);
		};

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout = tailOf(stdout + chunk);
		});
		child.stderr.on('data', (chunk: string) => {
			stderr = tailOf(stderr + chunk);
		});
		child.on('error', error => {
			spawnError = error;
		});
		child.on('close', (exitCode, exitSignal) => {
			settle({
				code: spawnError === undefined ? (exitCode ?? 1) : 1,
				stdout,
				stderr: spawnError === undefined ? stderr : `${stderr}${spawnError.message}\n`,
				...(timedOut ? {timedOut: true} : {}),
				...(exitSignal === null ? {} : {signal: exitSignal}),
				...(typeof spawnError?.code === 'string' ? {errno: spawnError.code} : {}),
			});
		});
	});

export interface EngineFailure extends Error {
	readonly code: string;
	readonly retryable: boolean;
}

export function engineFailure(params: {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}): EngineFailure {
	return Object.assign(new Error(params.message), {
		code: params.code,
		retryable: params.retryable,
	});
}

export function isEngineFailure(value: unknown): value is EngineFailure {
	return (
		value instanceof Error &&
		typeof (value as Partial<EngineFailure>).code === 'string' &&
		typeof (value as Partial<EngineFailure>).retryable === 'boolean'
	);
}

// The last few stderr lines are where ffmpeg and Chrome put the actual reason.
export function stderrTail(stderr: string, lines = 6): string {
	return stderr.trim().split('\n').slice(-lines).join('\n');
}

// A tool that is missing or timed out says so plainly and is never retried: neither gets better
// on a second attempt. Any other outcome is the caller's to judge, so it returns undefined.
export function environmentFailure(params: {
	readonly tool: string;
	readonly result: ExecResult;
	readonly timeoutMs: number;
}): EngineFailure | undefined {
	const {tool, result, timeoutMs} = params;
	if (result.errno === 'ENOENT') {
		return engineFailure({
			code: 'missing_tool',
			message: `${tool} is not installed or not on PATH`,
			retryable: false,
		});
	}
	if (result.timedOut !== true) return undefined;
	return engineFailure({
		code: 'timeout',
		message: `${tool} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`,
		retryable: false,
	});
}

const KIND_BY_EXTENSION: Readonly<Record<string, MediaKind>> = {
	png: 'image',
	jpg: 'image',
	jpeg: 'image',
	webp: 'image',
	gif: 'image',
	mp4: 'video',
	mov: 'video',
	webm: 'video',
	m4a: 'audio',
	mp3: 'audio',
	wav: 'audio',
	aiff: 'audio',
};

export function mediaKindOf(path: string): MediaKind | undefined {
	const extension = path.split('.').pop()?.toLowerCase() ?? '';
	return KIND_BY_EXTENSION[extension];
}
