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
import type {EngineRunContext} from '../src/types.ts';

const INPUT: FalImageInput = {
	prompt: 'a red fox',
	model: 'fal-ai/flux/schnell',
	image_size: 'portrait_4_3',
};

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

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
			{path: join(outDir, 'fal-image.png'), kind: 'image', bytes: 8},
		]);
		assert.deepEqual([...(await readFile(join(outDir, 'fal-image.png')))], [...PNG_BYTES]);
		assert.deepEqual(seen, [
			{url: 'https://fal.run/fal-ai/flux/schnell', method: 'POST', auth: 'Key secret-key', signal: true},
			{url: 'https://cdn.example/fox.png', method: 'GET', auth: null, signal: true},
		]);
		await rm(outDir, {recursive: true, force: true});
	});

	test('uses the downloaded content type for the extension', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-fal-jpg-'));
		const fakeFetch: typeof fetch = async input =>
			String(input).startsWith('https://fal.run/')
				? jsonResponse({images: [{url: 'https://cdn.example/fox'}]})
				: new Response(PNG_BYTES, {headers: {'content-type': 'image/jpeg'}});
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
