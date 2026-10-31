import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {execFileExec, isEngineFailure} from '../src/exec.ts';
import {
	falImageEngine,
	falImageUrls,
	falRequest,
	imageExtension,
	parseFalImageInput,
} from '../src/engines/fal-image.ts';
import type {FalImageInput} from '../src/engines/fal-image.ts';
import {runJob} from '../src/runner.ts';
import type {Engine, EngineRunContext} from '../src/types.ts';

const INPUT: FalImageInput = {
	prompt: 'a red fox',
	model: 'fal-ai/flux/schnell',
	image_size: 'portrait_4_3',
};

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const WEBP_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function contextFor(
	outDir: string,
	fakeFetch: typeof fetch,
	env: EngineRunContext['env'] = {FAL_KEY: 'secret-key'},
): EngineRunContext {
	return {
		outDir,
		cwd: outDir,
		signal: AbortSignal.timeout(10_000),
		exec: execFileExec,
		env,
		fetch: fakeFetch,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {status});
}

describe('parseFalImageInput', () => {
	test('applies defaults', () => {
		assert.deepEqual(parseFalImageInput({prompt: 'a red fox'}), {
			ok: true,
			value: {
				prompt: 'a red fox',
				model: 'fal-ai/flux/schnell',
				image_size: 'portrait_4_3',
			},
		});
	});

	test('accepts explicit model, size and seed', () => {
		assert.deepEqual(
			parseFalImageInput({
				prompt: 'x',
				model: 'fal-ai/flux-pro/v1.1',
				image_size: 'landscape_16_9',
				seed: 0,
			}),
			{
				ok: true,
				value: {
					prompt: 'x',
					model: 'fal-ai/flux-pro/v1.1',
					image_size: 'landscape_16_9',
					seed: 0,
				},
			},
		);
	});

	test('rejects bad inputs with exact messages', () => {
		assert.deepEqual(parseFalImageInput([]), {
			ok: false,
			error: 'input must be an object',
		});
		assert.deepEqual(parseFalImageInput({}), {
			ok: false,
			error: 'prompt is required and must be a non-empty string',
		});
		assert.deepEqual(parseFalImageInput({prompt: 'x'.repeat(4001)}), {
			ok: false,
			error: 'prompt must be at most 4000 characters',
		});
		assert.deepEqual(parseFalImageInput({prompt: 'x', model: 'Flux/Schnell'}), {
			ok: false,
			error: 'model must look like "fal-ai/flux/schnell" (lowercase owner/name)',
		});
		assert.deepEqual(parseFalImageInput({prompt: 'x', model: 'noslash'}), {
			ok: false,
			error: 'model must look like "fal-ai/flux/schnell" (lowercase owner/name)',
		});
		assert.deepEqual(parseFalImageInput({prompt: 'x', image_size: 'huge'}), {
			ok: false,
			error:
				'image_size must be one of square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9',
		});
		assert.deepEqual(parseFalImageInput({prompt: 'x', seed: 1.5}), {
			ok: false,
			error: 'seed must be an integer',
		});
	});
});

describe('falRequest', () => {
	test('builds the fal.run call', () => {
		assert.deepEqual(falRequest({...INPUT, seed: 7}, 'k'), {
			url: 'https://fal.run/fal-ai/flux/schnell',
			init: {
				method: 'POST',
				headers: {
					Authorization: 'Key k',
					'Content-Type': 'application/json',
				},
				body: '{"prompt":"a red fox","image_size":"portrait_4_3","num_images":1,"seed":7}',
			},
		});
	});

	test('omits the seed when not given', () => {
		assert.equal(
			falRequest(INPUT, 'k').init.body,
			'{"prompt":"a red fox","image_size":"portrait_4_3","num_images":1}',
		);
	});
});

describe('falImageUrls', () => {
	test('reads images[].url', () => {
		assert.deepEqual(
			falImageUrls({
				images: [{url: 'https://a/1.png'}, {url: 'https://a/2.png', width: 1}],
			}),
			['https://a/1.png', 'https://a/2.png'],
		);
	});

	test('returns nothing for unexpected shapes', () => {
		assert.deepEqual(falImageUrls(null), []);
		assert.deepEqual(falImageUrls({images: 'nope'}), []);
		assert.deepEqual(falImageUrls({images: [{url: 3}, 'x', null]}), []);
		assert.deepEqual(falImageUrls({data: []}), []);
	});
});

