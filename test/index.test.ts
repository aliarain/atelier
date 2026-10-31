import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {ENGINES} from '../src/engines/index.ts';
import atelier from '../src/index.ts';
import {createJob, jobsDir, loadJob, loadJobs, saveJob} from '../src/jobs.ts';
import type {Engine, Job} from '../src/types.ts';
import {makeApi, type Recorder, type ToolRun} from './helpers/fake-api.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const realFetch = globalThis.fetch;
process.env.FAL_KEY = 'test-key';

const calls: string[] = [];
let imageResponse: () => Response = () => new Response(PNG, {headers: {'content-type': 'image/png'}});
globalThis.fetch = (async (input: unknown) => {
	const url = String(input);
	calls.push(url);
	if (url.startsWith('https://fal.run/')) return Response.json({images: [{url: 'https://cdn.example/fox.png'}]});
	return imageResponse();
}) as typeof fetch;
after(() => {
	globalThis.fetch = realFetch;
});

let gate: Promise<void> = Promise.resolve();
let release = (): void => {};
const ONE_PIXEL_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);
const slow: Engine = {
	id: 'slow',
	kind: 'image',
	paid: false,
	summary: 's',
	inputSchema: {type: 'object', properties: {}, required: []},
	parse: raw => ({ok: true, value: raw}),
	available: async () => ({ok: true}),
	run: async ({ctx}) => {
		await gate;
		const path = join(ctx.outDir, 'a.png');
		await writeFile(path, ONE_PIXEL_PNG);
		return [{path, kind: 'image', bytes: ONE_PIXEL_PNG.length}];
	},
};
(ENGINES as Engine[]).push(slow);

async function project(): Promise<{cwd: string; rec: Recorder; create: (input: Record<string, unknown>) => ReturnType<ToolRun>}> {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-index-'));
	const {api, rec} = makeApi(cwd);
	atelier(api);
	await rec.hooks.onSessionStart?.({sessionId: 'S1', source: 'startup'} as never);
	return {cwd, rec, create: input => rec.tools.get('atelier_create')!.run({input})};
}

const FAL_CALL = {engine: 'fal-image', title: 'Fox', input: {prompt: 'a fox'}};
const confirms = (rec: Recorder): unknown[][] => rec.calls.filter(call => call[0] === 'confirm');

