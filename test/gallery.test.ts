import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {parseRange, route, startGallery} from '../src/gallery.ts';
import {PAGE_HELPERS, PAGE_STYLE, renderIndexHtml} from '../src/gallery-page.ts';

const TOKEN = 'secret-token';

interface PageJob {
	readonly state: string;
	readonly engine?: string;
	readonly outputs?: readonly {readonly kind: string}[];
}

interface PageHelpers {
	readonly countText: (jobs: readonly PageJob[], filter?: string) => string;
	readonly statusIcon: (state: string) => string;
	readonly ago: (ms: number, nowMs: number) => string;
	readonly jobKind: (job: PageJob) => string | null;
	readonly jobsFor: (jobs: readonly PageJob[], filter: string) => readonly PageJob[];
	readonly filterCounts: (jobs: readonly PageJob[]) => Readonly<Record<string, number>>;
	readonly visibleFilters: (counts: Readonly<Record<string, number>>, selected: string) => readonly string[];
	readonly parseFilter: (value: unknown) => string | null;
	readonly emptyText: (filter: string) => string;
}

const helpers = runInNewContext(
	`${PAGE_HELPERS};({countText, statusIcon, ago, jobKind, jobsFor, filterCounts, visibleFilters, parseFilter, emptyText})`,
) as PageHelpers;
const jobsIn = (...states: readonly string[]): readonly PageJob[] =>
	states.map(state => ({state}));
const get = (url: string) => ({method: 'GET', url});
const post = (url: string) => ({method: 'POST', url});

test('route serves the index with a valid token', () => {
	assert.deepEqual(route(get(`/?t=${TOKEN}`), TOKEN), {kind: 'index'});
});

test('route serves the jobs list with a valid token', () => {
	assert.deepEqual(route(get(`/api/jobs?t=${TOKEN}`), TOKEN), {kind: 'jobs'});
});

test('route returns a media decision for a clean job id and file', () => {
	assert.deepEqual(route(get(`/media/abc-1/poster.png?t=${TOKEN}`), TOKEN), {
		kind: 'media',
		jobId: 'abc-1',
		file: 'poster.png',
	});
});

test('route rejects a missing or wrong token with 403 on every path', () => {
	const forbidden = {kind: 'reject', status: 403};
	assert.deepEqual(route(get('/'), TOKEN), forbidden);
	assert.deepEqual(route(get('/?t=nope'), TOKEN), forbidden);
	assert.deepEqual(route(get('/api/jobs'), TOKEN), forbidden);
	assert.deepEqual(route(get('/media/abc/x.png?t='), TOKEN), forbidden);
	assert.deepEqual(route(get('/nowhere'), TOKEN), forbidden);
});

test('route rejects an encoded traversal with 404', () => {
	assert.deepEqual(
		route(get(`/media/abc/..%2F..%2Fetc?t=${TOKEN}`), TOKEN),
		{kind: 'reject', status: 404},
	);
});

