import {execFile} from 'node:child_process';
import type {Exec, ExecParams, ExecResult, MediaKind} from './types.ts';

const MAX_BUFFER = 32 * 1024 * 1024;

// No shell: arguments go to the program as-is, so model-written text can never become a command.
export const execFileExec: Exec = ({
	command,
	args,
	cwd,
	signal,
	timeoutMs,
}: ExecParams): Promise<ExecResult> =>
	new Promise(resolve => {
		execFile(
			command,
			[...args],
			{cwd, signal, timeout: timeoutMs, maxBuffer: MAX_BUFFER},
			(error, stdout, stderr) => {
				const code =
					error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
				resolve({code, stdout: String(stdout), stderr: String(stderr)});
			},
		);
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