describe('paid safety', () => {
	test('a billed run whose download fails is uncertain and keeps the image address', async () => {
		const {cwd, rec, create} = await project();
		rec.flagValues.set('atelier-allow-paid', true);
		imageResponse = () => new Response('gone', {status: 503});
		const result = await create(FAL_CALL);
		assert.equal(result.ok, false);
		const [job] = await loadJobs(cwd);
		assert.equal(job?.state, 'uncertain');
		assert.deepEqual(job?.billedResult, {url: 'https://cdn.example/fox.png'});
		assert.match(result.error ?? '', /uncertain: The provider already billed this run/);
		await rm(cwd, {recursive: true, force: true});
	});

	test('the same input after a failed download fetches the stored image without paying again', async () => {
		const {cwd, rec, create} = await project();
		rec.flagValues.set('atelier-allow-paid', true);
		imageResponse = () => new Response('gone', {status: 503});
		await create(FAL_CALL);
		imageResponse = () => new Response(PNG, {headers: {'content-type': 'image/png'}});
		calls.length = 0;
		const result = await create(FAL_CALL);
		assert.equal(result.ok, true);
		assert.deepEqual(calls, ['https://cdn.example/fox.png']);
		const states = (await loadJobs(cwd)).map(job => job.state).sort();
		assert.deepEqual(states, ['cancelled', 'completed']);
		await rm(cwd, {recursive: true, force: true});
	});

	test('an uncertain job blocks a different paid input even with --atelier-allow-paid', async () => {
		const {cwd, rec, create} = await project();
		rec.flagValues.set('atelier-allow-paid', true);
		imageResponse = () => new Response('gone', {status: 503});
		await create(FAL_CALL);
		calls.length = 0;
		const result = await create({...FAL_CALL, input: {prompt: 'a different fox'}});
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /^Nothing was run\. fal-image job [a-z0-9-]+ is uncertain and may already be billed\./);
		assert.match(result.error ?? '', /confirm_rerun: true/);
		assert.deepEqual(calls, []);
		assert.deepEqual(confirms(rec), []);
		await rm(cwd, {recursive: true, force: true});
	});

	test('confirm_rerun asks the person, and a headless refusal names the option', async () => {
		const {cwd, rec, create} = await project();
		rec.flagValues.set('atelier-allow-paid', true);
		imageResponse = () => new Response('gone', {status: 503});
		await create(FAL_CALL);
		calls.length = 0;
		const other = {...FAL_CALL, input: {prompt: 'a different fox'}, confirm_rerun: true};
		const refused = await create(other);
		assert.equal(refused.ok, false);
		assert.match(refused.error ?? '', /did not confirm the re-run of fal-image\. Headless runs cannot confirm, so confirm_rerun cannot be used there\./);
		assert.equal(confirms(rec).length, 1);
		assert.deepEqual(calls, []);

		rec.confirmAnswer = true;
		imageResponse = () => new Response(PNG, {headers: {'content-type': 'image/png'}});
		const approved = await create(other);
		assert.equal(approved.ok, true);
		assert.deepEqual(calls[0], 'https://fal.run/fal-ai/flux/schnell');
		const states = (await loadJobs(cwd)).map(job => job.state).sort();
		assert.deepEqual(states, ['cancelled', 'completed']);
		await rm(cwd, {recursive: true, force: true});
	});

	test('the paid confirm prompt names the engine and the model id', async () => {
		const {cwd, rec, create} = await project();
		rec.confirmAnswer = false;
		const result = await create({...FAL_CALL, input: {prompt: 'a fox', model: 'fal-ai/flux-pro/v1.1'}});
		assert.equal(result.ok, false);
		assert.deepEqual(confirms(rec), [['confirm', {
			title: 'Run paid engine fal-image?',
			message: '"Fox" calls a paid provider (fal-image, model fal-ai/flux-pro/v1.1) and may cost money.',
		}]]);
		await rm(cwd, {recursive: true, force: true});
	});
});

describe('atelier_present', () => {
	const seed = async (cwd: string, id: string, overrides: Partial<Job> = {}): Promise<void> =>
		saveJob(cwd, {
			...createJob({id, sessionId: 'S1', engine: 'design', title: 'Poster', input: {}, paid: false, ownerPid: process.pid, now: 5}),
			state: 'completed',
			outputs: [{path: join(cwd, '.atelier', 'out', id, 'a.png'), kind: 'image', bytes: 1}],
			...overrides,
		});

	test('duplicate ids present one job once without an ENOENT', async () => {
		const {cwd, rec} = await project();
		await seed(cwd, 'dup-1');
		const result = await rec.tools.get('atelier_present')!.run({input: {job_ids: ['dup-1', 'dup-1', 'dup-1'], note: 'Poster done'}});
		assert.equal(result.ok, true);
		const payload = JSON.parse((result.content?.[0] as {text: string}).text) as {presented: unknown[]};
		assert.equal(payload.presented.length, 1);
		assert.equal((await loadJob(cwd, 'dup-1'))?.presented, true);
		assert.deepEqual((await readdirJobs(cwd)).filter(name => name.endsWith('.tmp')), []);
		await rec.hooks.onSessionEnd?.({reason: 'shutdown'} as never);
		await rm(cwd, {recursive: true, force: true});
	});

	test('no ids is an error with no toast and nothing marked shown', async () => {
		const {cwd, rec} = await project();
		await seed(cwd, 'solo-1');
		for (const ids of [[], [7, null], undefined]) {
			const result = await rec.tools.get('atelier_present')!.run({input: {job_ids: ids, note: 'x'}});
			assert.deepEqual([result.ok, result.error], [false, 'job_ids must list at least one job id from atelier_create.']);
		}
		assert.equal((await loadJob(cwd, 'solo-1'))?.presented, false);
		assert.deepEqual(rec.calls.filter(call => call[0] === 'toast'), []);
		await rm(cwd, {recursive: true, force: true});
	});

	test('the toast carries the cleaned note with no Atelier prefix', async () => {
		const {cwd, rec} = await project();
		await seed(cwd, 'note-1');
		await rec.tools.get('atelier_present')!.run({input: {job_ids: ['note-1'], note: `Ember &amp; Oak — final ${'x'.repeat(400)}`}});
		const toast = rec.calls.find(call => call[0] === 'toast');
		assert.equal(toast?.[1], `Ember & Oak: final ${'x'.repeat(281)}`);
		await rec.hooks.onSessionEnd?.({reason: 'shutdown'} as never);
		await rm(cwd, {recursive: true, force: true});
	});
});

