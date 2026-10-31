import {plainNote, plainTitle} from './policy.ts';
import type {Job, Size} from './types.ts';

interface TextNode {
	readonly type: 'text';
	readonly text: string;
	readonly color?: 'red' | 'green' | 'yellow';
	readonly bold?: boolean;
	readonly dim?: boolean;
}

interface StatusNode {
	readonly type: 'status';
	readonly state: 'running' | 'done' | 'error';
	readonly text: string;
}

interface ButtonNode {
	readonly type: 'button';
	readonly label: string;
	readonly onPress: () => Promise<void>;
}

interface RowNode {
	readonly type: 'row';
	readonly children: readonly FeedNode[];
}

// Added to the host after status; hosts that predate them do not list them in capabilities.
interface ImageNode {
	readonly type: 'image';
	readonly src: string;
	readonly alt: string;
	readonly width: number;
	readonly height: number;
	readonly fit: 'cover' | 'contain';
	readonly badge?: 'play';
}

interface StackNode {
	readonly type: 'stack';
	readonly direction: 'row' | 'column';
	readonly align?: 'start' | 'center';
	readonly children: readonly FeedNode[];
}

export type FeedNode = TextNode | StatusNode | ButtonNode | RowNode | ImageNode | StackNode;

export interface FeedCardDeps {
	// A data URL of the saved preview JPEG, or undefined when there is none or it is too big.
	readonly readPreview: (jobId: string) => string | undefined;
	readonly readJob: (jobId: string) => Job | undefined;
	readonly capabilities: readonly string[];
	readonly openGallery: () => Promise<void>;
}

export interface ToolRowProps {
	readonly toolName: string;
	readonly input?: unknown;
	readonly status: 'pending' | 'success' | 'error';
	readonly result?: readonly unknown[];
}

const PRESENT_LIMIT = 4;
const CHIP_LIMIT = 3;
const CHIP_CHARS = 40;
const ERROR_CHARS = 140;
const PORTRAIT_THUMB = {width: 64, height: 80};
const LANDSCAPE_THUMB = {width: 112, height: 80};
const PIECE_IMAGE = {width: 180, height: 225};

// What the layout check measured about the page, named for what it found.
const LAYOUT_LABELS: Readonly<Record<string, string>> = {
	clipped_text: 'Clipped text',
	off_canvas: 'Text off canvas',
	overlap: 'Overlapping text',
	safe_area: 'Text in unsafe area',
	tight_edge: 'Text tight to edge',
};

// Fallback when a review check has no detail: name the thing measured, never a verdict on it.
const REVIEW_LABELS: Readonly<Record<string, string>> = {
	black_frames: 'Black frames',
	frozen_frames: 'Frozen frames',
	silence: 'Silence',
	loudness: 'Loudness',
	true_peak: 'Peaks',
	blank: 'Brightness',
	dimensions: 'Image size',
	resolution: 'Frame size',
	audio_present: 'Audio track',
	duration: 'Duration',
};

type JsonObject = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonObject | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	return value as JsonObject;
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstText(result: readonly unknown[] | undefined): string | undefined {
	for (const item of result ?? []) {
		const record = asRecord(item);
		if (record?.type === 'text' && typeof record.text === 'string') return record.text;
	}
	return undefined;
}

