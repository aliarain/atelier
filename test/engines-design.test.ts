import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {execFileExec, isEngineFailure} from '../src/exec.ts';
import {
	chromeCandidates,
	classifyLayout,
	designEngine,
	parseDesignInput,
	parseLayoutDom,
	qaDocument,
	wrapHtml,
} from '../src/engines/design.ts';
import type {
	LayoutBox,
	LayoutRect,
	LayoutReport,
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
				'layout.json',
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

async function layoutOf(params: {
	readonly html: string;
	readonly width: number;
	readonly height: number;
}): Promise<LayoutReport> {
	const outDir = await mkdtemp(join(tmpdir(), 'studio-layout-'));
	await designEngine.run({
		input: {...params, scale: 1},
		ctx: contextFor(outDir),
	});
	const report: LayoutReport = JSON.parse(
		await readFile(join(outDir, 'layout.json'), 'utf8'),
	);
	await rm(outDir, {recursive: true, force: true});
	return report;
}

const HEADLINE = 'font:700 60px Helvetica;margin:0';

describe('layout check in Chrome', {skip: !availability.ok}, () => {
	test('a centered headline has no issues', async () => {
		const report = await layoutOf({
			html: '<body style="margin:0;width:1080px;height:1080px;display:flex;align-items:center;justify-content:center;font:700 80px Helvetica"><h1 style="margin:0">Launch week</h1></body>',
			width: 1080,
			height: 1080,
		});
		assert.deepEqual(report, {issues: [], checked: 1});
	});

	test('reports a no-wrap headline cut by overflow hidden', async () => {
		const report = await layoutOf({
			html: '<body style="margin:0"><div style="position:absolute;left:100px;top:400px;width:400px;overflow:hidden"><h1 style="margin:0;font:700 40px Helvetica;white-space:nowrap">Launch week is finally here</h1></div></body>',
			width: 1080,
			height: 1080,
		});
		assert.deepEqual(
			report.issues.map(issue => issue.kind),
			['clipped_text'],
		);
		assert.equal(report.issues[0]?.text, 'Launch week is finally here');
	});

	test('reports a heading pushed past the left edge', async () => {
		const report = await layoutOf({
			html: `<body style="margin:0"><h1 style="position:absolute;left:-200px;top:400px;${HEADLINE}">Launch week</h1></body>`,
			width: 1080,
			height: 1080,
		});
		assert.deepEqual(
			report.issues.map(issue => issue.kind),
			['off_canvas'],
		);
	});

	test('reports two headings stacked on top of each other', async () => {
		const report = await layoutOf({
			html: `<body style="margin:0"><h1 style="position:absolute;left:200px;top:400px;${HEADLINE}">Launch week</h1><h2 style="position:absolute;left:200px;top:400px;${HEADLINE}">Sale today</h2></body>`,
			width: 1080,
			height: 1080,
		});
		assert.deepEqual(
			report.issues.map(issue => issue.kind),
			['overlap'],
		);
		assert.deepEqual(report.issues[0]?.rect, {x: 200, y: 400, w: 300, h: 69});
	});

	test('reports text in the top of a 9:16 frame', async () => {
		const report = await layoutOf({
			html: `<body style="margin:0"><h1 style="position:absolute;left:100px;top:40px;${HEADLINE}">Launch week</h1></body>`,
			width: 1080,
			height: 1920,
		});
		assert.deepEqual(
			report.issues.map(issue => issue.kind),
			['safe_area'],
		);
	});

	test('lays the page out at the requested size, not the window size', async () => {
		const report = await layoutOf({
			html: `<body style="margin:0"><h1 style="position:absolute;left:90vw;top:50vh;${HEADLINE}">Launch week</h1></body>`,
			width: 1080,
			height: 1080,
		});
		assert.deepEqual(
			report.issues.map(issue => issue.kind),
			['off_canvas'],
		);
		assert.deepEqual(report.issues[0]?.rect, {x: 972, y: 540, w: 213, h: 138});
	});

	test('does not fail the render when the QA pass fails', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'studio-layout-qa-fail-'));
		const realExec = execFileExec;
		const qaFailsExec: Exec = params =>
			params.args.includes('--dump-dom')
				? Promise.resolve({code: 1, stdout: '', stderr: 'crashed'})
				: realExec(params);
		const outputs = await designEngine.run({
			input: {html: '<h1>Hi</h1>', width: 200, height: 120, scale: 1},
			ctx: contextFor(outDir, {exec: qaFailsExec}),
		});
		assert.equal(outputs.length, 1);
		assert.deepEqual((await readdir(outDir)).sort(), [
			'design.png',
			'source.html',
		]);
		await rm(outDir, {recursive: true, force: true});
	});
});

