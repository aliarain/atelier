import {rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {engineFailure, stderrTail} from '../exec.ts';
import type {
	Availability,
	Engine,
	Exec,
	MediaOutput,
	Parsed,
} from '../types.ts';

const SAY = '/usr/bin/say';
const MAX_TEXT_CHARS = 20_000;
const MIN_RATE = 90;
const MAX_RATE = 360;
const DEFAULT_VOICE = 'Samantha';
const LISTED_ENGLISH_VOICES = 10;
const PROBE_TIMEOUT_MS = 15_000;
const SAY_TIMEOUT_MS = 300_000;
const ENCODE_TIMEOUT_MS = 120_000;

export interface VoiceInput {
	readonly text: string;
	readonly voice?: string;
	readonly rate?: number;
}

export interface SayVoice {
	readonly name: string;
	readonly locale: string;
}

type RawInput = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RawInput {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBetween(value: unknown, min: number, max: number): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= min &&
		value <= max
	);
}

export function parseVoiceInput(raw: unknown): Parsed<VoiceInput> {
	if (!isRecord(raw)) return {ok: false, error: 'input must be an object'};

	const text = raw.text;
	if (typeof text !== 'string' || text.trim() === '') {
		return {ok: false, error: 'text is required and must be a non-empty string'};
	}
	if (text.length > MAX_TEXT_CHARS) {
		return {ok: false, error: `text must be at most ${MAX_TEXT_CHARS} characters`};
	}

	const voice = raw.voice;
	if (voice !== undefined && (typeof voice !== 'string' || voice.trim() === '')) {
		return {ok: false, error: 'voice must be a non-empty string'};
	}

	const rate = raw.rate;
	if (rate !== undefined && !isBetween(rate, MIN_RATE, MAX_RATE)) {
		return {
			ok: false,
			error: `rate must be an integer from ${MIN_RATE} to ${MAX_RATE} words per minute`,
		};
	}

	return {
		ok: true,
		value: {
			text,
			...(voice === undefined ? {} : {voice: voice.trim()}),
			...(rate === undefined ? {} : {rate}),
		},
	};
}

// A line is "<name><spaces><locale><spaces># <sample>". The name may hold spaces and
// parentheses, so the locale is the first token shaped like xx_YY followed by the "#".
const VOICE_LINE = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/;

export function parseVoices(stdout: string): readonly SayVoice[] {
	return stdout.split('\n').flatMap((line): readonly SayVoice[] => {
		const match = VOICE_LINE.exec(line);
		const name = match?.[1];
		const locale = match?.[2];
		if (name === undefined || locale === undefined) return [];
		return [{name, locale}];
	});
}

// "Samantha" must match the listed "Samantha (English (US))", so the bare name counts too.
function baseName(name: string): string {
	const paren = name.indexOf(' (');
	return paren === -1 ? name : name.slice(0, paren);
}

export function findVoice(
	voices: readonly SayVoice[],
	requested: string,
): SayVoice | undefined {
	const wanted = requested.toLowerCase();
	return (
		voices.find(voice => voice.name.toLowerCase() === wanted) ??
		voices.find(voice => baseName(voice.name).toLowerCase() === wanted)
	);
}

function englishVoiceNames(voices: readonly SayVoice[]): readonly string[] {
	const names = voices
		.filter(voice => /^en[_-]/.test(voice.locale))
		.map(voice => voice.name);
	return [...new Set(names)].slice(0, LISTED_ENGLISH_VOICES);
}

async function fileBytes(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
}

async function runsCleanly(
	exec: Exec,
	command: string,
	args: readonly string[],
): Promise<boolean> {
	const result = await exec({command, args, timeoutMs: PROBE_TIMEOUT_MS});
	return result.code === 0;
}

export const voiceEngine: Engine<VoiceInput> = {
	id: 'voice',
	kind: 'audio',
	paid: false,
	summary:
		'Speak text aloud with the macOS voices (say) and save it as an m4a. Free, local, good for narration and voiceover scratch tracks.',
	inputSchema: {
		type: 'object',
		properties: {
			text: {
				type: 'string',
				description: `The script to speak. At most ${MAX_TEXT_CHARS} characters.`,
			},
			voice: {
				type: 'string',
				description: `A macOS voice name from "say -v ?". Default ${DEFAULT_VOICE}.`,
			},
			rate: {
				type: 'integer',
				minimum: MIN_RATE,
				maximum: MAX_RATE,
				description: 'Speaking rate in words per minute. The system default is about 175.',
			},
		},
		required: ['text'],
	},
	parse: parseVoiceInput,
	available: async ({exec}): Promise<Availability> => {
		const sayReady = await runsCleanly(exec, SAY, ['-v', '?']);
		if (!sayReady) {
			return {ok: false, reason: 'macOS text to speech (say) is not available here.'};
		}
		const ffmpegReady = await runsCleanly(exec, 'ffmpeg', ['-version']);
		if (!ffmpegReady) {
			return {ok: false, reason: 'ffmpeg is not on PATH. Install it to encode the audio.'};
		}
		return {ok: true};
	},
	run: async ({input, ctx}): Promise<readonly MediaOutput[]> => {
		const listing = await ctx.exec({
			command: SAY,
			args: ['-v', '?'],
			signal: ctx.signal,
			timeoutMs: PROBE_TIMEOUT_MS,
		});
		if (listing.code !== 0) {
			throw engineFailure({
				code: 'say_failed',
				message: `Could not list voices.\n${stderrTail(listing.stderr)}`,
				retryable: true,
			});
		}

		// say exits 0 and silently falls back to the default voice for an unknown name,
		// so the name is checked against the listing before anything is spoken.
		const voices = parseVoices(listing.stdout);
		const voice = findVoice(voices, input.voice ?? DEFAULT_VOICE);
		if (voice === undefined) {
			throw engineFailure({
				code: 'unknown_voice',
				message: `Unknown voice "${input.voice ?? DEFAULT_VOICE}". English voices include: ${englishVoiceNames(voices).join(', ')}.`,
				retryable: false,
			});
		}

		const scriptPath = join(ctx.outDir, 'script.txt');
		const aiffPath = join(ctx.outDir, 'voice.aiff');
		const m4aPath = join(ctx.outDir, 'voice.m4a');
		await writeFile(scriptPath, input.text);

		const rateArgs = input.rate === undefined ? [] : ['-r', String(input.rate)];
		const spoken = await ctx.exec({
			command: SAY,
			args: ['-v', voice.name, ...rateArgs, '-o', aiffPath, '-f', scriptPath],
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeoutMs: SAY_TIMEOUT_MS,
		});
		if (spoken.code !== 0) {
			throw engineFailure({
				code: 'say_failed',
				message: `say exited with code ${spoken.code}.\n${stderrTail(spoken.stderr)}`,
				retryable: true,
			});
		}

		const encoded = await ctx.exec({
			command: 'ffmpeg',
			args: ['-y', '-i', aiffPath, '-c:a', 'aac', '-b:a', '192k', m4aPath],
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeoutMs: ENCODE_TIMEOUT_MS,
		});
		await rm(aiffPath, {force: true});

		const bytes = encoded.code === 0 ? await fileBytes(m4aPath) : undefined;
		if (bytes === undefined) {
			throw engineFailure({
				code: 'encode_failed',
				message: `ffmpeg exited with code ${encoded.code} and wrote no m4a.\n${stderrTail(encoded.stderr)}`,
				retryable: true,
			});
		}
		return [{path: m4aPath, kind: 'audio', bytes}];
	},
};
