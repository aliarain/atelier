import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {execFileExec, isEngineFailure} from '../src/exec.ts';
import {
	findVoice,
	parseVoiceInput,
	parseVoices,
	voiceEngine,
} from '../src/engines/voice.ts';
import {reviewMedia} from '../src/review.ts';
import type {Availability, EngineRunContext, Exec} from '../src/types.ts';

// The first 20 lines of a real `say -v ?` on macOS, repeats included.
const SAY_SAMPLE = [
	'Albert              en_US    # Hello! My name is Albert.',
	'Alice               it_IT    # Ciao! Mi chiamo Alice.',
	'Soumya              kn_IN    # Hello! My name is Soumya.',
	'Alva                sv_SE    # Hej! Jag heter Alva.',
	'Aman                en_IN    # Hello! My name is Aman.',
	'Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.',
	'Amira               ms_MY    # Helo! Nama saya Amira.',
	'Anna (German (Germany)) de_DE    # Hallo! Ich heiße Anna.',
	'Anna (German (Germany)) de_DE    # Hallo! Ich heiße Anna.',
	'Aru                 kk_KZ    # Hello! My name is Aru.',
	'Bad News            en_US    # Hello! My name is Bad News.',
	'Bahh                en_US    # Hello! My name is Bahh.',
	'Bells               en_US    # Hello! My name is Bells.',
	'Boing               en_US    # Hello! My name is Boing.',
	'Bubbles             en_US    # Hello! My name is Bubbles.',
	'Carmit              he_IL    # שלום, שמי כרמית.',
	'Cellos              en_US    # Hello! My name is Cellos.',
	'Damayanti           id_ID    # Halo! Nama saya Damayanti.',
	'Daniel (English (UK)) en_GB    # Hello! My name is Daniel.',
	'Daniel (English (UK)) en_GB    # Hello! My name is Daniel.',
].join('\n');

const unreachableFetch: typeof fetch = () =>
	Promise.reject(Error('voice must not use the network'));

function contextFor(
	outDir: string,
	overrides: Partial<EngineRunContext> = {},
): EngineRunContext {
	return {
		outDir,
		cwd: outDir,
		signal: AbortSignal.timeout(90_000),
		exec: execFileExec,
		env: process.env,
		fetch: unreachableFetch,
		...overrides,
	};
}

const availability: Availability = await voiceEngine.available({
	exec: execFileExec,
	env: process.env,
});

describe('parseVoiceInput', () => {
	test('accepts text alone', () => {
		assert.deepEqual(parseVoiceInput({text: 'Hello'}), {
			ok: true,
			value: {text: 'Hello'},
		});
	});

	test('accepts voice and rate and trims the voice', () => {
		assert.deepEqual(
			parseVoiceInput({text: 'Hello', voice: ' Daniel ', rate: 200}),
			{ok: true, value: {text: 'Hello', voice: 'Daniel', rate: 200}},
		);
	});

	test('rejects bad inputs with exact messages', () => {
		assert.deepEqual(parseVoiceInput(null), {
			ok: false,
			error: 'input must be an object',
		});
		assert.deepEqual(parseVoiceInput({text: ''}), {
			ok: false,
			error: 'text is required and must be a non-empty string',
		});
		assert.deepEqual(parseVoiceInput({text: 'x'.repeat(20_001)}), {
			ok: false,
			error: 'text must be at most 20000 characters',
		});
		assert.deepEqual(parseVoiceInput({text: 'x', voice: ''}), {
			ok: false,
			error: 'voice must be a non-empty string',
		});
		assert.deepEqual(parseVoiceInput({text: 'x', voice: 7}), {
			ok: false,
			error: 'voice must be a non-empty string',
		});
		assert.deepEqual(parseVoiceInput({text: 'x', rate: 89}), {
			ok: false,
			error: 'rate must be an integer from 90 to 360 words per minute',
		});
		assert.deepEqual(parseVoiceInput({text: 'x', rate: 361}), {
			ok: false,
			error: 'rate must be an integer from 90 to 360 words per minute',
		});
		assert.deepEqual(parseVoiceInput({text: 'x', rate: 150.5}), {
			ok: false,
			error: 'rate must be an integer from 90 to 360 words per minute',
		});
	});

	test('accepts the rate bounds', () => {
		assert.equal(parseVoiceInput({text: 'x', rate: 90}).ok, true);
		assert.equal(parseVoiceInput({text: 'x', rate: 360}).ok, true);
	});
});