describe('imageExtension', () => {
	test('maps content types', () => {
		assert.equal(imageExtension('image/png'), 'png');
		assert.equal(imageExtension('image/jpeg'), 'jpg');
		assert.equal(imageExtension('IMAGE/WEBP; charset=binary'), 'webp');
		assert.equal(imageExtension('text/html'), undefined);
		assert.equal(imageExtension(null), undefined);
	});
});

describe('falImageEngine.available', () => {
	test('needs FAL_KEY', async () => {
		assert.deepEqual(
			await falImageEngine.available({exec: execFileExec, env: {}}),
			{ok: false, reason: 'Set FAL_KEY to use fal.ai models.'},
		);
		assert.deepEqual(
			await falImageEngine.available({exec: execFileExec, env: {FAL_KEY: 'k'}}),
			{ok: true},
		);
	});
});

describe('falImageEngine.run', () => {
	test('generates, downloads and saves the first image', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-'));
		const seen: {url: string; method: string; auth: string | null; signal: boolean}[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const url = String(input);
			seen.push({
				url,
				method: init?.method ?? 'GET',
				auth: new Headers(init?.headers).get('authorization'),
				signal: init?.signal instanceof AbortSignal,
			});
			if (url.startsWith('https://fal.run/')) {
				return jsonResponse({
					images: [{url: 'https://cdn.example/fox.png'}, {url: 'https://cdn.example/other.png'}],
				});
			}
			return new Response(PNG_BYTES, {headers: {'content-type': 'image/png'}});
		};

		const outputs = await falImageEngine.run({
			input: INPUT,
			ctx: contextFor(outDir, fakeFetch),
		});

		assert.deepEqual(outputs, [
			{path: join(outDir, 'fal-image.png'), kind: 'image', bytes: 12},
		]);
		assert.deepEqual([...(await readFile(join(outDir, 'fal-image.png')))], [...PNG_BYTES]);
		assert.deepEqual(seen, [
			{url: 'https://fal.run/fal-ai/flux/schnell', method: 'POST', auth: 'Key secret-key', signal: true},
			{url: 'https://cdn.example/fox.png', method: 'GET', auth: null, signal: true},
		]);
		await rm(outDir, {recursive: true, force: true});
	});

	test('names the file after the bytes it holds', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-jpg-'));
		const fakeFetch: typeof fetch = async input =>
			String(input).startsWith('https://fal.run/')
				? jsonResponse({images: [{url: 'https://cdn.example/fox'}]})
				: new Response(JPEG_BYTES, {headers: {'content-type': 'image/jpeg'}});
		const outputs = await falImageEngine.run({
			input: INPUT,
			ctx: contextFor(outDir, fakeFetch),
		});
		assert.equal(outputs[0]?.path, join(outDir, 'fal-image.jpg'));
		await rm(outDir, {recursive: true, force: true});
	});

	const failureCases: readonly {
		readonly name: string;
		readonly respond: () => Promise<Response>;
		readonly code: string;
		readonly retryable: boolean;
	}[] = [
		{name: 'HTTP 401', respond: async () => jsonResponse({detail: 'no'}, 401), code: 'auth', retryable: false},
		{name: 'HTTP 403', respond: async () => jsonResponse({detail: 'no'}, 403), code: 'auth', retryable: false},
		{name: 'HTTP 429', respond: async () => jsonResponse({detail: 'slow'}, 429), code: 'provider_busy', retryable: true},
		{name: 'HTTP 503', respond: async () => jsonResponse({detail: 'down'}, 503), code: 'provider_busy', retryable: true},
		{name: 'HTTP 422', respond: async () => jsonResponse({detail: 'bad size'}, 422), code: 'request_rejected', retryable: false},
		{name: 'a network error', respond: () => Promise.reject(TypeError('fetch failed')), code: 'network', retryable: true},
		{name: 'an empty image list', respond: async () => jsonResponse({images: []}), code: 'no_image', retryable: false},
	];

	for (const failure of failureCases) {
		test(`maps ${failure.name} to ${failure.code}`, async () => {
			const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-fail-'));
			await assert.rejects(
				falImageEngine.run({
					input: INPUT,
					ctx: contextFor(outDir, failure.respond),
				}),
				(error: unknown) =>
					isEngineFailure(error) &&
					error.code === failure.code &&
					error.retryable === failure.retryable,
			);
			await rm(outDir, {recursive: true, force: true});
		});
	}

	test('includes the provider detail for a rejected request', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-422-'));
		await assert.rejects(
			falImageEngine.run({
				input: INPUT,
				ctx: contextFor(outDir, async () => jsonResponse({detail: 'bad size'}, 422)),
			}),
			(error: unknown) =>
				error instanceof Error &&
				error.message === 'fal.ai rejected the request (HTTP 422): {"detail":"bad size"}',
		);
		await rm(outDir, {recursive: true, force: true});
	});

	test('maps a download failure the same way', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-dl-'));
		const fakeFetch: typeof fetch = async input =>
			String(input).startsWith('https://fal.run/')
				? jsonResponse({images: [{url: 'https://cdn.example/fox.png'}]})
				: new Response('gone', {status: 500});
		await assert.rejects(
			falImageEngine.run({input: INPUT, ctx: contextFor(outDir, fakeFetch)}),
			(error: unknown) => isEngineFailure(error) && error.code === 'provider_busy',
		);
		await rm(outDir, {recursive: true, force: true});
	});

	test('fails with auth and never calls fetch when FAL_KEY is missing', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-nokey-'));
		let calls = 0;
		const fakeFetch: typeof fetch = async () => {
			calls += 1;
			return jsonResponse({});
		};
		await assert.rejects(
			falImageEngine.run({input: INPUT, ctx: contextFor(outDir, fakeFetch, {})}),
			(error: unknown) => isEngineFailure(error) && error.code === 'auth',
		);
		assert.equal(calls, 0);
		await rm(outDir, {recursive: true, force: true});
	});

	test('lets a cancellation through instead of reporting a network fault', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-abort-'));
		const aborted = AbortSignal.abort();
		const fakeFetch: typeof fetch = () => Promise.reject(aborted.reason);
		await assert.rejects(
			falImageEngine.run({
				input: INPUT,
				ctx: {...contextFor(outDir, fakeFetch), signal: aborted},
			}),
			(error: unknown) => !isEngineFailure(error),
		);
		await rm(outDir, {recursive: true, force: true});
	});
});

