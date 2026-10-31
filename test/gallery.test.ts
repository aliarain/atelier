import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseRange, renderIndexHtml, route, startGallery} from '../src/gallery.ts';

const TOKEN = 'secret-token';
const get = (url: string) => ({method: 'GET', url});

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
		assert.match(index.headers.get('content-security-policy') ?? '', /^default-src 'self'; img-src 'self'/);

		assert.equal((await fetch(`${base}/api/jobs`)).status, 403);
		assert.equal((await fetch(`${base}/media/${jobId}/red.png`)).status, 403);
		assert.equal((await fetch(`${base}/media/${jobId}/missing.png?t=${TOKEN}`)).status, 404);
	} finally {
		await gallery.close();
		rmSync(cwd, {recursive: true, force: true});
	}
});
