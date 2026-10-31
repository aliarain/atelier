import {readFileSync, statSync} from 'node:fs';
import {mkdir, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {isEngineFailure, stderrTail} from './exec.ts';
import {createJob, moveJob, newJobId, outputDir, PROCESS_STARTED_AT, saveJob} from './jobs.ts';
import type {BilledResult, Engine, Env, Exec, Job, JobError, MediaOutput} from './types.ts';

export interface RunJobParams {
	readonly cwd: string;
	readonly sessionId: string;
	readonly engine: Engine;
	readonly input: unknown;
	readonly title: string;
	readonly exec: Exec;
	readonly env: Env;
	readonly fetch: typeof fetch;
	readonly signal: AbortSignal;
	readonly now: () => number;
	// A billed result from an earlier uncertain run; the engine fetches it instead of paying again.
	readonly resume?: BilledResult;
	// Fires after every saved transition so a gallery or pane can repaint.
	readonly onChange?: (job: Job) => void;
}

function errorOf(error: unknown, aborted: boolean): JobError {
	if (aborted) {
		return {code: 'cancelled', message: 'The run was stopped.', retryable: true};
	}
	if (isEngineFailure(error)) {
		return {code: error.code, message: error.message, retryable: error.retryable};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {code: 'engine_error', message: stderrTail(message), retryable: true};
}

// The provider took the billable request, so whatever stopped the run, the money may be spent.
// A retry must not pay again blindly: with the result's address it only fetches.
function billedError(cause: JobError, billed: BilledResult | undefined): JobError {
	const next =
		billed === undefined
			? "Do not run it again without the person's say-so."
			: 'Run atelier_create again with the same input to fetch the result without paying again.';
	return {
		code: 'billed_incomplete',
		message: `The provider already billed this run, but it did not finish: ${cause.message.replace(/[.!?]?$/, '.')} ${next}`,
		retryable: false,
	};
}

async function commit(params: RunJobParams, job: Job): Promise<Job> {
	await saveJob(params.cwd, job);
	params.onChange?.(job);
	return job;
}

// Drive one job through its state machine. Every transition is saved before the next step,
// so a crash leaves a record that settleOrphan can classify on the next start.
export async function runJob(params: RunJobParams): Promise<Job> {
	const {engine, now} = params;
	const id = newJobId(now());
	const queued = createJob({
		id,
		sessionId: params.sessionId,
		engine: engine.id,
		title: params.title,
		input: params.input,
		paid: engine.paid,
		ownerPid: process.pid,
		ownerStartedAt: PROCESS_STARTED_AT,
		now: now(),
	});
	await commit(params, queued);

	const outDir = outputDir(params.cwd, id);
	await mkdir(outDir, {recursive: true});
	const started = moveJob(queued, {state: 'running'}, now());
	if (!started.ok) return queued;
	const running = await commit(params, started.job);

	// Mutated by the engine's markBilled callback, so it lives in an object, not a narrowed let.
	const billing: {billed: boolean; result: BilledResult | undefined} = {billed: false, result: undefined};
	try {
		const outputs = await engine.run({
			input: params.input,
			ctx: {
				outDir,
				cwd: params.cwd,
				signal: params.signal,
				exec: params.exec,
				env: params.env,
				fetch: params.fetch,
				markBilled: result => {
					billing.billed = true;
					billing.result = result ?? billing.result;
				},
				...(params.resume === undefined ? {} : {resume: params.resume}),
			},
		});
		const done = moveJob(running, {state: 'completed', outputs}, now());
		return done.ok ? commit(params, done.job) : running;
	} catch (error) {
		const aborted = params.signal.aborted;
		if (billing.billed) {
			const patch = {
				state: 'uncertain',
				error: billedError(errorOf(error, aborted), billing.result),
				...(billing.result === undefined ? {} : {billedResult: billing.result}),
			} as const;
			const uncertain = moveJob(running, patch, now());
			return uncertain.ok ? commit(params, uncertain.job) : running;
		}
		const state = aborted ? 'cancelled' : 'failed';
		const failed = moveJob(running, {state, error: errorOf(error, aborted)}, now());
		return failed.ok ? commit(params, failed.job) : running;
	}
}

const PREVIEW_EDGE = 768;
const PREVIEW_FILE = 'preview.jpg';
// A chat card inlines the preview as a data URL, so a runaway file must not ride along.
const PREVIEW_CARD_MAX_BYTES = 600 * 1024;
const JOB_ID = /^[a-z0-9-]+$/;

// A small JPEG the model can look at: the image itself, or the middle frame of a video.
// Full-size renders would cost far more tokens than a review glance needs. The file stays in
// the job folder as preview.jpg so the chat card can show it later without another render.
export async function previewOf(params: {
	readonly output: MediaOutput;
	readonly exec: Exec;
	readonly durationS?: number;
}): Promise<string | undefined> {
	const {output, exec} = params;
	if (output.kind === 'audio') return undefined;
	const target = join(output.path, '..', PREVIEW_FILE);
	const seek = output.kind === 'video' ? ['-ss', String((params.durationS ?? 0) / 2)] : [];
	const result = await exec({
		command: 'ffmpeg',
		args: [
			'-y',
			'-v',
			'error',
			...seek,
			'-i',
			output.path,
			'-vf',
			`scale='min(${PREVIEW_EDGE},iw)':-2`,
			'-frames:v',
			'1',
			'-q:v',
			'4',
			target,
		],
		timeoutMs: 30_000,
	});
	if (result.code !== 0) {
		await rm(target, {force: true});
		return undefined;
	}
	const bytes = await readFile(target).catch(() => undefined);
	return bytes?.toString('base64');
}

// Sync because a mod element override has to answer without awaiting.
export function readPreviewDataUrl(cwd: string, jobId: string): string | undefined {
	if (!JOB_ID.test(jobId)) return undefined;
	const path = join(outputDir(cwd, jobId), PREVIEW_FILE);
	try {
		if (statSync(path).size > PREVIEW_CARD_MAX_BYTES) return undefined;
		return `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`;
	} catch {
		return undefined;
	}
}

export async function fileBytes(path: string): Promise<number> {
	return (await stat(path).catch(() => undefined))?.size ?? 0;
}