function parseJson(text: string | undefined): JsonObject | undefined {
	if (text === undefined) return undefined;
	try {
		return asRecord(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function sizeOf(input: unknown): Size | undefined {
	const record = asRecord(input);
	const width = asNumber(record?.width);
	const height = asNumber(record?.height);
	return width !== undefined && height !== undefined ? {width, height} : undefined;
}

// A design renders at its width and height times its scale, so the input alone understates a 2x.
function outputSizeOf(input: unknown): Size | undefined {
	const size = sizeOf(input);
	if (size === undefined) return undefined;
	const scale = asNumber(asRecord(input)?.scale) ?? 1;
	return {width: Math.round(size.width * scale), height: Math.round(size.height * scale)};
}

const sizeLabel = (size: Size): string => `${size.width} × ${size.height}`;

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';

function hasElements(capabilities: readonly string[], names: readonly string[]): boolean {
	return names.every(name => capabilities.includes(name));
}

function headline(params: {
	readonly state: StatusNode['state'];
	readonly text: string;
	readonly capabilities: readonly string[];
}): FeedNode {
	if (hasElements(params.capabilities, ['status'])) {
		return {type: 'status', state: params.state, text: params.text};
	}
	return {type: 'text', text: params.text, bold: true};
}

const dim = (text: string): FeedNode => ({type: 'text', text, dim: true});

function spaced(id: string): string {
	const text = id.replace(/_/g, ' ');
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// A check's own words are the only claim about the file that is certainly true, so the chip
// uses the first clause of its detail, cut to a chip's width.
function chipText(detail: string): string {
	const clause = detail.split(/[,;:]/)[0]?.trim() ?? '';
	const text = clause === '' ? detail.trim() : clause;
	const cut = text.length <= CHIP_CHARS ? text : `${text.slice(0, CHIP_CHARS - 1).replace(/\s+\S*$/, '')}…`;
	return `${cut.charAt(0).toUpperCase()}${cut.slice(1)}`;
}

interface Chip {
	readonly label: string;
	readonly color: 'red' | 'yellow';
}

// Failures first so the three shown are the ones that matter.
function chipsOf(review: JsonObject | undefined, layout: JsonObject | undefined): readonly Chip[] {
	const checks = asArray(review?.issues).flatMap((issue): readonly Chip[] => {
		const record = asRecord(issue);
		const id = asString(record?.id);
		if (id === undefined) return [];
		const detail = asString(record?.detail);
		const label = detail === undefined ? (REVIEW_LABELS[id] ?? spaced(id)) : chipText(detail);
		return [{label, color: record?.status === 'fail' ? 'red' : 'yellow'}];
	});
	const layouts = asArray(layout?.issues).flatMap((issue): readonly Chip[] => {
		const kind = asString(asRecord(issue)?.kind);
		return kind === undefined ? [] : [{label: LAYOUT_LABELS[kind] ?? spaced(kind), color: 'yellow'}];
	});
	const ordered = [...checks.filter(c => c.color === 'red'), ...checks.filter(c => c.color === 'yellow'), ...layouts];
	const seen = new Set<string>();
	return ordered.filter(chip => {
		if (seen.has(chip.label)) return false;
		seen.add(chip.label);
		return true;
	});
}

// "All checks passed" is a claim about every check that exists for the piece. A design also has
// a layout check, and when it did not run the card says so instead.
function chipRow(params: {
	readonly review: JsonObject | undefined;
	readonly layout: JsonObject | undefined;
	readonly expectLayout: boolean;
}): FeedNode {
	const {review, layout, expectLayout} = params;
	const chips = chipsOf(review, layout);
	if (chips.length === 0) {
		if (review?.verdict !== 'pass') return {type: 'row', children: [dim('Review unavailable')]};
		if (expectLayout && layout === undefined) return {type: 'row', children: [dim('Layout not checked')]};
		return {type: 'row', children: [{type: 'text', text: 'All checks passed', color: 'green'}]};
	}
	const shown: readonly FeedNode[] = chips
		.slice(0, CHIP_LIMIT)
		.map(chip => ({type: 'text', text: chip.label, color: chip.color}));
	const hidden = chips.length - CHIP_LIMIT;
	return {type: 'row', children: hidden > 0 ? [...shown, dim(`+${hidden} more`)] : shown};
}

function pendingCard(input: JsonObject | undefined, capabilities: readonly string[]): readonly FeedNode[] {
	const engine = asString(input?.engine) ?? 'media';
	const title = plainTitle(input?.title, engine);
	const size = outputSizeOf(asRecord(input?.input));
	const meta = engine === 'voice' ? 'voiceover' : [engine, size ? sizeLabel(size) : undefined].filter(Boolean).join(' · ');
	const body = [headline({state: 'running', text: `Making ${title}`, capabilities}), dim(meta)];
	return hasElements(capabilities, ['stack']) ? [{type: 'stack', direction: 'column', children: body}] : body;
}

const JOB_FAILURE = /^Job \S+ (failed|uncertain|cancelled): ([\s\S]*)$/;

// The model reads the whole failure; the card has room for its first line.
function errorCard(input: JsonObject | undefined, result: readonly unknown[] | undefined, deps: FeedCardDeps): readonly FeedNode[] {
	const {capabilities} = deps;
	const title = plainTitle(input?.title, asString(input?.engine) ?? 'media');
	const text = firstText(result)?.trim() ?? '';
	const failure = JOB_FAILURE.exec(text);
	const state = failure?.[1];
	const message = firstLine(failure?.[2] ?? text).slice(0, ERROR_CHARS);
	const headlineText = state === 'cancelled' ? `Stopped ${title}` : state === 'uncertain' ? `Could not finish ${title}` : `Could not make ${title}`;
	const body: readonly FeedNode[] = [
		headline({state: 'error', text: headlineText, capabilities}),
		...(message && state !== 'cancelled' ? [dim(message)] : []),
		{type: 'button', label: 'Open in gallery', onPress: deps.openGallery},
	];
	return hasElements(capabilities, ['stack']) ? [{type: 'stack', direction: 'column', children: body}] : body;
}

function successCard(params: {
	readonly input: JsonObject | undefined;
	readonly result: readonly unknown[] | undefined;
	readonly deps: FeedCardDeps;
}): readonly FeedNode[] {
	const {input, result, deps} = params;
	const {capabilities} = deps;
	const parsed = parseJson(firstText(result));
	const engine = asString(input?.engine) ?? 'media';
	const title = plainTitle(input?.title, engine);
	const output = asRecord(asArray(parsed?.outputs)[0]);
	const review = asRecord(asArray(parsed?.reviews)[0]);
	const probe = asRecord(review?.probe);
	const size = sizeOf(probe) ?? outputSizeOf(asRecord(input?.input));
	const durationS = asNumber(probe?.durationS);
	const meta = [engine, size ? sizeLabel(size) : undefined, durationS ? `${Number(durationS.toFixed(1))}s` : undefined]
		.filter(Boolean)
		.join(' · ');
	const body: readonly FeedNode[] = [
		headline({state: 'done', text: title, capabilities}),
		dim(meta),
		...(review === undefined && parsed === undefined
			? []
			: [chipRow({review, layout: asRecord(asArray(parsed?.layout)[0]), expectLayout: engine === 'design'})]),
		{type: 'button', label: 'Open in gallery', onPress: deps.openGallery},
	];
	if (!hasElements(capabilities, ['image', 'stack'])) return body;

	const jobId = asString(parsed?.job_id);
	const src = jobId === undefined ? undefined : deps.readPreview(jobId);
	const column: FeedNode = {type: 'stack', direction: 'column', children: body};
	if (src === undefined) return [column];
	const box = size !== undefined && size.height > size.width ? PORTRAIT_THUMB : LANDSCAPE_THUMB;
	const image: FeedNode = {
		type: 'image',
		src,
		alt: title,
		...box,
		fit: 'cover',
		...(output?.kind === 'video' ? {badge: 'play' as const} : {}),
	};
	return [{type: 'stack', direction: 'row', align: 'start', children: [image, column]}];
}

interface Piece {
	readonly title: string;
	readonly size: string | undefined;
	readonly src: string | undefined;
}

function pieceOf(jobId: string, job: Job, deps: FeedCardDeps): Piece {
	const size = job.size ?? outputSizeOf(job.input);
	return {
		title: plainTitle(job.title, job.engine),
		size: size ? sizeLabel(size) : undefined,
		src: deps.readPreview(jobId),
	};
}

// Counts the distinct pieces that really loaded, shows the first few, and says how many more.
function deliveredCard(input: JsonObject | undefined, deps: FeedCardDeps): readonly FeedNode[] | undefined {
	const ids = [...new Set(asArray(input?.job_ids).filter((id): id is string => typeof id === 'string'))];
	const loaded = ids.flatMap((id): readonly {readonly id: string; readonly job: Job}[] => {
		const job = deps.readJob(id);
		return job === undefined ? [] : [{id, job}];
	});
	if (loaded.length === 0) return undefined;
	const note = plainNote(input?.note);
	const hidden = loaded.length - PRESENT_LIMIT;
	const more: readonly FeedNode[] = hidden > 0 ? [dim(`+${hidden} more`)] : [];
	const header: FeedNode = {
		type: 'row',
		children: [
			{type: 'text', text: 'Delivered', bold: true},
			dim(loaded.length === 1 ? '1 piece' : `${loaded.length} pieces`),
		],
	};
	const pieces = loaded.slice(0, PRESENT_LIMIT).map(({id, job}) => pieceOf(id, job, deps));
	const intro: readonly FeedNode[] = [header, ...(note === '' ? [] : [{type: 'text', text: note} satisfies FeedNode])];

	if (!hasElements(deps.capabilities, ['image', 'stack'])) {
		return [...intro, ...pieces.map(piece => dim([piece.title, piece.size].filter(Boolean).join(' · '))), ...more];
	}
	const columns: readonly FeedNode[] = pieces.map(piece => ({
		type: 'stack',
		direction: 'column',
		children: [
			...(piece.src === undefined
				? []
				: [{type: 'image', src: piece.src, alt: piece.title, ...PIECE_IMAGE, fit: 'contain'} satisfies FeedNode]),
			{
				type: 'row',
				children: [{type: 'text', text: piece.title}, ...(piece.size ? [dim(piece.size)] : [])],
			},
		],
	}));
	return [{type: 'stack', direction: 'column', children: [...intro, {type: 'stack', direction: 'row', align: 'start', children: columns}, ...more]}];
}

// undefined keeps the host's built-in row. The host calls this synchronously on every repaint,
// so everything it needs comes from deps that read the disk with sync calls.
export function toolRowCard(props: ToolRowProps, deps: FeedCardDeps): readonly FeedNode[] | undefined {
	const input = asRecord(props.input);
	if (props.toolName === 'atelier_create') {
		if (props.status === 'pending') return pendingCard(input, deps.capabilities);
		if (props.status === 'error') return errorCard(input, props.result, deps);
		return successCard({input, result: props.result, deps});
	}
	if (props.toolName === 'atelier_present' && props.status === 'success') return deliveredCard(input, deps);
	return undefined;
}
