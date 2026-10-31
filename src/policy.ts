import type {BilledResult, Job} from './types.ts';

const REMINDER_LIMIT = 8;
const TITLE_LIMIT = 120;
const NOTE_LIMIT = 300;

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
// text shown by textContent, so decode the common entities once at the boundary. Titles are
// UI copy in the gallery, which never shows em or en dashes: a spaced dash becomes a colon.
function plainText(raw: unknown, limit: number): string {
	const value = typeof raw === 'string' ? raw : '';
	const decoded = value.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, entity => ENTITIES[entity] ?? entity);
	const undashed = decoded.replace(/\s+[–—]\s+/g, ': ').replace(/[–—]/g, '-');
	return undashed.replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function plainTitle(raw: unknown, fallback: string): string {
	const title = plainText(raw, TITLE_LIMIT);
	return title === '' ? fallback : title;
}

// The note the model writes when it presents work reaches the person as a card line and a
// toast, so it gets the same cleaning as a title, with room for a sentence or two.
export function plainNote(raw: unknown): string {
	return plainText(raw, NOTE_LIMIT);
}

// What the footer says while jobs render. The host names the mod, so the text does not.
export function runningStatus(titles: readonly string[]): string | null {
	return titles.length === 0 ? null : `Making ${titles.join(', ')}`;
}

// A video whose every scene holds a still frame is meant not to move; the review should not
// call that frozen footage. The review accepts the flag on hosts that ship it.
export function stillVideoFlag(job: Job): {readonly expectStill: true} | Record<string, never> {
	if (job.engine !== 'video') return {};
	const scenes = (job.input as {readonly scenes?: unknown} | null)?.scenes;
	if (!Array.isArray(scenes) || scenes.length === 0) return {};
	const allStill = scenes.every(scene => (scene as {readonly motion?: unknown} | null)?.motion === 'still');
	return allStill ? {expectStill: true} : {};
}

export type PaidGate =
	| {readonly kind: 'clear'}
	| {
			readonly kind: 'resume';
			readonly job: Job;
			readonly billedResult: BilledResult;
	  }
	| {readonly kind: 'blocked'; readonly jobs: readonly Job[]};

// A paid engine with an uncertain job may already have billed it. The same input with a stored
// result is a free re-download; anything else needs the person, however the run was approved.
export function paidGate(jobs: readonly Job[], engineId: string, input: unknown): PaidGate {
	const uncertain = jobs.filter(job => job.state === 'uncertain' && job.engine === engineId);
	if (uncertain.length === 0) return {kind: 'clear'};
	const wanted = JSON.stringify(input);
	const resumable = uncertain.find(
		job => typeof job.billedResult?.url === 'string' && JSON.stringify(job.input) === wanted,
	);
	if (resumable?.billedResult !== undefined) {
		return {kind: 'resume', job: resumable, billedResult: resumable.billedResult};
	}
	return {kind: 'blocked', jobs: uncertain};
}

function modelOf(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) return undefined;
	const model = (input as {readonly model?: unknown}).model;
	return typeof model === 'string' && model !== '' ? model : undefined;
}

// The person is approving spend, so the prompt names the provider route, not just the title.
export function paidConfirmMessage(params: {
	readonly engineId: string;
	readonly title: string;
	readonly input: unknown;
}): string {
	const model = modelOf(params.input);
	const route = model === undefined ? params.engineId : `${params.engineId}, model ${model}`;
	return `"${params.title}" calls a paid provider (${route}) and may cost money.`;
}

function jobLine(job: Job): string {
	const output = job.outputs[0]?.path;
	const detail = job.error ? `: ${job.error.message}` : output ? `: ${output}` : '';
	return `- ${job.id} "${job.title}" (${job.engine}) ${job.state}${detail}`;
}

// What the model should not lose track of: work still running, paid work that may have been
// billed, and finished work the person has not been shown. Nothing to say means no reminder,
// so a quiet session sends the same bytes every round.
export function atelierReminder(jobs: readonly Job[], sessionId: string): string | undefined {
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
	return ['<atelier_jobs>', ...lines, ...notes, '</atelier_jobs>'].join('\n');
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

export type AtelierToolEvent =
	| {readonly type: 'created'; readonly ok: boolean}
	| {readonly type: 'presented'};

export function trackTool(progress: RunProgress, event: AtelierToolEvent): RunProgress {
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
		text: 'Several renders are done and none were shown yet. Present the best one now with atelier_present (one line on what it is), then keep going.',
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
		reason: 'You made media this run but never presented it. Call atelier_present with the final outputs and a one-line note, then stop.',
	};
}
