import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
	canMove,
	createJob,
	jobsDir,
	loadJob,
	loadJobs,
	moveJob,
	saveJob,
	settleOrphan,
} from '../src/jobs.ts';
import {runJob} from '../src/runner.ts';
import {engineFailure} from '../src/exec.ts';
import type {Engine, Job} from '../src/types.ts';

const base = (overrides: Partial<Job> = {}): Job => ({
	...createJob({
		id: 'j1',
		sessionId: 's1',
		engine: 'design',
		title: 'Poster',
		input: {},
		paid: false,
		ownerPid: 999_999,
		now: 1000,
	}),
	...overrides,
});

test('the transition table allows the lifecycle and nothing after a final state', () => {
	assert.equal(canMove('queued', 'running'), true);
	assert.equal(canMove('running', 'completed'), true);
	assert.equal(canMove('running', 'uncertain'), true);
	assert.equal(canMove('uncertain', 'running'), false);
	assert.equal(canMove('uncertain', 'cancelled'), true);
	assert.equal(canMove('completed', 'running'), false);
	assert.equal(canMove('failed', 'running'), false);
});

test('moveJob refuses an illegal move with a readable error', () => {
	const result = moveJob(base({state: 'completed'}), {state: 'running'}, 2000);
	assert.deepEqual(result, {ok: false, error: 'job j1 cannot go completed -> running'});
});

test('an orphaned paid job becomes uncertain, a free one fails and can be retried', () => {
	const dead = () => false;
	const paid = settleOrphan(base({state: 'running', paid: true}), {isAlive: dead, now: 5});
	assert.equal(paid.state, 'uncertain');
	assert.equal(paid.error?.retryable, false);
	const free = settleOrphan(base({state: 'running'}), {isAlive: dead, now: 5});
	assert.equal(free.state, 'failed');
	assert.equal(free.error?.code, 'interrupted');
	assert.equal(free.error?.retryable, true);
	const live = base({state: 'running'});
	assert.equal(settleOrphan(live, {isAlive: () => true, now: 5}), live);
});

test('jobs persist atomically and load newest first', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-jobs-'));
	try {
		await saveJob(cwd, base({id: 'old', updatedAt: 1}));
		await saveJob(cwd, base({id: 'new', updatedAt: 2}));
		assert.deepEqual((await loadJobs(cwd)).map(job => job.id), ['new', 'old']);
		assert.deepEqual((await readdir(jobsDir(cwd))).sort(), ['new.json', 'old.json']);
		assert.equal((await loadJob(cwd, 'old'))?.id, 'old');
		assert.equal(await loadJob(cwd, '../etc/passwd'), undefined);
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

const fakeEngine = (run: Engine['run']): Engine => ({
	id: 'fake',
	kind: 'image',
	paid: false,
	summary: 'test',
	inputSchema: {type: 'object', properties: {}, required: []},
	parse: raw => ({ok: true, value: raw}),
	available: async () => ({ok: true}),
	run,
});

const runParams = (cwd: string, engine: Engine, signal = new AbortController().signal) => ({
	cwd,
	sessionId: 's1',
	engine,
	input: {},
	title: 'Test',
	exec: async () => ({code: 0, stdout: '', stderr: ''}),
	env: {},
	fetch: globalThis.fetch,
	signal,
	now: () => 42,
});

test('runJob walks queued, running, completed and saves each step', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-run-'));
	try {
		const states: string[] = [];
		const engine = fakeEngine(async ({ctx}) => [{path: join(ctx.outDir, 'a.png'), kind: 'image', bytes: 3}]);
		const job = await runJob({...runParams(cwd, engine), onChange: changed => states.push(changed.state)});
		assert.deepEqual(states, ['queued', 'running', 'completed']);
		assert.equal(job.outputs[0]?.bytes, 3);
		assert.equal((await loadJob(cwd, job.id))?.state, 'completed');
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

test('runJob records an engine failure with its code', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-run-'));
	try {
		const engine = fakeEngine(async () => {
			throw engineFailure({code: 'render_failed', message: 'Chrome exited 1', retryable: true});
		});
		const job = await runJob(runParams(cwd, engine));
		assert.equal(job.state, 'failed');
		assert.deepEqual(job.error, {code: 'render_failed', message: 'Chrome exited 1', retryable: true});
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

test('runJob marks an aborted run cancelled', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-run-'));
	try {
		const controller = new AbortController();
		const engine = fakeEngine(async () => {
			controller.abort();
			throw new Error('killed');
		});
		const job = await runJob(runParams(cwd, engine, controller.signal));
		assert.equal(job.state, 'cancelled');
		assert.equal(job.error?.code, 'cancelled');
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});
