import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer, request} from 'node:http';
import type {AddressInfo} from 'node:net';
import {connect} from 'node:net';
import {mkdir, mkdtemp, readdir, rm, symlink, writeFile} from 'node:fs/promises';

import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {withChrome} from '../src/engines/chrome-session.ts';
import {findChrome} from '../src/engines/design.ts';
import {
	decideRequest,
	routeSandbox,
	startRenderSandbox,
} from '../src/engines/render-sandbox.ts';
import type {RenderSandbox} from '../src/engines/render-sandbox.ts';
import {isChromeAlive, leftoverProfiles, withIsolatedTmp} from './render-helpers.ts';

const chrome = await findChrome(process.env);
const live = chrome === undefined ? {skip: 'Chrome is not installed'} : {};

const ORIGIN = 'http://127.0.0.1:4000';
const TOKEN = 'tok';
const DOCS = ['source.html', 'qa.html'] as const;

const route = (url: string, method = 'GET'): ReturnType<typeof routeSandbox> =>
	routeSandbox({method, url, token: TOKEN, documents: DOCS});

describe('routeSandbox', () => {
	test('serves the named documents under the token and nothing else at that depth', () => {
		assert.deepEqual(route('/tok/source.html'), {kind: 'document', name: 'source.html'});
		assert.deepEqual(route('/tok/qa.html?x=1'), {kind: 'document', name: 'qa.html'});
		assert.deepEqual(route('/tok/design.png'), {kind: 'reject', status: 404});
		assert.deepEqual(route('/tok/'), {kind: 'reject', status: 404});
		assert.deepEqual(route('/source.html'), {kind: 'reject', status: 404});
	});

	test('serves earlier outputs as /<token>/out/<jobId>/<file>', () => {
		assert.deepEqual(route('/tok/out/mi5x-ab12cd/design.png'), {
			kind: 'media',
			jobId: 'mi5x-ab12cd',
			file: 'design.png',
		});
	});

	test('rejects a wrong or missing token', () => {
		assert.deepEqual(route('/other/source.html'), {kind: 'reject', status: 404});
		assert.deepEqual(route('/out/job-1/design.png'), {kind: 'reject', status: 404});
		assert.deepEqual(route('/tokx/source.html'), {kind: 'reject', status: 404});
	});

	test('allows only GET and HEAD', () => {
		assert.deepEqual(route('/tok/source.html', 'HEAD'), {kind: 'document', name: 'source.html'});
		assert.deepEqual(route('/tok/source.html', 'POST'), {kind: 'reject', status: 405});
		assert.deepEqual(route('/tok/source.html', 'PUT'), {kind: 'reject', status: 405});
	});

	test('rejects traversal, dotfiles, odd names and extra depth', () => {
		const rejected = [
			'/tok/out/job-1/../../x.png',
			'/tok/out/job-1/%2e%2e/%2e%2e/x.png',
			'/tok/out/job-1/.hidden.png',
			'/tok/out/.hidden/design.png',
			'/tok/out/Job_1/design.png',
			'/tok/out/job-1/a%2Fb.png',
			'/tok/out/job-1/a b.png',
			'/tok/out/job-1/sub/design.png',
			'/tok/out/job-1',
			'/tok/out//design.png',
			'/tok/out/job-1/design.png/',
			'/tok/outx/job-1/design.png',
		];
		for (const url of rejected) {
			assert.deepEqual(route(url), {kind: 'reject', status: 404}, url);
		}
	});
});

describe('decideRequest', () => {
	const decide = (url: string): ReturnType<typeof decideRequest> =>
		decideRequest({url, origin: ORIGIN, token: TOKEN});

	test('lets the sandbox origin, data: and about: through', () => {
		assert.deepEqual(decide(`${ORIGIN}/tok/source.html`), {kind: 'allow'});
		assert.deepEqual(decide('data:image/png;base64,AAAA'), {kind: 'allow'});
		assert.deepEqual(decide('about:blank'), {kind: 'allow'});
	});

	test('allows blob: URLs only when they belong to the sandbox origin', () => {
		assert.deepEqual(decide(`blob:${ORIGIN}/5b0c`), {kind: 'allow'});
		assert.deepEqual(decide('blob:http://127.0.0.1:4001/5b0c'), {kind: 'block'});
		assert.deepEqual(decide('blob:https://example.com/5b0c'), {kind: 'block'});
		assert.deepEqual(decide('blob:null/5b0c'), {kind: 'block'});
	});

	test('rewrites a root-relative /out/ URL to its tokened path, keeping the query', () => {
		assert.deepEqual(decide(`${ORIGIN}/out/job-1/design.png?v=2`), {
			kind: 'rewrite',
			url: `${ORIGIN}/tok/out/job-1/design.png?v=2`,
		});
	});

	test('blocks every other origin, scheme and unparsable URL', () => {
		const blocked = [
			'https://example.com/a.png',
			'http://example.com/',
			'http://127.0.0.1:4001/',
			'http://localhost:4000/tok/source.html',
			'http://127.0.0.1:4000.evil.test/',
			'file:///etc/hosts',
			'ws://127.0.0.1:4000/ws',
			'ftp://127.0.0.1/',
			'javascript:alert(1)',
			'view-source:http://127.0.0.1:4000/',
			'not a url',
			'',
		];
		for (const url of blocked) assert.deepEqual(decide(url), {kind: 'block'}, url);
	});
});

