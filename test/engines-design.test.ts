import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {execFileExec, isEngineFailure} from '../src/exec.ts';
import {
	chromeCandidates,
	classifyLayout,
	designEngine,
	findChrome,
	parseDesignInput,
	parseLayoutDom,
	qaDocument,
	readPngSize,
	wrapHtml,
} from '../src/engines/design.ts';
import type {
	LayoutBox,
	LayoutRect,
	LayoutReport,
} from '../src/engines/design.ts';
import {runJob} from '../src/runner.ts';
import type {Availability, Engine, EngineRunContext} from '../src/types.ts';
import {isChromeAlive, leftoverProfiles, withIsolatedTmp} from './render-helpers.ts';

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

	test('puts ATELIER_CHROME first when set', () => {
		assert.deepEqual(chromeCandidates({ATELIER_CHROME:'/opt/chrome'}), [
			'/opt/chrome',
			...installed,
		]);
	});

	test('lists only installed locations otherwise', () => {
		assert.deepEqual(chromeCandidates({}), installed);
		assert.deepEqual(chromeCandidates({ATELIER_CHROME:''}), installed);
	});
});

describe('designEngine', () => {
	test('reports render_failed with the stderr tail when Chrome dies before it can render', async () => {
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-design-fail-'));
		const stub = join(outDir, 'chrome-stub');
		await writeFile(
			stub,
			'#!/bin/sh\necho first >&2\necho "GPU process crashed" >&2\nexit 1\n',
			{mode: 0o755},
		);
		await assert.rejects(
			designEngine.run({
				input: {html: '<p>x</p>', width: 200, height: 120, scale: 1},
				ctx: contextFor(outDir, {env: {ATELIER_CHROME: stub}}),
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
			const outDir = await mkdtemp(join(tmpdir(), 'atelier-design-'));
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
			const outDir = await mkdtemp(join(tmpdir(), 'atelier-design-2x-'));
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

// A page cannot hand data back, so a probe page writes its findings into a text box placed
// off the canvas. The layout check then reports that text as an off_canvas issue.
function probePage(script: string, markup = ''): string {
	return `<body style="margin:0"><div id="o" style="position:absolute;left:-900px;top:20px;white-space:nowrap;font:20px Helvetica">pending</div>${markup}<script>${script}</script></body>`;
}

async function probeText(params: {
	readonly html: string;
	readonly outDir: string;
	readonly overrides?: Partial<EngineRunContext>;
}): Promise<string | undefined> {
	await designEngine.run({
		input: {html: params.html, width: 400, height: 120, scale: 1},
		ctx: contextFor(params.outDir, params.overrides),
	});
	const report: LayoutReport = JSON.parse(
		await readFile(join(params.outDir, 'layout.json'), 'utf8'),
	);
	return report.issues.find(issue => issue.kind === 'off_canvas')?.text;
}

interface Listener {
	readonly port: number;
	readonly hits: readonly string[];
	readonly close: () => Promise<void>;
}

async function listen(): Promise<Listener> {
	const hits: string[] = [];
	const server = createServer((request, response) => {
		hits.push(request.url ?? '');
		response.writeHead(200, {'Access-Control-Allow-Origin': '*'});
		response.end('ok');
	});
	server.on('upgrade', (request, socket) => {
		hits.push(`upgrade ${request.url ?? ''}`);
		socket.destroy();
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as AddressInfo).port,
		hits,
		close: () =>
			new Promise<void>(resolve => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

describe('design sandbox', {skip: !availability.ok}, () => {
	test('a page cannot read a local file or send anything to another local port', async () => {
		await withIsolatedTmp(async root => {
			const dir = await mkdtemp(join(root, 'job-'));
			const secret = join(dir, 'secret.txt');
			await writeFile(secret, 'TOP-SECRET-DESIGN');
			const listener = await listen();
			const text = await probeText({
				outDir: dir,
				html: probePage(`
var r = 'file:blocked';
try {
  var x = new XMLHttpRequest();
  x.open('GET', 'file://${secret}', false);
  x.send();
  if (x.responseText) r = 'file:READ ' + x.responseText.slice(0, 17);
} catch (e) {}
document.getElementById('o').textContent = r;
var u = 'http://127.0.0.1:${listener.port}';
new Image().src = u + '/img';
fetch(u + '/fetch', {mode: 'no-cors'}).catch(function () {});
var s = document.createElement('script'); s.src = u + '/script.js'; document.head.appendChild(s);
try { new WebSocket('ws://127.0.0.1:${listener.port}/ws'); } catch (e) {}
navigator.sendBeacon(u + '/beacon', 'x');
window.open(u + '/popup');
`),
			});
			await sleep(500);
			await listener.close();
			assert.equal(text, 'file:blocked');
			assert.deepEqual(listener.hits, []);
			const written = [
				await readFile(join(dir, 'layout.json'), 'utf8'),
				await readFile(join(dir, 'source.html'), 'utf8'),
			].join('\n');
			assert.equal(written.includes('TOP-SECRET-DESIGN'), false);
			assert.deepEqual(await leftoverProfiles(root), []);
		});
	});

	test('an https image does not load', async () => {
		await withIsolatedTmp(async root => {
			const dir = await mkdtemp(join(root, 'job-'));
			const text = await probeText({
				outDir: dir,
				html: probePage(
					'',
					`<img src="https://example.com/logo.png" onerror="document.getElementById('o').textContent='https:blocked'" onload="document.getElementById('o').textContent='https:LOADED'">`,
				),
			});
			assert.equal(text, 'https:blocked');
		});
	});

	test('an earlier output loads from /out/<jobId>/<file>', async () => {
		await withIsolatedTmp(async root => {
			const project = await mkdtemp(join(root, 'project-'));
			const earlier = join(project, '.atelier', 'out', 'job-1');
			await mkdir(earlier, {recursive: true});
			await designEngine.run({
				input: {
					html: '<body style="margin:0;background:#00f"></body>',
					width: 200,
					height: 120,
					scale: 1,
				},
				ctx: contextFor(earlier, {cwd: project}),
			});
			const outDir = join(project, '.atelier', 'out', 'job-2');
			await mkdir(outDir, {recursive: true});
			const text = await probeText({
				outDir,
				overrides: {cwd: project},
				html: probePage(
					'',
					`<img src="/out/job-1/design.png" style="display:block;width:100%;height:100%" onerror="document.getElementById('o').textContent='img:failed'" onload="document.getElementById('o').textContent='img:'+this.naturalWidth+'x'+this.naturalHeight">`,
				),
			});
			assert.equal(text, 'img:200x120');
		});
	});

	test('only earlier media outputs are served, never other files or folders', async () => {
		await withIsolatedTmp(async root => {
			const project = await mkdtemp(join(root, 'project-'));
			const earlier = join(project, '.atelier', 'out', 'job-1');
			await mkdir(earlier, {recursive: true});
			await designEngine.run({
				input: {html: '<body style="background:#0a0"></body>', width: 64, height: 64, scale: 1},
				ctx: contextFor(earlier, {cwd: project}),
			});
			const real = await readFile(join(earlier, 'design.png'));
			await writeFile(join(earlier, 'ok.png'), real);
			await writeFile(join(earlier, '.hidden.png'), real);
			await writeFile(join(earlier, 'disguised.json'), real);
			await writeFile(join(project, 'outside.png'), real);
			await symlink(join(project, 'outside.png'), join(earlier, 'link.png'));
			const outDir = join(project, '.atelier', 'out', 'job-2');
			await mkdir(outDir, {recursive: true});
			const probe = (path: string): string =>
				`var i = new Image(); i.onload = function () { document.getElementById('o').textContent += ' ${path}'; }; i.src = '${path}';`;
			const paths = [
				'/out/job-1/ok.png',
				'/out/job-1/link.png',
				'/out/job-1/.hidden.png',
				'/out/job-1/disguised.json',
				'/out/job-1/../../../outside.png',
				'/out/job-9/ok.png',
			];
			const text = await probeText({
				outDir,
				overrides: {cwd: project},
				html: probePage(paths.map(probe).join('\n')),
			});
			assert.equal(text, 'pending /out/job-1/ok.png');
		});
	});

	test('succeeds when Chrome exits non-zero after the capture', async () => {
		await withIsolatedTmp(async root => {
			const dir = await mkdtemp(join(root, 'job-'));
			const real = await findChrome(process.env);
			const wrapper = join(dir, 'chrome-wrapper');
			await writeFile(
				wrapper,
				`#!/bin/sh\n"${real}" "$@" &\nchild=$!\ntrap 'kill -TERM $child 2>/dev/null; wait $child; exit 3' TERM\nwait $child\nexit 3\n`,
				{mode: 0o755},
			);
			const outputs = await designEngine.run({
				input: {html: '<h1>Hi</h1>', width: 200, height: 120, scale: 1},
				ctx: contextFor(dir, {env: {...process.env, ATELIER_CHROME: wrapper}}),
			});
			assert.equal(outputs.length, 1);
			const png = await readFile(join(dir, 'design.png'));
			assert.deepEqual(readPngSize(png), {width: 200, height: 120});
			assert.deepEqual(await leftoverProfiles(root), []);
		});
	});

	test('renders when the project path contains percent signs', async () => {
		await withIsolatedTmp(async root => {
			const project = join(root, '100% x%05dy %d');
			const outDir = join(project, '.atelier', 'out', 'job-1');
			await mkdir(outDir, {recursive: true});
			await designEngine.run({
				input: {html: '<h1>Hi</h1>', width: 200, height: 120, scale: 2},
				ctx: contextFor(outDir, {cwd: project}),
			});
			const png = await readFile(join(outDir, 'design.png'));
			assert.deepEqual(readPngSize(png), {width: 400, height: 240});
		});
	});

	test('cancelling during the layout pass stops the run and leaves no profile behind', async () => {
		await withIsolatedTmp(async root => {
			const dir = await mkdtemp(join(root, 'job-'));
			const controller = new AbortController();
			const slowInQa =
				'<h1>Hi</h1><script>if (parent !== window) { var end = Date.now() + 5000; while (Date.now() < end) {} }</script>';
			const settled = designEngine
				.run({
					input: {html: slowInQa, width: 200, height: 120, scale: 1},
					ctx: contextFor(dir, {signal: controller.signal}),
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			for (let tries = 0; tries < 400; tries += 1) {
				if ((await readdir(dir)).includes('design.png')) break;
				await sleep(10);
			}
			assert.equal((await readdir(dir)).includes('design.png'), true, 'the shot comes before the layout pass');
			controller.abort();
			const error = await settled;
			assert.equal((error as {name?: string} | undefined)?.name, 'AbortError');
			assert.equal(await isChromeAlive(root), false);
			assert.deepEqual(await leftoverProfiles(root), []);
			assert.deepEqual(
				(await readdir(dir)).filter(name => name.startsWith('.chrome')),
				[],
			);
		});
	});

	test('a cancelled design job is recorded as cancelled', async () => {
		await withIsolatedTmp(async root => {
			const project = await mkdtemp(join(root, 'project-'));
			const controller = new AbortController();
			const slowInQa =
				'<h1>Hi</h1><script>if (parent !== window) { var end = Date.now() + 5000; while (Date.now() < end) {} }</script>';
			const parsed = designEngine.parse({html: slowInQa, width: 200, height: 120});
			assert.equal(parsed.ok, true);
			const running = runJob({
				cwd: project,
				sessionId: 's',
				engine: designEngine as Engine,
				input: (parsed as {value: unknown}).value,
				title: 't',
				exec: execFileExec,
				env: process.env,
				fetch: unreachableFetch,
				signal: controller.signal,
				now: Date.now,
			});
			const outRoot = join(project, '.atelier', 'out');
			for (let tries = 0; tries < 400; tries += 1) {
				const ids = await readdir(outRoot).catch(() => []);
				const files = ids[0] === undefined ? [] : await readdir(join(outRoot, ids[0]));
				if (files.includes('design.png')) break;
				await sleep(10);
			}
			controller.abort();
			const job = await running;
			assert.equal(job.state, 'cancelled');
			assert.equal(job.error?.code, 'cancelled');
			assert.deepEqual(await leftoverProfiles(root), []);
		});
	});
});

describe('readPngSize', () => {
	test('reads the size of a PNG header and nothing else', () => {
		const header = Buffer.alloc(24);
		Buffer.from(PNG_SIGNATURE).copy(header);
		header.writeUInt32BE(13, 8);
		header.write('IHDR', 12, 'latin1');
		header.writeUInt32BE(640, 16);
		header.writeUInt32BE(480, 20);
		assert.deepEqual(readPngSize(header), {width: 640, height: 480});
		assert.equal(readPngSize(Buffer.from('<html>not a png at all, sorry</html>')), undefined);
		assert.equal(readPngSize(header.subarray(0, 20)), undefined);
		header.write('IDAT', 12, 'latin1');
		assert.equal(readPngSize(header), undefined);
	});
});

async function layoutOf(params: {
	readonly html: string;
	readonly width: number;
	readonly height: number;
}): Promise<LayoutReport> {
	const outDir = await mkdtemp(join(tmpdir(), 'atelier-layout-'));
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
		assert.deepEqual(report.issues[0]?.rect, {x: 200, y: 405, w: 300, h: 60});
	});

	test('tight display leading under a kicker is not an overlap', async () => {
		const report = await layoutOf({
			html: `<body style="margin:0;padding:200px 120px"><div style="font:600 14px Helvetica;letter-spacing:.42em;text-transform:uppercase">New for autumn</div><h1 style="font:400 123px Didot,Georgia,serif;margin:10px 0 0"><span style="display:block;line-height:.94">Fall</span><span style="display:block;line-height:.94;font-style:italic">Menu</span></h1></body>`,
			width: 1080,
			height: 1080,
		});
		assert.deepEqual(report.issues, []);
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
		const outDir = await mkdtemp(join(tmpdir(), 'atelier-layout-qa-fail-'));
		const poisonsTheMeasurement =
			'<h1>Hi</h1><script>if (parent !== window) parent.Map.prototype.has = function () { throw Error("boom"); };</script>';
		const outputs = await designEngine.run({
			input: {html: poisonsTheMeasurement, width: 200, height: 120, scale: 1},
			ctx: contextFor(outDir),
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
			'<html><body><script type="application/json" id="atelier-layout">{"width":10,"height":10,"boxes":[{"id":0,"ancestors":[],"text":"a \\u003c/script>","rect":{"x":1,"y":2,"w":3,"h":4},"clipped":false,"decoration":false}]}</script></body></html>';
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
			parseLayoutDom('<script id="atelier-layout">{nope</script>'),
			undefined,
		);
		assert.equal(
			parseLayoutDom('<script id="atelier-layout">{"boxes":[{"id":"x"}]}</script>'),
			undefined,
		);
	});
});

describe('qaDocument', () => {
	test('frames source.html at the exact canvas size', () => {
		const html = qaDocument({width: 1080, height: 1920});
		assert.equal(
			html.startsWith(
				'<!doctype html><html><body style="margin:0"><iframe id="atelier-frame" src="source.html" style="display:block;border:0;width:1080px;height:1920px"></iframe><script>',
			),
			true,
		);
		assert.equal(html.endsWith('</script></body></html>'), true);
	});
});
