import type {Job} from './types.ts';

const REMINDER_LIMIT = 8;
const TITLE_LIMIT = 120;

const ENTITIES: Readonly<Record<string, string>> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' ',
};

// Models writing HTML all day escape their titles too ("Ember &amp; Oak"). A title is plain
// text shown by textContent, so decode the common entities once at the boundary.
export function plainTitle(raw: unknown, fallback: string): string {
	const value = typeof raw === 'string' ? raw : '';
	const decoded = value.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, entity => ENTITIES[entity] ?? entity);
	const trimmed = decoded.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT);
	return trimmed === '' ? fallback : trimmed;
}

function jobLine(job: Job): string {
	const output = job.outputs[0]?.path;
	const detail = job.error ? `: ${job.error.message}` : output ? `: ${output}` : '';
	return `- ${job.id} "${job.title}" (${job.engine}) ${job.state}${detail}`;
}

// What the model should not lose track of: work still running, paid work that may have been
// billed, and finished work the person has not been shown. Nothing to say means no reminder,
// so a quiet session sends the same bytes every round.
export function studioReminder(jobs: readonly Job[], sessionId: string): string | undefined {
	const mine = jobs.filter(job => job.sessionId === sessionId);
	const open = mine.filter(
		job =>
			job.state === 'running' ||
			job.state === 'queued' ||
			job.state === 'uncertain' ||
			(job.state === 'completed' && !job.presented),
	);
	if (open.length === 0) return undefined;
	const lines = open.slice(0, REMINDER_LIMIT).map(jobLine);
	const uncertain = open.some(job => job.state === 'uncertain');
	const notes = uncertain
		? ['An uncertain job may already be billed. Ask before making it again.']
		: [];
	return ['<studio_jobs>', ...lines, ...notes, '</studio_jobs>'].join('\n');
}

export interface RunProgress {
	readonly created: number;
	readonly presented: boolean;
	readonly nudged: boolean;
	readonly stopNudged: boolean;
}

export const FRESH_RUN: RunProgress = {
	created: 0,
	presented: false,
	nudged: false,
	stopNudged: false,
};

export type StudioToolEvent =
	| {readonly type: 'created'; readonly ok: boolean}
	| {readonly type: 'presented'};

export function trackTool(progress: RunProgress, event: StudioToolEvent): RunProgress {
	if (event.type === 'presented') return {...progress, presented: true};
	if (!event.ok) return progress;
	return {...progress, created: progress.created + 1};
}

const NUDGE_AFTER = 3;

// One mid-run reminder after several makes with nothing shown, so the person sees progress
// instead of waiting for the end.
export function midRunNudge(
	progress: RunProgress,
): {readonly progress: RunProgress; readonly text?: string} {
	if (progress.presented || progress.nudged || progress.created < NUDGE_AFTER) {
		return {progress};
	}
	return {
		progress: {...progress, nudged: true},
		text: 'Several renders are done and none were shown yet. Present the best one now with studio_present (one line on what it is), then keep going.',
	};
}

// A run that made something and is about to end without showing it gets one more turn.
export function stopNudge(
	progress: RunProgress,
): {readonly progress: RunProgress; readonly reason?: string} {
	if (progress.created === 0 || progress.presented || progress.stopNudged) {
		return {progress};
	}
	return {
		progress: {...progress, stopNudged: true},
		reason: 'You made media this run but never presented it. Call studio_present with the final outputs and a one-line note, then stop.',
	};
}
