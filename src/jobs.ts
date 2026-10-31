import {randomBytes} from 'node:crypto';
import {mkdir, readdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Job, JobError, JobState, MediaOutput} from './types.ts';

// Every legal move. A job file has exactly one writer (the process that owns it), so the table
// is the whole concurrency story: no locks, no read-modify-write races.
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
	queued: ['running', 'failed', 'cancelled'],
	running: ['completed', 'failed', 'cancelled', 'uncertain'],
	uncertain: ['cancelled'],
	completed: [],
	failed: [],
	cancelled: [],
};

const FINISHED: ReadonlySet<JobState> = new Set([
	'completed',
	'failed',
	'cancelled',
]);

export function canMove(from: JobState, to: JobState): boolean {
	return TRANSITIONS[from].includes(to);
}

export function isFinished(state: JobState): boolean {
	return FINISHED.has(state);
}

export function studioDir(cwd: string): string {
	return join(cwd, '.studio');
}

export function jobsDir(cwd: string): string {
	return join(studioDir(cwd), 'jobs');
}

export function outputDir(cwd: string, jobId: string): string {
	return join(studioDir(cwd), 'out', jobId);
}

export function newJobId(now: number): string {
	return `${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function createJob(params: {
	readonly id: string;
	readonly sessionId: string;
	readonly engine: string;
	readonly title: string;
	readonly input: unknown;
	readonly paid: boolean;
	readonly ownerPid: number;
	readonly now: number;
}): Job {
	const {now, ...rest} = params;
	return {
		...rest,
		state: 'queued',
		createdAt: now,
		updatedAt: now,
		outputs: [],
		presented: false,
	};
}

export type JobPatch =
	| {readonly state: 'running'}
	| {
			readonly state: 'completed';
			readonly outputs: readonly MediaOutput[];
	  }
	| {
			readonly state: 'failed' | 'uncertain' | 'cancelled';
			readonly error: JobError;
	  };

export function moveJob(
	job: Job,
	patch: JobPatch,
	now: number,
): {readonly ok: true; readonly job: Job} | {readonly ok: false; readonly error: string} {
	if (!canMove(job.state, patch.state)) {
		return {ok: false, error: `job ${job.id} cannot go ${job.state} -> ${patch.state}`};
	}
	return {ok: true, job: {...job, ...patch, updatedAt: now}};
}

export function markPresented(job: Job, now: number): Job {
	return {...job, presented: true, updatedAt: now};
}

// A job still `queued` or `running` whose owner process is gone was interrupted. A paid one
// may already be billed, so it becomes `uncertain`; a free one simply failed and can be re-run.
export function settleOrphan(job: Job, params: {
	readonly isAlive: (pid: number) => boolean;
	readonly now: number;
}): Job {
	if (isFinished(job.state) || job.state === 'uncertain') return job;
	if (params.isAlive(job.ownerPid)) return job;
	const error: JobError = {
		code: 'interrupted',
		message: 'The process running this job stopped before it finished.',
		retryable: !job.paid,
	};
	if (job.paid && job.state === 'running') {
		return {...job, state: 'uncertain', error, updatedAt: params.now};
	}
	return {...job, state: 'failed', error, updatedAt: params.now};
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export async function saveJob(cwd: string, job: Job): Promise<void> {
	const dir = jobsDir(cwd);
	await mkdir(dir, {recursive: true});
	const tmp = join(dir, `${job.id}.json.${process.pid}.tmp`);
	await writeFile(tmp, `${JSON.stringify(job, null, '\t')}\n`);
	await rename(tmp, join(dir, `${job.id}.json`));
}

function parseJob(text: string): Job | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== 'object' || value === null) return undefined;
		const job = value as Partial<Job>;
		if (typeof job.id !== 'string' || typeof job.state !== 'string') return undefined;
		return value as Job;
	} catch {
		return undefined;
	}
}

export async function loadJobs(cwd: string): Promise<readonly Job[]> {
	const dir = jobsDir(cwd);
	const names = await readdir(dir).catch(() => [] as string[]);
	const jobs = await Promise.all(
		names
			.filter(name => name.endsWith('.json'))
			.map(name =>
				readFile(join(dir, name), 'utf8')
					.then(parseJob)
					.catch(() => undefined),
			),
	);
	return jobs
		.filter((job): job is Job => job !== undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadJob(cwd: string, id: string): Promise<Job | undefined> {
	if (!/^[a-z0-9-]+$/.test(id)) return undefined;
	const text = await readFile(join(jobsDir(cwd), `${id}.json`), 'utf8').catch(
		() => undefined,
	);
	return text === undefined ? undefined : parseJob(text);
}