describe('classifyLayout', () => {
	const box = (
		id: number,
		rect: LayoutRect,
		overrides: Partial<LayoutBox> = {},
	): LayoutBox => ({
		id,
		ancestors: [],
		text: `text ${id}`,
		rect,
		clipped: false,
		decoration: false,
		...overrides,
	});
	const kinds = (report: LayoutReport): readonly string[] =>
		report.issues.map(issue => issue.kind);

	test('passes a box in the middle of the canvas', () => {
		assert.deepEqual(
			classifyLayout({
				width: 1000,
				height: 1000,
				boxes: [box(0, {x: 100, y: 400, w: 800, h: 100})],
			}),
			{issues: [], checked: 1},
		);
	});

	test('flags clipped text as given by the page', () => {
		const report = classifyLayout({
			width: 1000,
			height: 1000,
			boxes: [box(0, {x: 100, y: 400, w: 800, h: 100}, {clipped: true})],
		});
		assert.deepEqual(report.issues, [
			{kind: 'clipped_text', text: 'text 0', rect: {x: 100, y: 400, w: 800, h: 100}},
		]);
	});

	test('off_canvas tolerates 2px and no more, and replaces tight_edge', () => {
		const within = classifyLayout({
			width: 1000,
			height: 1000,
			boxes: [box(0, {x: -2, y: 400, w: 500, h: 100})],
		});
		assert.deepEqual(kinds(within), ['tight_edge']);
		const past = classifyLayout({
			width: 1000,
			height: 1000,
			boxes: [box(0, {x: -3, y: 400, w: 500, h: 100})],
		});
		assert.deepEqual(kinds(past), ['off_canvas']);
		const bottom = classifyLayout({
			width: 1000,
			height: 1000,
			boxes: [box(0, {x: 100, y: 903, w: 500, h: 100})],
		});
		assert.deepEqual(kinds(bottom), ['off_canvas']);
	});

	test('tight_edge triggers under 3% of the short side', () => {
		const tight = classifyLayout({
			width: 2000,
			height: 1000,
			boxes: [box(0, {x: 29, y: 400, w: 500, h: 100})],
		});
		assert.deepEqual(kinds(tight), ['tight_edge']);
		const clear = classifyLayout({
			width: 2000,
			height: 1000,
			boxes: [box(0, {x: 30, y: 400, w: 500, h: 100})],
		});
		assert.deepEqual(kinds(clear), []);
	});

	test('safe_area applies only to frames at 1.7 or taller', () => {
		const top = box(0, {x: 100, y: 100, w: 500, h: 100});
		assert.deepEqual(
			kinds(classifyLayout({width: 1000, height: 1700, boxes: [top]})),
			['safe_area'],
		);
		assert.deepEqual(
			kinds(classifyLayout({width: 1000, height: 1699, boxes: [top]})),
			[],
		);
		const bottom = box(0, {x: 100, y: 1500, w: 500, h: 100});
		assert.deepEqual(
			kinds(classifyLayout({width: 1000, height: 1920, boxes: [bottom]})),
			['safe_area'],
		);
		const middle = box(0, {x: 100, y: 900, w: 500, h: 100});
		assert.deepEqual(
			kinds(classifyLayout({width: 1000, height: 1920, boxes: [middle]})),
			[],
		);
	});

	test('overlap needs more than 25% of the smaller box', () => {
		const a = box(0, {x: 100, y: 400, w: 400, h: 100});
		const heavy = box(1, {x: 390, y: 400, w: 400, h: 100});
		const light = box(1, {x: 410, y: 400, w: 400, h: 100});
		const heavyReport = classifyLayout({width: 1000, height: 1000, boxes: [a, heavy]});
		assert.deepEqual(heavyReport.issues, [
			{kind: 'overlap', text: 'text 0', rect: {x: 390, y: 400, w: 110, h: 100}},
		]);
		assert.deepEqual(
			kinds(classifyLayout({width: 1000, height: 1000, boxes: [a, light]})),
			[],
		);
	});

	test('overlap ignores containment and faint decorations', () => {
		const parent = box(0, {x: 100, y: 400, w: 400, h: 100});
		const child = box(1, {x: 100, y: 400, w: 400, h: 100}, {ancestors: [0]});
		assert.deepEqual(
			kinds(classifyLayout({width: 1000, height: 1000, boxes: [parent, child]})),
			[],
		);
		const ghost = box(1, {x: 100, y: 400, w: 400, h: 100}, {decoration: true});
		assert.deepEqual(
			kinds(classifyLayout({width: 1000, height: 1000, boxes: [parent, ghost]})),
			[],
		);
	});

	test('drops zero-size boxes, truncates text and caps issues at 20', () => {
		const clippedBoxes = Array.from({length: 25}, (_, id) =>
			box(id, {x: 100, y: 400, w: 10, h: 10}, {clipped: true, text: 'x'.repeat(60)}),
		);
		const report = classifyLayout({
			width: 1000,
			height: 1000,
			boxes: [box(99, {x: 0, y: 0, w: 0, h: 10}), ...clippedBoxes],
		});
		assert.equal(report.checked, 25);
		assert.equal(report.issues.length, 20);
		assert.equal(report.issues[0]?.text, 'x'.repeat(40));
	});
});

describe('parseLayoutDom', () => {
	test('reads the measurement out of a dumped DOM', () => {
		const dom =
			'<html><body><script type="application/json" id="studio-layout">{"width":10,"height":10,"boxes":[{"id":0,"ancestors":[],"text":"a \\u003c/script>","rect":{"x":1,"y":2,"w":3,"h":4},"clipped":false,"decoration":false}]}</script></body></html>';
		assert.deepEqual(parseLayoutDom(dom), [
			{
				id: 0,
				ancestors: [],
				text: 'a </script>',
				rect: {x: 1, y: 2, w: 3, h: 4},
				clipped: false,
				decoration: false,
			},
		]);
	});

	test('returns undefined for a missing or malformed element', () => {
		assert.equal(parseLayoutDom('<html></html>'), undefined);
		assert.equal(
			parseLayoutDom('<script id="studio-layout">{nope</script>'),
			undefined,
		);
		assert.equal(
			parseLayoutDom('<script id="studio-layout">{"boxes":[{"id":"x"}]}</script>'),
			undefined,
		);
	});
});

describe('qaDocument', () => {
	test('frames source.html at the exact canvas size', () => {
		const html = qaDocument({width: 1080, height: 1920});
		assert.equal(
			html.startsWith(
				'<!doctype html><html><body style="margin:0"><iframe id="studio-frame" src="source.html" style="display:block;border:0;width:1080px;height:1920px"></iframe><script>',
			),
			true,
		);
		assert.equal(html.endsWith('</script></body></html>'), true);
	});
});
