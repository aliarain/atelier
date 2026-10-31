import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir, readdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {BilledResult, Job, JobError, JobState, MediaKind, MediaOutput} from './types.ts';

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

export function atelierDir(cwd: string): string {
	return join(cwd, '.atelier');
}

export function jobsDir(cwd: string): string {
	return join(atelierDir(cwd), 'jobs');
}

export function outputDir(cwd: string, jobId: string): string {
	return join(atelierDir(cwd), 'out', jobId);
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
	readonly ownerStartedAt?: number;
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
			readonly billedResult?: BilledResult;
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
	readonly isAlive: (job: Job) => boolean;
	readonly now: number;
}): Job {
	if (isFinished(job.state) || job.state === 'uncertain') return job;
	if (params.isAlive(job)) return job;
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

// When this process started, in epoch ms. A job records it so a recycled pid is not taken for
// the process that owned the job.
export const PROCESS_STARTED_AT: number = Date.now() - process.uptime() * 1000;

// `ps` reports start times to the second.
const START_TOLERANCE_MS = 5000;

export type StartedAtReader = (pid: number) => Promise<number | undefined>;

// One reader per sweep: each pid is asked about once.
export function createStartedAtReader(): StartedAtReader {
	const asked = new Map<number, Promise<number | undefined>>();
	const ask = (pid: number): Promise<number | undefined> =>
		new Promise(resolve => {
			execFile('ps', ['-o', 'lstart=', '-p', String(pid)], {timeout: 5000}, (error, stdout) => {
				if (error !== null) return resolve(undefined);
				const parsed = Date.parse(String(stdout).trim());
				resolve(Number.isNaN(parsed) ? undefined : parsed);
			});
		});
	return pid => {
		const known = asked.get(pid);
		if (known !== undefined) return known;
		const fresh = ask(pid);
		asked.set(pid, fresh);
		return fresh;
	};
}

// A live pid is the owner only if it started when the job says its owner did. When the start
// time cannot be read the pid is trusted, which errs towards not re-running paid work.
export async function isOwnerAlive(
	job: Job,
	deps: {
		readonly isAlive: (pid: number) => boolean;
		readonly startedAtOf: StartedAtReader;
		readonly selfPid: number;
		readonly selfStartedAt: number;
	},
): Promise<boolean> {
	if (!deps.isAlive(job.ownerPid)) return false;
	if (typeof job.ownerStartedAt !== 'number') return true;
	const started =
		job.ownerPid === deps.selfPid
			? deps.selfStartedAt
			: await deps.startedAtOf(job.ownerPid);
	if (started === undefined) return true;
	return Math.abs(started - job.ownerStartedAt) <= START_TOLERANCE_MS;
}

const GITIGNORE = '*\n';

export async function saveJob(cwd: string, job: Job): Promise<void> {
	const dir = jobsDir(cwd);
	await mkdir(dir, {recursive: true});
	// Media and job files are local work product; the first save keeps them out of git status.
	await writeFile(join(atelierDir(cwd), '.gitignore'), GITIGNORE, {flag: 'wx'}).catch(() => undefined);
	const tmp = join(dir, `${job.id}.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
	await writeFile(tmp, `${JSON.stringify(job, null, '\t')}\n`);
	await rename(tmp, join(dir, `${job.id}.json`));
}

const MEDIA_KINDS: ReadonlySet<string> = new Set<MediaKind>(['image', 'video', 'audio']);

function normalizeOutputs(value: unknown): readonly MediaOutput[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item: unknown): readonly MediaOutput[] => {
		if (typeof item !== 'object' || item === null) return [];
		const {path, kind, bytes} = item as Partial<Record<keyof MediaOutput, unknown>>;
		if (typeof path !== 'string' || typeof kind !== 'string' || !MEDIA_KINDS.has(kind)) return [];
		return [{path, kind: kind as MediaKind, bytes: typeof bytes === 'number' ? bytes : 0}];
	});
}

// Job files are written by a mod that may be an older or newer version, or edited by hand, so
// every field the rest of the mod indexes into is coerced here once.
function parseJob(text: string): Job | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== 'object' || value === null) return undefined;
		const job = value as Partial<Record<keyof Job, unknown>>;
		if (typeof job.id !== 'string' || typeof job.state !== 'string') return undefined;
		if (!Object.hasOwn(TRANSITIONS, job.state)) return undefined;
		const engine = typeof job.engine === 'string' ? job.engine : 'unknown';
		return {
			...(value as Job),
			engine,
			title: typeof job.title === 'string' && job.title !== '' ? job.title : engine,
			outputs: normalizeOutputs(job.outputs),
		};
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

// For synchronous host callbacks, such as drawing a chat row, that cannot await loadJob.
export function loadJobSync(cwd: string, id: string): Job | undefined {
	if (!/^[a-z0-9-]+$/.test(id)) return undefined;
	try {
		return parseJob(readFileSync(join(jobsDir(cwd), `${id}.json`), 'utf8'));
	} catch {
		return undefined;
	}
}

export async function loadJob(cwd: string, id: string): Promise<Job | undefined> {
	if (!/^[a-z0-9-]+$/.test(id)) return undefined;
	const text = await readFile(join(jobsDir(cwd), `${id}.json`), 'utf8').catch(
		() => undefined,
	);
	return text === undefined ? undefined : parseJob(text);
}