describe('fal model ids', () => {
	const REJECTED = ['fal-ai/../../queue/cancel', 'a/../b', 'a/..', 'fal-ai//flux', 'fal-ai/flux/', '/fal-ai/flux', 'fal-ai/.hidden', 'fal-ai/flux.', 'fal-ai/%2e%2e/x', 'fal-ai/flux/a..b'];
	for (const model of REJECTED) {
		test(`rejects ${model}`, () => {
			assert.equal(parseFalImageInput({prompt: 'x', model}).ok, false);
		});
	}

	test('accepts dotted versions and nested names', () => {
		for (const model of ['fal-ai/flux-pro/v1.1', 'fal-ai/flux/schnell', 'fal-ai/flux-pro/v1.1-ultra']) {
			assert.equal(parseFalImageInput({prompt: 'x', model}).ok, true, model);
		}
	});
});

describe('falImageEngine bytes and addresses', () => {
	const respondWith = (image: () => Response, imageUrl = 'https://cdn.example/fox.png'): typeof fetch =>
		async input =>
			String(input).startsWith('https://fal.run/') ? jsonResponse({images: [{url: imageUrl}]}) : image();
	const bad = async (fakeFetch: typeof fetch): Promise<{code: string; message: string}> => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-bad-'));
		const error = await falImageEngine.run({input: INPUT, ctx: contextFor(outDir, fakeFetch)}).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		await rm(outDir, {recursive: true, force: true});
		assert.ok(isEngineFailure(error));
		return {code: error.code, message: error.message};
	};

	test('an empty body is a bad response', async () => {
		const result = await bad(respondWith(() => new Response(new Uint8Array(0), {headers: {'content-type': 'image/png'}})));
		assert.deepEqual(result, {code: 'bad_response', message: 'fal.ai returned data that is not a PNG, JPEG or WebP image.'});
	});

	test('text labelled image/png is a bad response', async () => {
		const result = await bad(respondWith(() => new Response('<html>captive portal</html>', {headers: {'content-type': 'image/png'}})));
		assert.equal(result.code, 'bad_response');
	});

	test('a WebP is accepted and saved as webp', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-webp-'));
		const outputs = await falImageEngine.run({
			input: INPUT,
			ctx: contextFor(outDir, respondWith(() => new Response(WEBP_BYTES, {headers: {'content-type': 'image/webp'}}))),
		});
		assert.equal(outputs[0]?.path, join(outDir, 'fal-image.webp'));
		await rm(outDir, {recursive: true, force: true});
	});

	test('an http image address is never fetched', async () => {
		const seen: string[] = [];
		const fakeFetch: typeof fetch = async input => {
			seen.push(String(input));
			return String(input).startsWith('https://fal.run/')
				? jsonResponse({images: [{url: 'http://169.254.169.254/latest/meta-data'}]})
				: new Response(PNG_BYTES, {headers: {'content-type': 'image/png'}});
		};
		const result = await bad(fakeFetch);
		assert.deepEqual(result, {code: 'bad_response', message: 'fal.ai answered with an image address that is not https, so it was not fetched.'});
		assert.deepEqual(seen, ['https://fal.run/fal-ai/flux/schnell']);
	});
});

