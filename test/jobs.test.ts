import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
	atelierDir,
	canMove,
	createJob,
	createStartedAtReader,
	isOwnerAlive,
	jobsDir,
	loadJob,
	loadJobs,
	moveJob,
	saveJob,
	PROCESS_STARTED_AT,
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

test('the first save writes .atelier/.gitignore with a star, and later saves leave it alone', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-ignore-'));
	try {
		await saveJob(cwd, base({id: 'a'}));
		assert.equal(await readFile(join(atelierDir(cwd), '.gitignore'), 'utf8'), '*\n');
		await writeFile(join(atelierDir(cwd), '.gitignore'), '*\n!keep\n');
		await saveJob(cwd, base({id: 'b'}));
		assert.equal(await readFile(join(atelierDir(cwd), '.gitignore'), 'utf8'), '*\n!keep\n');
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

test('twelve concurrent saves of one job never collide on a temp file', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-race-'));
	try {
		await Promise.all(Array.from({length: 12}, (_, index) => saveJob(cwd, base({updatedAt: index}))));
		assert.deepEqual(await readdir(jobsDir(cwd)), ['j1.json']);
		assert.equal((await loadJob(cwd, 'j1'))?.title, 'Poster');
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

test('a drifted job file is normalized instead of throwing downstream', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-drift-'));
	try {
		await mkdir(jobsDir(cwd), {recursive: true});
		const write = (id: string, patch: Record<string, unknown>) =>
			writeFile(join(jobsDir(cwd), id + '.json'), JSON.stringify({...base({id}), ...patch}));
		await write('no-outputs', {outputs: undefined, title: 42});
		await write('string-outputs', {outputs: 'nope', title: ''});
		await write('junk-outputs', {outputs: [null, 7, {path: 1}, {path: '/x/a.png', kind: 'gif', bytes: 1}, {path: '/x/b.png', kind: 'image'}]});
		await write('bad-state', {state: 'toString'});
		const loaded = await loadJobs(cwd);
		const byId = Object.fromEntries(loaded.map(job => [job.id, job]));
		assert.equal(byId['bad-state'], undefined);
		assert.deepEqual(byId['no-outputs']?.outputs, []);
		assert.equal(byId['no-outputs']?.title, 'design');
		assert.deepEqual(byId['string-outputs']?.outputs, []);
		assert.equal(byId['string-outputs']?.title, 'design');
		assert.deepEqual(byId['junk-outputs']?.outputs, [{path: '/x/b.png', kind: 'image', bytes: 0}]);
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

test('runJob stamps the owner with this process start time', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-owner-'));
	try {
		const job = await runJob(runParams(cwd, fakeEngine(async () => [])));
		assert.equal(job.ownerPid, process.pid);
		assert.equal(job.ownerStartedAt, PROCESS_STARTED_AT);
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

const selfDeps = {
	isAlive: () => true,
	startedAtOf: async () => undefined,
	selfPid: 100,
	selfStartedAt: 1_000_000,
};

test('a job whose pid was recycled by this process is orphaned', async () => {
	const stale = base({ownerPid: 100, ownerStartedAt: 1_000_000 - 3_600_000});
	assert.equal(await isOwnerAlive(stale, selfDeps), false);
	const mine = base({ownerPid: 100, ownerStartedAt: 1_000_000});
	assert.equal(await isOwnerAlive(mine, selfDeps), true);
});

test('a job with no recorded start time trusts a live pid', async () => {
	assert.equal(await isOwnerAlive(base({ownerPid: 100}), selfDeps), true);
});

test('a dead pid is never alive whatever the start time says', async () => {
	assert.equal(await isOwnerAlive(base({ownerPid: 100, ownerStartedAt: 1_000_000}), {...selfDeps, isAlive: () => false}), false);
});

test('another live process is the owner only when its real start time matches', async () => {
	const child = spawn('sleep', ['30']);
	try {
		const pid = child.pid ?? 0;
		const startedAt = await createStartedAtReader()(pid);
		assert.ok(startedAt !== undefined && Math.abs(startedAt - Date.now()) < 10_000, 'ps start time is near now');
		const deps = {...selfDeps, isAlive: () => true, startedAtOf: createStartedAtReader()};
		const owned = base({ownerPid: pid, ownerStartedAt: Date.now()});
		assert.equal(await isOwnerAlive(owned, deps), true);
		const recycled = base({ownerPid: pid, ownerStartedAt: Date.now() - 86_400_000});
		assert.equal(await isOwnerAlive(recycled, deps), false);
	} finally {
		child.kill();
	}
});

test('a start time that cannot be read is trusted, so paid work is not re-run', async () => {
	const job = base({ownerPid: 5, ownerStartedAt: 1});
	assert.equal(await isOwnerAlive(job, selfDeps), true);
});

test('a failure after markBilled with no stored result ends uncertain and says not to re-run', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-billed-'));
	try {
		const engine = fakeEngine(async ({ctx}) => {
			ctx.markBilled?.();
			throw engineFailure({code: 'no_image', message: 'answered without an image.', retryable: false});
		});
		const job = await runJob(runParams(cwd, engine));
		assert.equal(job.state, 'uncertain');
		assert.equal(job.billedResult, undefined);
		assert.deepEqual(job.error, {
			code: 'billed_incomplete',
			message: "The provider already billed this run, but it did not finish: answered without an image. Do not run it again without the person's say-so.",
			retryable: false,
		});
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});

test('a failure before markBilled stays a plain failure', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'atelier-unbilled-'));
	try {
		const engine = fakeEngine(async () => {
			throw engineFailure({code: 'auth', message: 'bad key', retryable: false});
		});
		assert.equal((await runJob(runParams(cwd, engine))).state, 'failed');
	} finally {
		await rm(cwd, {recursive: true, force: true});
	}
});