describe('parseVoices', () => {
	test('parses a captured say -v ? listing', () => {
		assert.deepEqual(parseVoices(SAY_SAMPLE), [
			{name: 'Albert', locale: 'en_US'},
			{name: 'Alice', locale: 'it_IT'},
			{name: 'Soumya', locale: 'kn_IN'},
			{name: 'Alva', locale: 'sv_SE'},
			{name: 'Aman', locale: 'en_IN'},
			{name: 'Amélie', locale: 'fr_CA'},
			{name: 'Amira', locale: 'ms_MY'},
			{name: 'Anna (German (Germany))', locale: 'de_DE'},
			{name: 'Anna (German (Germany))', locale: 'de_DE'},
			{name: 'Aru', locale: 'kk_KZ'},
			{name: 'Bad News', locale: 'en_US'},
			{name: 'Bahh', locale: 'en_US'},
			{name: 'Bells', locale: 'en_US'},
			{name: 'Boing', locale: 'en_US'},
			{name: 'Bubbles', locale: 'en_US'},
			{name: 'Carmit', locale: 'he_IL'},
			{name: 'Cellos', locale: 'en_US'},
			{name: 'Damayanti', locale: 'id_ID'},
			{name: 'Daniel (English (UK))', locale: 'en_GB'},
			{name: 'Daniel (English (UK))', locale: 'en_GB'},
		]);
	});

	test('skips blank and malformed lines', () => {
		assert.deepEqual(parseVoices('\nnot a voice line\nEddy (English (US)) en_US    # Hi\n'), [
			{name: 'Eddy (English (US))', locale: 'en_US'},
		]);
		assert.deepEqual(parseVoices(''), []);
	});
});

describe('findVoice', () => {
	const voices = parseVoices(SAY_SAMPLE);

	test('matches the full listed name, case-insensitively', () => {
		assert.deepEqual(findVoice(voices, 'daniel (english (uk))'), {
			name: 'Daniel (English (UK))',
			locale: 'en_GB',
		});
	});

	test('matches a bare name against the qualified listing', () => {
		assert.deepEqual(findVoice(voices, 'Daniel'), {
			name: 'Daniel (English (UK))',
			locale: 'en_GB',
		});
		assert.deepEqual(findVoice(voices, 'Bad News'), {
			name: 'Bad News',
			locale: 'en_US',
		});
	});

	test('returns nothing for an unknown name', () => {
		assert.equal(findVoice(voices, 'Nobody'), undefined);
	});
});

describe('voiceEngine', () => {
	test('rejects an unknown voice and lists English voices, without speaking', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-unknown-'));
		const calls: string[] = [];
		const listingOnly: Exec = async ({command, args}) => {
			calls.push(`${command} ${args.join(' ')}`);
			return {code: 0, stdout: SAY_SAMPLE, stderr: ''};
		};
		await assert.rejects(
			voiceEngine.run({
				input: {text: 'Hi', voice: 'Nobody'},
				ctx: contextFor(outDir, {exec: listingOnly}),
			}),
			(error: unknown) =>
				isEngineFailure(error) &&
				error.code === 'unknown_voice' &&
				!error.retryable &&
				error.message ===
					'Unknown voice "Nobody". English voices include: Albert, Aman, Bad News, Bahh, Bells, Boing, Bubbles, Cellos, Daniel (English (UK)).',
		);
		assert.deepEqual(calls, ['/usr/bin/say -v ?']);
		await rm(outDir, {recursive: true, force: true});
	});

	test('passes the script through a file and the resolved voice name to say', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-args-'));
		const calls: string[][] = [];
		const recording: Exec = async ({command, args}) => {
			calls.push([command, ...args]);
			const isListing = args.join(' ') === '-v ?';
			return {
				code: isListing ? 0 : 1,
				stdout: isListing ? SAY_SAMPLE : '',
				stderr: 'stop here',
			};
		};
		await assert.rejects(
			voiceEngine.run({
				input: {text: 'Quote "this" $(rm -rf /)', voice: 'Daniel', rate: 200},
				ctx: contextFor(outDir, {exec: recording}),
			}),
		);
		// Only the listing succeeded; the speak call is the second one.
		const [listing, speak] = calls;
		assert.deepEqual(listing, ['/usr/bin/say', '-v', '?']);
		assert.deepEqual(speak, [
			'/usr/bin/say',
			'-v',
			'Daniel (English (UK))',
			'-r',
			'200',
			'-o',
			join(outDir, 'voice.aiff'),
			'-f',
			join(outDir, 'script.txt'),
		]);
		assert.equal(await readFile(join(outDir, 'script.txt'), 'utf8'), 'Quote "this" $(rm -rf /)');
		await rm(outDir, {recursive: true, force: true});
	});

	test(
		'speaks "Atelier test" into an m4a',
		{skip: !availability.ok},
		async () => {
			const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-'));
			const outputs = await voiceEngine.run({
				input: {text: 'Atelier test'},
				ctx: contextFor(outDir),
			});

			const output = outputs[0];
			assert.equal(outputs.length, 1);
			assert.equal(output?.kind, 'audio');
			assert.equal(output?.path, join(outDir, 'voice.m4a'));
			assert.ok((output?.bytes ?? 0) > 1000, `m4a has ${output?.bytes} bytes`);
			assert.deepEqual((await readdir(outDir)).sort(), [
				'script.txt',
				'voice.m4a',
			]);
			await rm(outDir, {recursive: true, force: true});
		},
	);
});