describe('falImageEngine billing', () => {
	const FAL = falImageEngine as Engine;

	test('marks the run billed after the 2xx response and again with the image address', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-billed-'));
		const marks: (string | undefined)[] = [];
		const fakeFetch: typeof fetch = async input =>
			String(input).startsWith('https://fal.run/')
				? jsonResponse({images: [{url: 'https://cdn.example/fox.png'}]})
				: new Response(PNG_BYTES, {headers: {'content-type': 'image/png'}});
		await falImageEngine.run({
			input: INPUT,
			ctx: {...contextFor(outDir, fakeFetch), markBilled: result => marks.push(result?.url)},
		});
		assert.deepEqual(marks, [undefined, 'https://cdn.example/fox.png']);
		await rm(outDir, {recursive: true, force: true});
	});

	test('does not mark a request the provider rejected', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-unbilled-'));
		const marks: unknown[] = [];
		await assert.rejects(
			falImageEngine.run({
				input: INPUT,
				ctx: {...contextFor(outDir, async () => jsonResponse({detail: 'no'}, 422)), markBilled: result => marks.push(result)},
			}),
		);
		assert.deepEqual(marks, []);
		await rm(outDir, {recursive: true, force: true});
	});

	test('a billed run whose download fails ends uncertain and keeps the address', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'atelier-fal-job-'));
		const fakeFetch: typeof fetch = async input =>
			String(input).startsWith('https://fal.run/')
				? jsonResponse({images: [{url: 'https://cdn.example/fox.png'}]})
				: new Response('gone', {status: 503});
		const job = await runJob({
			cwd,
			sessionId: 's',
			engine: FAL,
			input: INPUT,
			title: 'Fox',
			exec: execFileExec,
			env: {FAL_KEY: 'k'},
			fetch: fakeFetch,
			signal: new AbortController().signal,
			now: () => 1000,
		});
		assert.equal(job.state, 'uncertain');
		assert.deepEqual(job.billedResult, {url: 'https://cdn.example/fox.png'});
		assert.deepEqual(job.error, {
			code: 'billed_incomplete',
			message:
				'The provider already billed this run, but it did not finish: fal.ai is busy or rate limited (HTTP 503). Try again shortly. Run atelier_create again with the same input to fetch the result without paying again.',
			retryable: false,
		});
		await rm(cwd, {recursive: true, force: true});
	});

	test('an abort after billing is uncertain, not cancelled', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'atelier-fal-abort-job-'));
		const controller = new AbortController();
		const fakeFetch: typeof fetch = async input => {
			if (String(input).startsWith('https://fal.run/')) return jsonResponse({images: [{url: 'https://cdn.example/fox.png'}]});
			controller.abort();
			throw controller.signal.reason;
		};
		const job = await runJob({
			cwd, sessionId: 's', engine: FAL, input: INPUT, title: 'Fox', exec: execFileExec,
			env: {FAL_KEY: 'k'}, fetch: fakeFetch, signal: controller.signal, now: () => 1000,
		});
		assert.equal(job.state, 'uncertain');
		assert.equal(job.error?.retryable, false);
		await rm(cwd, {recursive: true, force: true});
	});

	test('resume fetches the stored address and never calls the paid endpoint', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-resume-'));
		const seen: string[] = [];
		const fakeFetch: typeof fetch = async input => {
			seen.push(String(input));
			return new Response(PNG_BYTES, {headers: {'content-type': 'image/png'}});
		};
		const outputs = await falImageEngine.run({
			input: INPUT,
			ctx: {...contextFor(outDir, fakeFetch, {}), resume: {url: 'https://cdn.example/fox.png'}},
		});
		assert.deepEqual(seen, ['https://cdn.example/fox.png']);
		assert.equal(outputs[0]?.bytes, 12);
		await rm(outDir, {recursive: true, force: true});
	});
});