interface Reply {
	readonly status: number;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly body: Buffer;
}

function fetchRaw(params: {
	readonly port: number;
	readonly path: string;
	readonly method?: string;
	readonly host?: string;
}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port: params.port,
				path: params.path,
				method: params.method ?? 'GET',
				headers: params.host === undefined ? {} : {host: params.host},
			},
			res => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () =>
					resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}),
				);
			},
		);
		req.on('error', reject);
		req.end();
	});
}

const PNG_BYTES = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
	'hex',
);

async function withSandbox<T>(
	body: (ctx: {
		readonly sandbox: RenderSandbox;
		readonly port: number;
		readonly token: string;
		readonly project: string;
	}) => Promise<T>,
): Promise<T> {
	const project = await mkdtemp(join(tmpdir(), 'atelier-sandbox-'));
	const earlier = join(project, '.atelier', 'out', 'job-1');
	await mkdir(earlier, {recursive: true});
	await writeFile(join(earlier, 'design.png'), PNG_BYTES);
	await writeFile(join(earlier, '.hidden.png'), PNG_BYTES);
	await writeFile(join(earlier, 'notes.json'), '{"secret":1}');
	await writeFile(join(earlier, 'source.html'), '<script>1</script>');
	await writeFile(join(project, 'outside.png'), PNG_BYTES);
	await symlink(join(project, 'outside.png'), join(earlier, 'link.png'));
	await writeFile(join(project, 'secret.txt'), 'TOP-SECRET');
	const sandbox = await startRenderSandbox({
		cwd: project,
		documents: {'source.html': '<p>source</p>', 'qa.html': '<p>qa</p>'},
	});
	const parsed = new URL(sandbox.url('source.html'));
	try {
		return await body({
			sandbox,
			port: Number(parsed.port),
			token: parsed.pathname.split('/')[1] ?? '',
			project,
		});
	} finally {
		await sandbox.close();
		await rm(project, {recursive: true, force: true});
	}
}