async function readdirJobs(cwd: string): Promise<string[]> {
	const {readdir} = await import('node:fs/promises');
	return readdir(jobsDir(cwd));
}

describe('gallery lifecycle', () => {
	test('concurrent opens start one server and register one view', async () => {
		const {cwd, rec} = await project();
		const open = rec.commands.get('atelier')!.handler;
		const [a, b, c] = await Promise.all([open(), open(), open()]);
		assert.equal(a.message, b.message);
		assert.equal(b.message, c.message);
		assert.equal(rec.views.length, 1);
		await rec.hooks.onSessionEnd?.({reason: 'shutdown'} as never);
		await rm(cwd, {recursive: true, force: true});
	});

	test('session end disposes the view and closes the server', async () => {
		const {cwd, rec} = await project();
		const {message} = await rec.commands.get('atelier')!.handler();
		const url = message.replace('Atelier gallery: ', '');
		assert.equal((await realFetch(url)).status, 200);
		await rec.hooks.onSessionEnd?.({reason: 'shutdown'} as never);
		assert.deepEqual(rec.viewDisposed, ['gallery']);
		await assert.rejects(realFetch(url));
		await rm(cwd, {recursive: true, force: true});
	});

	test('a hot reload keeps the server and re-registers the view in the new code', async () => {
		const {cwd, rec} = await project();
		const {message} = await rec.commands.get('atelier')!.handler();
		const url = message.replace('Atelier gallery: ', '');
		await rec.hooks.onSessionEnd?.({reason: 'reload'} as never);
		assert.deepEqual(rec.viewDisposed, ['gallery']);
		assert.equal((await realFetch(url)).status, 200);

		const next = makeApi(cwd);
		for (const [key, value] of rec.state) next.rec.state.set(key, value);
		atelier(next.api);
		await next.rec.hooks.onSessionStart?.({sessionId: 'S1', source: 'reload'} as never);
		assert.deepEqual(next.rec.views, [url]);
		assert.equal((await next.rec.commands.get('atelier')!.handler()).message, message);
		await next.rec.hooks.onSessionEnd?.({reason: 'shutdown'} as never);
		await assert.rejects(realFetch(url));
		await rm(cwd, {recursive: true, force: true});
	});
});

describe('running status', () => {
	test('shows Making <title> while a job runs and clears when it ends', async () => {
		const {cwd, rec, create} = await project();
		gate = new Promise<void>(resolve => { release = resolve; });
		const pending = create({engine: 'slow', title: 'Night Bloom', input: {}});
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.equal(rec.statuses.at(-1), 'Making Night Bloom');
		release();
		await pending;
		assert.equal(rec.statuses.at(-1), null);
		await rm(cwd, {recursive: true, force: true});
	});

	test('a throw while a transition is announced does not leave the footer stuck', async () => {
		const {cwd, rec, create} = await project();
		gate = Promise.resolve();
		rec.throwOnNextNullStatus = true;
		const result = await create({engine: 'slow', title: 'Stuck', input: {}});
		assert.deepEqual([result.ok, result.error], [false, 'Could not run the job: status failed']);
		assert.equal(rec.statuses.at(-1), null);
		await rm(cwd, {recursive: true, force: true});
	});
});