test('route rejects dotfiles and dot segments with 404', () => {
	const notFound = {kind: 'reject', status: 404};
	assert.deepEqual(route(get(`/media/abc/.env?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route(get(`/media/abc/..?t=${TOKEN}`), TOKEN), notFound);
});

test('route rejects a bad job id with 404', () => {
	const notFound = {kind: 'reject', status: 404};
	assert.deepEqual(route(get(`/media/ABC/x.png?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route(get(`/media/a_b/x.png?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route(get(`/media/%2e%2e/x.png?t=${TOKEN}`), TOKEN), notFound);
});

test('route rejects unknown paths and non-GET methods with 404', () => {
	const notFound = {kind: 'reject', status: 404};
	assert.deepEqual(route(get(`/other?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route({method: 'POST', url: `/?t=${TOKEN}`}, TOKEN), notFound);
	assert.deepEqual(route(get(`/media/abc?t=${TOKEN}`), TOKEN), notFound);
});

test('route accepts POST /api/action only with a valid token', () => {
	assert.deepEqual(route(post(`/api/action?t=${TOKEN}`), TOKEN), {kind: 'action'});
	assert.deepEqual(route(post('/api/action'), TOKEN), {kind: 'reject', status: 403});
	assert.deepEqual(route(post('/api/action?t=nope'), TOKEN), {kind: 'reject', status: 403});
});

test('route rejects every other POST, and a GET of the action path, with 404', () => {
	const notFound = {kind: 'reject', status: 404};
	assert.deepEqual(route(post(`/api/jobs?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route(post(`/media/abc/x.png?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route(post(`/api/action/extra?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route(get(`/api/action?t=${TOKEN}`), TOKEN), notFound);
	assert.deepEqual(route({method: 'PUT', url: `/api/action?t=${TOKEN}`}, TOKEN), notFound);
	assert.deepEqual(route({method: 'DELETE', url: `/api/action?t=${TOKEN}`}, TOKEN), notFound);
});

test('parseRange handles open, closed, suffix and impossible ranges', () => {
	assert.deepEqual(parseRange('bytes=0-7', 100), {kind: 'partial', start: 0, end: 7});
	assert.deepEqual(parseRange('bytes=90-', 100), {kind: 'partial', start: 90, end: 99});
	assert.deepEqual(parseRange('bytes=-10', 100), {kind: 'partial', start: 90, end: 99});
	assert.deepEqual(parseRange('bytes=0-999', 100), {kind: 'partial', start: 0, end: 99});
	assert.deepEqual(parseRange('bytes=100-', 100), {kind: 'unsatisfiable'});
	assert.deepEqual(parseRange('bytes=0-1,5-6', 100), {kind: 'full'});
	assert.deepEqual(parseRange(undefined, 100), {kind: 'full'});
});

test('the index page carries the title, the empty state and no dashes in its text', () => {
	const html = renderIndexHtml('a</script>b');
	assert.match(html, /<title>Studio<\/title>/);
	assert.match(html, /Nothing made yet\. Ask for a poster, a voiceover or a short video\./);
	assert.doesNotMatch(html, /[–—]/);
	assert.ok(!html.includes('a</script>b'), 'token cannot close the script element');
});

test('countText only says what is true', () => {
	assert.equal(helpers.countText([]), '');
	assert.equal(helpers.countText(jobsIn('completed')), '1 render');
	assert.equal(helpers.countText(jobsIn('completed', 'failed', 'cancelled', 'uncertain')), '4 renders');
	assert.equal(helpers.countText(jobsIn('running')), '1 render, 1 rendering');
	assert.equal(
		helpers.countText(jobsIn('running', 'completed', 'completed', 'completed')),
		'4 renders, 1 rendering',
	);
	assert.equal(
		helpers.countText(jobsIn('queued', 'running', 'completed')),
		'3 renders, 2 rendering',
	);
});

const made = (engine: string, state: string, ...kinds: readonly string[]): PageJob => ({
	engine,
	state,
	outputs: kinds.map(kind => ({kind})),
});

test('a job is filed by its first output, or by its engine while it renders', () => {
	assert.equal(helpers.jobKind(made('video', 'completed', 'video', 'image')), 'video');
	assert.equal(helpers.jobKind(made('design', 'completed', 'image')), 'image');
	assert.equal(helpers.jobKind(made('voice', 'completed', 'audio')), 'audio');
	assert.equal(helpers.jobKind(made('design', 'running')), 'image');
	assert.equal(helpers.jobKind(made('fal-image', 'running')), 'image');
	assert.equal(helpers.jobKind(made('video', 'running')), 'video');
	assert.equal(helpers.jobKind(made('motion', 'running')), 'video');
	assert.equal(helpers.jobKind(made('voice', 'queued')), 'audio');
	assert.equal(helpers.jobKind(made('mystery', 'running')), null);
});

const library = [
	made('design', 'completed', 'image'),
	made('design', 'completed', 'image'),
	made('video', 'completed', 'video'),
	made('motion', 'running'),
	made('mystery', 'running'),
];

test('filters count and narrow the jobs, and unknown engines only show under All', () => {
	assert.deepEqual({...helpers.filterCounts(library)}, {all: 5, image: 2, video: 2, audio: 0});
	assert.equal(helpers.jobsFor(library, 'all').length, 5);
	assert.equal(helpers.jobsFor(library, 'video').length, 2);
	assert.equal(helpers.jobsFor(library, 'audio').length, 0);
});

test('a segment with no jobs is hidden unless it is selected', () => {
	const counts = helpers.filterCounts(library);
	assert.deepEqual([...helpers.visibleFilters(counts, 'all')], ['all', 'image', 'video']);
	assert.deepEqual([...helpers.visibleFilters(counts, 'audio')], ['all', 'image', 'video', 'audio']);
});

test('the filter comes from an address value in plural or singular, or not at all', () => {
	assert.equal(helpers.parseFilter('videos'), 'video');
	assert.equal(helpers.parseFilter('Images'), 'image');
	assert.equal(helpers.parseFilter('audio'), 'audio');
	assert.equal(helpers.parseFilter('all'), 'all');
	assert.equal(helpers.parseFilter('docs'), null);
	assert.equal(helpers.parseFilter(null), null);
});

test('the header count stays true for the current filter', () => {
	assert.equal(helpers.countText(library, 'all'), '5 renders, 2 rendering');
	assert.equal(helpers.countText(library, 'image'), '2 images');
	assert.equal(helpers.countText(library, 'video'), '2 videos, 1 rendering');
	assert.equal(helpers.countText([made('video', 'completed', 'video')], 'video'), '1 video');
	assert.equal(helpers.countText(library, 'audio'), '');
});

test('an empty filter says what is missing', () => {
	assert.equal(helpers.emptyText('video'), 'No videos yet.');
	assert.equal(helpers.emptyText('image'), 'No images yet.');
	assert.equal(helpers.emptyText('audio'), 'No audio yet.');
});

test('the page text has no dashes, hides its title when embedded and posts actions to the gallery', () => {
	const html = renderIndexHtml(TOKEN);
	assert.match(html, /getPropertyValue\('--cc-bg'\)/);
	assert.match(html, /\.embedded header \.mark,\.embedded h1\{display:none\}/);
	assert.match(html, /'\/api\/action\?t=' \+ encodeURIComponent\(TOKEN\)/);
	for (const label of ['Variant', 'Show in Finder', 'Mark shown']) {
		assert.ok(html.includes(`'${label}'`), `${label} action is offered`);
	}
	assert.doesNotMatch(html, /[–—]/);
});

test('every job state maps to its status icon', () => {
	assert.equal(helpers.statusIcon('queued'), 'spinner');
	assert.equal(helpers.statusIcon('running'), 'spinner');
	assert.equal(helpers.statusIcon('completed'), 'check');
	assert.equal(helpers.statusIcon('failed'), 'cross');
	assert.equal(helpers.statusIcon('uncertain'), 'cross');
	assert.equal(helpers.statusIcon('cancelled'), 'dash');
});

test('relative times read as the tile meta shows them', () => {
	const t = 1_000_000_000;
	assert.equal(helpers.ago(t, t + 2_000), 'just now');
	assert.equal(helpers.ago(t, t + 30_000), '30s ago');
	assert.equal(helpers.ago(t, t + 180_000), '3m ago');
	assert.equal(helpers.ago(t, t + 3_600_000), '1h ago');
	assert.equal(helpers.ago(t, t + 3 * 86_400_000), '3d ago');
});

test('the page draws every color from the cc contract with Shades of Purple fallbacks', () => {
	for (const literal of [
		'var(--cc-bg,#222244)',
		'var(--cc-surface,#1E1E3F)',
		'var(--cc-surface-deep,#161633)',
		'var(--cc-fg,#FFFFFF)',
		'var(--cc-muted,#A599E9)',
		'var(--cc-accent,#FAD000)',
		'var(--cc-border,rgba(165,153,233,.11))',
		'var(--cc-border-strong,rgba(165,153,233,.22))',
		'var(--cc-info,#9EFFFF)',
		'var(--cc-danger,#EC3A37)',
		'var(--cc-radius,10px)',
		'var(--cc-font-ui,system-ui,-apple-system,sans-serif)',
	]) {
		assert.ok(PAGE_STYLE.includes(literal), `style uses ${literal}`);
	}
	assert.doesNotMatch(PAGE_STYLE, /#(?:111214|1a1b1e|2a2c31)/i);
	assert.match(PAGE_STYLE, /user-select:none/);
});

test('the page is two columns, one when narrow and three when wide', () => {
	assert.match(PAGE_STYLE, /#grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
	assert.match(PAGE_STYLE, /@media \(max-width:419px\)\{#grid\{grid-template-columns:minmax\(0,1fr\)\}\}/);
	assert.match(PAGE_STYLE, /@media \(min-width:900px\)\{#grid\{grid-template-columns:repeat\(3,/);
});

test('the rendered page has no em or en dashes, no Live badge and no data innerHTML', () => {
	const html = renderIndexHtml(TOKEN);
	assert.doesNotMatch(html, /[–—]/);
	assert.doesNotMatch(html, /Live/);
	assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('the gallery lists jobs and serves media with ranges and a token gate', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'studio-gallery-'));
	const jobId = 'abc123-def';
	const outDir = join(cwd, '.studio', 'out', jobId);
	mkdirSync(outDir, {recursive: true});
	mkdirSync(join(cwd, '.studio', 'jobs'), {recursive: true});
	const png = join(outDir, 'red.png');
	execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', png]);
	writeFileSync(join(outDir, 'source.html'), '<script>alert(1)</script>');
	writeFileSync(
		join(cwd, '.studio', 'jobs', `${jobId}.json`),
		JSON.stringify({
			id: jobId,
			sessionId: 's',
			engine: 'ffmpeg',
			title: 'Red square',
			input: {},
			state: 'completed',
			paid: false,
			ownerPid: 1,
			createdAt: 1000,
			updatedAt: 2000,
			outputs: [{path: png, kind: 'image', bytes: 1}],
			presented: true,
		}),
	);
	const gallery = await startGallery({cwd, token: TOKEN});
	try {
		assert.equal(gallery.url, `http://127.0.0.1:${gallery.port}/?t=${TOKEN}`);
		const base = `http://127.0.0.1:${gallery.port}`;

		const listing = await fetch(`${base}/api/jobs?t=${TOKEN}`);
		assert.equal(listing.status, 200);
		assert.equal(listing.headers.get('cache-control'), 'no-store');
		const jobs = (await listing.json()) as readonly {
			readonly id: string;
			readonly presented: boolean;
			readonly outputs: readonly {readonly url: string}[];
		}[];
		assert.equal(jobs.length, 1);
		assert.equal(jobs[0]?.id, jobId);
		assert.equal(jobs[0]?.presented, true);
		const mediaUrl = jobs[0]?.outputs[0]?.url;
		assert.equal(mediaUrl, `/media/${jobId}/red.png?t=${TOKEN}`);

		const media = await fetch(`${base}${mediaUrl}`);
		assert.equal(media.status, 200);
		assert.equal(media.headers.get('content-type'), 'image/png');
		assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
		const body = Buffer.from(await media.arrayBuffer());
		assert.deepEqual([...body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

		const ranged = await fetch(`${base}${mediaUrl}`, {headers: {Range: 'bytes=0-7'}});
		assert.equal(ranged.status, 206);
		assert.equal((await ranged.arrayBuffer()).byteLength, 8);
		assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${body.length}`);

		const source = await fetch(`${base}/media/${jobId}/source.html?t=${TOKEN}`);
		assert.equal(source.headers.get('content-type'), 'text/plain; charset=utf-8');

		const index = await fetch(gallery.url);
		assert.equal(index.status, 200);
		const csp = index.headers.get('content-security-policy') ?? '';
		assert.match(csp, /^default-src 'self'; img-src 'self'/);
		assert.ok(csp.includes("font-src 'self' data:"), 'the injected data: fonts can load');

		assert.equal((await fetch(`${base}/api/jobs`)).status, 403);
		assert.equal((await fetch(`${base}/media/${jobId}/red.png`)).status, 403);
		assert.equal((await fetch(`${base}/media/${jobId}/missing.png?t=${TOKEN}`)).status, 404);
	} finally {
		await gallery.close();
		rmSync(cwd, {recursive: true, force: true});
	}
});

interface ActionCall {
	readonly action: string;
	readonly jobId: string;
}

function seedJob(cwd: string, id: string): void {
	mkdirSync(join(cwd, '.studio', 'jobs'), {recursive: true});
	writeFileSync(
		join(cwd, '.studio', 'jobs', `${id}.json`),
		JSON.stringify({
			id,
			sessionId: 's',
			engine: 'design',
			title: 'Poster',
			input: {},
			state: 'completed',
			paid: false,
			ownerPid: 1,
			createdAt: 1000,
			updatedAt: 2000,
			outputs: [{path: join(cwd, 'poster.png'), kind: 'image', bytes: 1}],
			presented: false,
		}),
	);
}

test('POST /api/action hands a validated action and its job to the mod and relays the answer', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'studio-actions-'));
	seedJob(cwd, 'job-1');
	const calls: ActionCall[] = [];
	const gallery = await startGallery({
		cwd,
		token: TOKEN,
		onAction: async ({action, job}) => {
			calls.push({action, jobId: job.id});
			return {ok: action !== 'reveal', message: `did ${action}`};
		},
	});
	const send = (body: string, token = TOKEN): Promise<Response> =>
		fetch(`http://127.0.0.1:${gallery.port}/api/action?t=${token}`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body,
		});
	try {
		for (const action of ['variant', 'reveal', 'present']) {
			const res = await send(JSON.stringify({action, jobId: 'job-1'}));
			assert.equal(res.status, 200, action);
			assert.deepEqual(await res.json(), {ok: action !== 'reveal', message: `did ${action}`});
		}
		assert.deepEqual(calls, [
			{action: 'variant', jobId: 'job-1'},
			{action: 'reveal', jobId: 'job-1'},
			{action: 'present', jobId: 'job-1'},
		]);

		const before = calls.length;
		assert.equal((await send(JSON.stringify({action: 'delete', jobId: 'job-1'}))).status, 400);
		assert.equal((await send(JSON.stringify({action: 'variant', jobId: '../x'}))).status, 400);
		assert.equal((await send(JSON.stringify({action: 'variant'}))).status, 400);
		assert.equal((await send('not json')).status, 400);
		assert.equal((await send('null')).status, 400);
		assert.equal((await send(JSON.stringify({action: 'variant', jobId: 'nope-9'}))).status, 404);
		assert.equal((await send(JSON.stringify({action: 'variant', jobId: 'job-1'}), 'wrong')).status, 403);
		assert.equal(calls.length, before, 'rejected requests never reach the mod');

		const oversized = await send(JSON.stringify({action: 'variant', jobId: 'job-1', pad: 'x'.repeat(5000)}));
		assert.equal(oversized.status, 413);
		assert.equal(calls.length, before);

		const other = await fetch(`http://127.0.0.1:${gallery.port}/api/jobs?t=${TOKEN}`, {method: 'POST'});
		assert.equal(other.status, 404);
	} finally {
		await gallery.close();
		rmSync(cwd, {recursive: true, force: true});
	}
});

test('a throwing action handler answers with a failed result, not a crash', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'studio-actions-'));
	seedJob(cwd, 'job-1');
	const gallery = await startGallery({
		cwd,
		token: TOKEN,
		onAction: () => Promise.reject(new Error('boom')),
	});
	try {
		const res = await fetch(`http://127.0.0.1:${gallery.port}/api/action?t=${TOKEN}`, {
			method: 'POST',
			body: JSON.stringify({action: 'present', jobId: 'job-1'}),
		});
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {ok: false, message: 'That did not work. Try again.'});
	} finally {
		await gallery.close();
		rmSync(cwd, {recursive: true, force: true});
	}
});

test('without an action handler the action path is not found', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'studio-actions-'));
	seedJob(cwd, 'job-1');
	const gallery = await startGallery({cwd, token: TOKEN});
	try {
		const res = await fetch(`http://127.0.0.1:${gallery.port}/api/action?t=${TOKEN}`, {
			method: 'POST',
			body: JSON.stringify({action: 'present', jobId: 'job-1'}),
		});
		assert.equal(res.status, 404);
	} finally {
		await gallery.close();
		rmSync(cwd, {recursive: true, force: true});
	}
});