describe('voiceEngine failures', () => {
	function scripted(
		onEncode: (args: readonly string[]) => Promise<Awaited<ReturnType<Exec>>>,
	): Exec {
		return async ({command, args}) => {
			if (args.join(' ') === '-v ?') return {code: 0, stdout: SAY_SAMPLE, stderr: ''};
			if (command === '/usr/bin/say') {
				const out = args[args.indexOf('-o') + 1] ?? '';
				await writeFile(out, 'aiff bytes');
				return {code: 0, stdout: '', stderr: ''};
			}
			return onEncode(args);
		};
	}

	test('reports a missing ffmpeg plainly and leaves no audio files behind', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-noffmpeg-'));
		const exec = scripted(async args => {
			await writeFile(args.at(-1) ?? '', 'partial');
			return {code: 1, stdout: '', stderr: 'spawn ffmpeg ENOENT', errno: 'ENOENT'};
		});
		await assert.rejects(
			voiceEngine.run({input: {text: 'Hi', voice: 'Daniel'}, ctx: contextFor(outDir, {exec})}),
			(error: unknown) =>
				isEngineFailure(error) &&
				error.code === 'missing_tool' &&
				!error.retryable &&
				error.message === 'ffmpeg is not installed or not on PATH',
		);
		assert.deepEqual(await readdir(outDir), ['script.txt']);
		await rm(outDir, {recursive: true, force: true});
	});

	test('reports an encode that ran out of time as a non-retryable timeout', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-timeout-'));
		const exec = scripted(async args => {
			await writeFile(args.at(-1) ?? '', 'partial');
			return {code: 1, stdout: '', stderr: '', timedOut: true, signal: 'SIGTERM'};
		});
		await assert.rejects(
			voiceEngine.run({input: {text: 'Hi', voice: 'Daniel'}, ctx: contextFor(outDir, {exec})}),
			(error: unknown) =>
				isEngineFailure(error) &&
				error.code === 'timeout' &&
				!error.retryable &&
				error.message === 'ffmpeg took longer than 120s and was stopped',
		);
		assert.deepEqual(await readdir(outDir), ['script.txt']);
		await rm(outDir, {recursive: true, force: true});
	});

	test('deletes the partial m4a when the encode fails for another reason', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-partial-'));
		const exec = scripted(async args => {
			await writeFile(args.at(-1) ?? '', 'partial');
			return {code: 1, stdout: '', stderr: 'Invalid data'};
		});
		await assert.rejects(
			voiceEngine.run({input: {text: 'Hi', voice: 'Daniel'}, ctx: contextFor(outDir, {exec})}),
			(error: unknown) =>
				isEngineFailure(error) && error.code === 'encode_failed' && error.retryable,
		);
		assert.deepEqual(await readdir(outDir), ['script.txt']);
		await rm(outDir, {recursive: true, force: true});
	});

	test('encodes with loudness normalisation', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-filter-'));
		const seen: (readonly string[])[] = [];
		const exec = scripted(async args => {
			seen.push(args);
			await writeFile(args.at(-1) ?? '', 'encoded');
			return {code: 0, stdout: '', stderr: ''};
		});
		await voiceEngine.run({input: {text: 'Hi', voice: 'Daniel'}, ctx: contextFor(outDir, {exec})});
		assert.deepEqual(seen, [
			[
				'-y',
				'-i',
				join(outDir, 'voice.aiff'),
				'-af',
				'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
				'-c:a',
				'aac',
				'-b:a',
				'192k',
				join(outDir, 'voice.m4a'),
			],
		]);
		await rm(outDir, {recursive: true, force: true});
	});

	test(
		'lands the Fred voice inside the review loudness range',
		{skip: !availability.ok},
		async () => {
			const outDir = await mkdtemp(join(tmpdir(), 'atelier-voice-fred-'));
			const outputs = await voiceEngine.run({
				input: {
					text: 'Welcome to the product tour. In the next minute we will walk through three features.',
					voice: 'Fred',
				},
				ctx: contextFor(outDir),
			});
			const review = await reviewMedia({path: outputs[0]?.path ?? '', exec: execFileExec});
			const loudness = review.checks.find(check => check.id === 'loudness');
			assert.equal(loudness?.status, 'pass');
			const lufs = Number(loudness?.detail.split(' ')[0]);
			assert.ok(lufs >= -20 && lufs <= -12, `${lufs} LUFS`);
			await rm(outDir, {recursive: true, force: true});
		},
	);
});