describe('startRenderSandbox', () => {
	test('serves its documents with a script-confining policy and no caching', async () => {
		await withSandbox(async ({port, token}) => {
			const reply = await fetchRaw({port, path: `/${token}/source.html`});
			assert.equal(reply.status, 200);
			assert.equal(reply.body.toString(), '<p>source</p>');
			assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8');
			assert.equal(reply.headers['cache-control'], 'no-store');
			assert.equal(reply.headers['x-content-type-options'], 'nosniff');
			assert.equal(
				reply.headers['content-security-policy'],
				"default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob:; form-action 'none'",
			);
			const qa = await fetchRaw({port, path: `/${token}/qa.html`});
			assert.equal(qa.body.toString(), '<p>qa</p>');
		});
	});

	test('answers HEAD without a body and refuses other methods', async () => {
		await withSandbox(async ({port, token}) => {
			const head = await fetchRaw({port, path: `/${token}/source.html`, method: 'HEAD'});
			assert.equal(head.status, 200);
			assert.equal(head.body.length, 0);
			const post = await fetchRaw({port, path: `/${token}/source.html`, method: 'POST'});
			assert.equal(post.status, 405);
		});
	});

	test('serves an earlier media output read-only, as an image', async () => {
		await withSandbox(async ({port, token}) => {
			const reply = await fetchRaw({port, path: `/${token}/out/job-1/design.png`});
			assert.equal(reply.status, 200);
			assert.equal(reply.headers['content-type'], 'image/png');
			assert.deepEqual(reply.body, PNG_BYTES);
			assert.equal(reply.headers['content-security-policy'], "sandbox; default-src 'none'");
		});
	});

	test('refuses everything else: wrong token, traversal, dotfiles, links out, non-media files', async () => {
		await withSandbox(async ({port, token}) => {
			const paths = [
				`/wrong/source.html`,
				`/source.html`,
				`/${token}/out/job-1/../../../outside.png`,
				`/${token}/out/job-1/..%2f..%2f..%2foutside.png`,
				`/${token}/out/job-1/%2e%2e/%2e%2e/%2e%2e/secret.txt`,
				`/${token}/out/job-1/.hidden.png`,
				`/${token}/out/job-1/link.png`,
				`/${token}/out/job-1/notes.json`,
				`/${token}/out/job-1/source.html`,
				`/${token}/out/job-1/absent.png`,
				`/${token}/out/job-2/design.png`,
				`/${token}/secret.txt`,
				`/${token}/design.png`,
			];
			for (const path of paths) {
				const reply = await fetchRaw({port, path});
				assert.equal(reply.status, 404, path);
				assert.equal(reply.body.includes('TOP-SECRET'), false, path);
			}
		});
	});

	test('refuses a request whose Host is not the literal loopback address', async () => {
		await withSandbox(async ({port, token}) => {
			const reply = await fetchRaw({
				port,
				path: `/${token}/source.html`,
				host: `rebind.example:${port}`,
			});
			assert.equal(reply.status, 404);
		});
	});

	test('drops WebSocket upgrades', async () => {
		await withSandbox(async ({port, token}) => {
			const closed = await new Promise<boolean>(resolve => {
				const socket = connect(port, '127.0.0.1', () => {
					socket.write(
						`GET /${token}/source.html HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
					);
				});
				socket.on('data', () => resolve(false));
				socket.on('close', () => resolve(true));
				socket.on('error', () => resolve(true));
			});
			assert.equal(closed, true);
		});
	});

	test('listens on loopback only and stops listening when closed', async () => {
		const project = await mkdtemp(join(tmpdir(), 'atelier-sandbox-'));
		const sandbox = await startRenderSandbox({cwd: project, documents: {}});
		const {hostname, port} = new URL(sandbox.origin);
		assert.equal(hostname, '127.0.0.1');
		await sandbox.close();
		await assert.rejects(fetchRaw({port: Number(port), path: '/'}));
		await rm(project, {recursive: true, force: true});
	});

	test('two sandboxes get different ports and tokens', async () => {
		const project = await mkdtemp(join(tmpdir(), 'atelier-sandbox-'));
		const one = await startRenderSandbox({cwd: project, documents: {'a.html': 'x'}});
		const two = await startRenderSandbox({cwd: project, documents: {'a.html': 'x'}});
		assert.notEqual(one.url('a.html'), two.url('a.html'));
		assert.notEqual(one.origin, two.origin);
		await one.close();
		await two.close();
		await rm(project, {recursive: true, force: true});
	});
});

interface Listener {
	readonly port: number;
	readonly hits: readonly string[];
	readonly close: () => Promise<void>;
}

async function listen(): Promise<Listener> {
	const hits: string[] = [];
	const server = createServer((req, res) => {
		hits.push(req.url ?? '');
		res.end('ok');
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

async function withPage<T>(params: {
	readonly document: string;
	readonly body: (ctx: {
		readonly sandbox: RenderSandbox;
		readonly root: string;
		readonly open: () => Promise<{
			readonly call: (method: string, args?: Readonly<Record<string, unknown>>) => Promise<unknown>;
			readonly next: (event: string) => Promise<unknown>;
			readonly blocked: () => readonly string[];
		}>;
	}) => Promise<T>;
}): Promise<T> {
	return withIsolatedTmp(async root => {
		const sandbox = await startRenderSandbox({
			cwd: root,
			documents: {'source.html': params.document},
		});
		try {
			return await withChrome(
				{
					chrome: chrome ?? '',
					sandbox,
					width: 400,
					height: 200,
					signal: AbortSignal.timeout(60_000),
				},
				async session =>
					params.body({
						sandbox,
						root,
						open: () => session.openPage({width: 400, height: 200, scale: 1}),
					}),
			);
		} finally {
			await sandbox.close();
		}
	});
}

describe('sandboxed Chrome', live, () => {
	test('request interception fails every URL outside the sandbox before the network sees it', async () => {
		const listener = await listen();
		const html = `<img src="http://127.0.0.1:${listener.port}/img"><script>fetch('http://127.0.0.1:${listener.port}/f',{mode:'no-cors'}).catch(function(){});fetch('https://example.com/x').catch(function(){});</script>`;
		await withPage({
			document: '<p>unused</p>',
			body: async ({open}) => {
				const page = await open();
				const loaded = page.next('Page.loadEventFired');
				// A data: page has no policy header, so only the interception stands in the way.
				await page.call('Page.navigate', {url: `data:text/html,${encodeURIComponent(html)}`});
				await loaded;
				await sleep(500);
				assert.deepEqual(
					[...page.blocked()].sort(),
					[
						`http://127.0.0.1:${listener.port}/f`,
						`http://127.0.0.1:${listener.port}/img`,
						'https://example.com/x',
					].sort(),
				);
			},
		});
		await listener.close();
		assert.deepEqual(listener.hits, []);
	});

	test('a page that navigates itself to another origin is stopped by the interception', async () => {
		const listener = await listen();
		await withPage({
			document: `<script>location.href='http://127.0.0.1:${listener.port}/nav'</script>`,
			body: async ({open, sandbox}) => {
				const page = await open();
				await page.call('Page.navigate', {url: sandbox.url('source.html')});
				await sleep(800);
				assert.deepEqual(page.blocked(), [`http://127.0.0.1:${listener.port}/nav`]);
			},
		});
		await listener.close();
		assert.deepEqual(listener.hits, []);
	});

	test('with the interception off, the proxy flags still keep a page off other local ports', async () => {
		const listener = await listen();
		await withPage({
			document: `<script>location.href='http://127.0.0.1:${listener.port}/nav'</script>`,
			body: async ({open, sandbox}) => {
				const page = await open();
				await page.call('Fetch.disable');
				await page.call('Page.navigate', {url: sandbox.url('source.html')});
				await sleep(1000);
				assert.deepEqual(page.blocked(), []);
			},
		});
		await listener.close();
		assert.deepEqual(listener.hits, []);
	});

	test('serves the sandbox itself through the same proxy settings', async () => {
		await withPage({
			document: '<body><p id="p">served</p></body>',
			body: async ({open, sandbox}) => {
				const page = await open();
				const loaded = page.next('Page.loadEventFired');
				await page.call('Page.navigate', {url: sandbox.url('source.html')});
				await loaded;
				const result = (await page.call('Runtime.evaluate', {
					expression: "document.getElementById('p').textContent",
				})) as {readonly result: {readonly value: string}};
				assert.equal(result.result.value, 'served');
				assert.deepEqual(page.blocked(), []);
			},
		});
	});

	test('exposes no DevTools port: the profile has no DevToolsActivePort file', async () => {
		await withPage({
			document: '<p>x</p>',
			body: async ({root}) => {
				const [profile] = await leftoverProfiles(root);
				assert.ok(profile?.startsWith('atelier-chrome-'));
				assert.equal((await readdir(join(root, profile ?? ''))).includes('DevToolsActivePort'), false);
			},
		});
	});

	test('kills Chrome when the host process exits mid-render', async () => {
		await withIsolatedTmp(async root => {
			const here = new URL('../src/engines/', import.meta.url);
			const script = join(root, 'host.ts');
			await writeFile(
				script,
				`import {withChrome} from '${new URL('chrome-session.ts', here).href}';
import {startRenderSandbox} from '${new URL('render-sandbox.ts', here).href}';
const sandbox = await startRenderSandbox({cwd: process.cwd(), documents: {}});
await withChrome({chrome: ${JSON.stringify(chrome)}, sandbox, width: 400, height: 200, signal: new AbortController().signal}, async () => {
  console.log('up');
  process.exit(0);
});
`,
			);
			const host = spawn(
				process.execPath,
				['--experimental-strip-types', '--no-warnings', script],
				{env: {...process.env, TMPDIR: root}, stdio: ['ignore', 'pipe', 'inherit']},
			);
			const exited = new Promise<number | null>(resolve => host.on('exit', resolve));
			let said = '';
			host.stdout.on('data', chunk => {
				said += String(chunk);
			});
			assert.equal(await exited, 0);
			assert.equal(said.trim(), 'up');
			let alive = true;
			for (let tries = 0; tries < 50 && alive; tries += 1) {
				alive = await isChromeAlive(root);
				if (alive) await sleep(100);
			}
			assert.equal(alive, false);
		});
	});

	test('removes the profile folder and the process group when the body throws', async () => {
		await withIsolatedTmp(async root => {
			const sandbox = await startRenderSandbox({cwd: root, documents: {}});
			await assert.rejects(
				withChrome(
					{
						chrome: chrome ?? '',
						sandbox,
						width: 400,
						height: 200,
						signal: AbortSignal.timeout(60_000),
					},
					async () => {
						throw Error('body failed');
					},
				),
				/body failed/,
			);
			await sandbox.close();
			assert.deepEqual(await leftoverProfiles(root), []);
		});
	});
});