describe('read_file guard', () => {
	test('blocks every way of naming a running job folder and spares lookalikes', async () => {
		const {cwd, rec} = await project();
		gate = new Promise<void>(resolve => { release = resolve; });
		const pending = rec.tools.get('atelier_create')!.run({input: {engine: 'slow', title: 'S', input: {}}});
		await new Promise(resolve => setTimeout(resolve, 100));
		const [running] = await loadJobs(cwd);
		const id = running!.id;
		const dir = join(cwd, '.atelier', 'out', id);
		const blocked = async (input: Record<string, unknown>): Promise<boolean> =>
			((await rec.hooks.beforeToolCall?.({toolName: 'read_file', input} as never)) as {block?: boolean} | undefined)?.block === true;

		assert.equal(await blocked({file_path: join(dir, 'a.png')}), true, 'absolute file_path');
		assert.equal(await blocked({path: join(dir, 'a.png')}), true, 'path alias');
		assert.equal(await blocked({paths: ['README.md', join(dir, 'a.png')]}), true, 'paths array');
		assert.equal(await blocked({file_path: `.atelier/out/${id}/a.png`}), true, 'relative');
		assert.equal(await blocked({file_path: join(dir, '..', id, 'a.png')}), true, 'dot-dot');
		assert.equal(await blocked({file_path: join(cwd, '.atelier', 'out', '*', '*.png')}), true, 'glob across jobs');
		assert.equal(await blocked({file_path: join(dir, '*')}), true, 'glob inside the job');
		assert.equal(await blocked({file_path: join(cwd, '.atelier-notes', `${id}.md`)}), false, 'sibling .atelier-notes');
		assert.equal(await blocked({file_path: join(cwd, 'notes', `${id}.txt`)}), false, 'user file named like the job');
		assert.equal(await blocked({file_path: join(cwd, 'src', '*.ts')}), false, 'unrelated glob');
		await mkdir(dir, {recursive: true});
		release();
		await pending;
		assert.equal(await blocked({file_path: join(dir, 'a.png')}), false, 'after the job finished');
		await rm(cwd, {recursive: true, force: true});
	});
});

test('the job file of a finished run is readable as JSON', async () => {
	const {cwd, create} = await project();
	gate = Promise.resolve();
	await create({engine: 'slow', title: 'Done', input: {}});
	const [job] = await loadJobs(cwd);
	assert.equal(JSON.parse(await readFile(join(jobsDir(cwd), `${job!.id}.json`), 'utf8')).state, 'completed');
	await rm(cwd, {recursive: true, force: true});
});

test('the review size is kept on the job for cards, and finishing time is not touched', async () => {
	const {cwd, create} = await project();
	gate = Promise.resolve();
	const result = await create({engine: 'slow', title: 'Pixel', input: {}});
	assert.equal(result.ok, true);
	const [job] = await loadJobs(cwd);
	assert.deepEqual(job?.size, {width: 1, height: 1});
	assert.equal(job?.state, 'completed');
	await rm(cwd, {recursive: true, force: true});
});

test('atelier_jobs clamps a bad limit to a safe value', async () => {
	const {cwd, rec} = await project();
	for (const id of ['l1', 'l2', 'l3']) {
		await saveJob(cwd, createJob({id, sessionId: 'S1', engine: 'design', title: id, input: {}, paid: false, ownerPid: process.pid, now: 5}));
	}
	const count = async (limit: unknown): Promise<number> => {
		const result = await rec.tools.get('atelier_jobs')!.run({input: {limit}});
		return (JSON.parse((result.content?.[0] as {text: string}).text) as unknown[]).length;
	};
	assert.deepEqual([await count(-2), await count(0), await count(2.5), await count('5'), await count(2)], [3, 3, 2, 3, 2]);
	await rm(cwd, {recursive: true, force: true});
});

test('a project folder atelier cannot write to gives a tool error, not a throw', async () => {
	const {cwd, create} = await project();
	await rm(cwd, {recursive: true, force: true});
	await writeFile(cwd, 'a file where the project folder should be');
	const result = await create({engine: 'slow', title: 'Nowhere', input: {}});
	assert.equal(result.ok, false);
	assert.match(result.error ?? '', /^Could not run the job: /);
	await rm(cwd, {force: true});
});
