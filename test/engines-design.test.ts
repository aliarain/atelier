import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {execFileExec, isEngineFailure} from '../src/exec.ts';
import {
	chromeCandidates,
	designEngine,
	parseDesignInput,
	wrapHtml,
} from '../src/engines/design.ts';
import type {Availability, EngineRunContext, Exec} from '../src/types.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const unreachableFetch: typeof fetch = () =>
	Promise.reject(Error('design must not use the network'));

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

const availability: Availability = await designEngine.available({
	exec: execFileExec,
	env: process.env,
});

describe('parseDesignInput', () => {
	test('applies the poster defaults', () => {
		assert.deepEqual(parseDesignInput({html: '<p>hi</p>'}), {
			ok: true,
			value: {html: '<p>hi</p>', width: 1080, height: 1350, scale: 1},
		});
	});

	test('accepts explicit size and scale', () => {
		assert.deepEqual(
			parseDesignInput({html: '<p>x</p>', width: 64, height: 4096, scale: 2}),
			{
				ok: true,
				value: {html: '<p>x</p>', width: 64, height: 4096, scale: 2},
			},
		);
	});

	test('rejects bad inputs with exact messages', () => {
		assert.deepEqual(parseDesignInput('nope'), {
			ok: false,
			error: 'input must be an object',
		});
		assert.deepEqual(parseDesignInput({}), {
			ok: false,
			error: 'html is required and must be a non-empty string',
		});
		assert.deepEqual(parseDesignInput({html: '   '}), {
			ok: false,
			error: 'html is required and must be a non-empty string',
		});
		assert.deepEqual(parseDesignInput({html: 'x'.repeat(400_001)}), {
			ok: false,
			error: 'html must be at most 400000 characters',
		});
		assert.deepEqual(parseDesignInput({html: 'x', width: 63}), {
			ok: false,
			error: 'width must be an integer from 64 to 4096',
		});
		assert.deepEqual(parseDesignInput({html: 'x', height: 4097}), {
			ok: false,
			error: 'height must be an integer from 64 to 4096',
		});
		assert.deepEqual(parseDesignInput({html: 'x', width: 100.5}), {
			ok: false,
			error: 'width must be an integer from 64 to 4096',
		});
		assert.deepEqual(parseDesignInput({html: 'x', scale: 3}), {
			ok: false,
			error: 'scale must be 1 or 2',
		});
	});

	test('accepts html at exactly the limit', () => {
		const parsed = parseDesignInput({html: 'x'.repeat(400_000)});
		assert.equal(parsed.ok, true);
	});
});

describe('wrapHtml', () => {
	test('leaves a full document untouched', () => {
		const doc = '<!DOCTYPE html><html><body>a</body></html>';
		assert.equal(wrapHtml(doc), doc);
		assert.equal(wrapHtml('<html lang="en"><body>a</body></html>'), '<html lang="en"><body>a</body></html>');
	});

	test('wraps a fragment in a zero margin page', () => {
		assert.equal(
			wrapHtml('<svg width="10" height="10"></svg>'),
			'<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body><svg width="10" height="10"></svg></body></html>',
		);
	});
});

describe('chromeCandidates', () => {
	const installed = [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
	];

	test('puts STUDIO_CHROME first when set', () => {
		assert.deepEqual(chromeCandidates({STUDIO_CHROME: '/opt/chrome'}), [
			'/opt/chrome',
			...installed,
		]);
	});

	test('lists only installed locations otherwise', () => {
		assert.deepEqual(chromeCandidates({}), installed);
		assert.deepEqual(chromeCandidates({STUDIO_CHROME: ''}), installed);
	});
});

describe('designEngine', () => {
	test('reports render_failed with the stderr tail when Chrome exits non-zero', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'studio-design-fail-'));
		const failingExec: Exec = async () => ({
			code: 1,
			stdout: '',
			stderr: 'first\nGPU process crashed',
		});
		await assert.rejects(
			designEngine.run({
				input: {html: '<p>x</p>', width: 200, height: 120, scale: 1},
				ctx: contextFor(outDir, {
					exec: failingExec,
					env: {STUDIO_CHROME: process.execPath},
				}),
			}),
			(error: unknown) =>
				isEngineFailure(error) &&
				error.code === 'render_failed' &&
				error.retryable &&
				error.message.includes('GPU process crashed'),
		);
		await rm(outDir, {recursive: true, force: true});
	});

	test(
		'renders a 200x120 red page to an exact-size PNG',
		{skip: !availability.ok},
		async () => {
			const outDir = await mkdtemp(join(tmpdir(), 'studio-design-'));
			const outputs = await designEngine.run({
				input: {
					html: '<body style="margin:0;background:#f00"><h1>Red</h1></body>',
					width: 200,
					height: 120,
					scale: 1,
				},
				ctx: contextFor(outDir),
			});

			const output = outputs[0];
			assert.equal(outputs.length, 1);
			assert.equal(output?.kind, 'image');
			assert.equal(output?.path, join(outDir, 'design.png'));

			const png = await readFile(join(outDir, 'design.png'));
			assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE);
			assert.equal(png.readUInt32BE(16), 200);
			assert.equal(png.readUInt32BE(20), 120);
			assert.equal(output?.bytes, png.length);

			assert.deepEqual((await readdir(outDir)).sort(), [
				'design.png',
				'source.html',
			]);
			await rm(outDir, {recursive: true, force: true});
		},
	);

	test(
		'doubles the pixel size at scale 2',
		{skip: !availability.ok},
		async () => {
			const outDir = await mkdtemp(join(tmpdir(), 'studio-design-2x-'));
			await designEngine.run({
				input: {
					html: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#00f"/></svg>',
					width: 200,
					height: 120,
					scale: 2,
				},
				ctx: contextFor(outDir),
			});
			const png = await readFile(join(outDir, 'design.png'));
			assert.equal(png.readUInt32BE(16), 400);
			assert.equal(png.readUInt32BE(20), 240);
			await rm(outDir, {recursive: true, force: true});
		},
	);
});
