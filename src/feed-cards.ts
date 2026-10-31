import {plainTitle} from './policy.ts';
import type {Job} from './types.ts';

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
const ERROR_CHARS = 140;
const PORTRAIT_THUMB = {width: 64, height: 80};
const LANDSCAPE_THUMB = {width: 112, height: 80};
const PIECE_IMAGE = {width: 180, height: 225};

const CHECK_LABELS: Readonly<Record<string, string>> = {
	clipped_text: 'Clipped text',
	off_canvas: 'Text off canvas',
	overlap: 'Overlapping text',
	safe_area: 'Text in unsafe area',
	tight_edge: 'Text tight to edge',
	black_frames: 'Black frames',
	frozen_frames: 'Frozen frames',
	silence: 'Silence',
	loudness: 'Loudness',
	true_peak: 'Clipping peaks',
	blank: 'Blank render',
	dimensions: 'Small size',
	resolution: 'Low resolution',
	audio_present: 'No audio',
	duration: 'Too short',
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

function sizeOf(input: unknown): {readonly width: number; readonly height: number} | undefined {
	const record = asRecord(input);
	const width = asNumber(record?.width);
	const height = asNumber(record?.height);
	return width !== undefined && height !== undefined ? {width, height} : undefined;
}

const sizeLabel = (size: {readonly width: number; readonly height: number}): string =>
	`${size.width} × ${size.height}`;

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

function labelOf(id: string): string {
	const known = CHECK_LABELS[id];
	if (known !== undefined) return known;
	const spaced = id.replace(/_/g, ' ');
	return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
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
		return [{label: labelOf(id), color: record?.status === 'fail' ? 'red' : 'yellow'}];
	});
	const layouts = asArray(layout?.issues).flatMap((issue): readonly Chip[] => {
		const kind = asString(asRecord(issue)?.kind);
		return kind === undefined ? [] : [{label: labelOf(kind), color: 'yellow'}];
	});
	const ordered = [...checks.filter(c => c.color === 'red'), ...checks.filter(c => c.color === 'yellow'), ...layouts];
	const seen = new Set<string>();
	return ordered.filter(chip => {
		if (seen.has(chip.label)) return false;
		seen.add(chip.label);
		return true;
	});
}

function chipRow(review: JsonObject | undefined, layout: JsonObject | undefined): FeedNode {
	const chips = chipsOf(review, layout);
	if (chips.length === 0) {
		const verdict = review?.verdict;
		return verdict === 'pass'
			? {type: 'row', children: [{type: 'text', text: 'All checks passed', color: 'green'}]}
			: {type: 'row', children: [dim('Review unavailable')]};
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
	const size = sizeOf(asRecord(input?.input));
	const meta = engine === 'voice' ? 'voiceover' : [engine, size ? sizeLabel(size) : undefined].filter(Boolean).join(' · ');
	const body = [headline({state: 'running', text: `Making ${title}`, capabilities}), dim(meta)];
	return hasElements(capabilities, ['stack']) ? [{type: 'stack', direction: 'column', children: body}] : body;
}

function errorCard(input: JsonObject | undefined, result: readonly unknown[] | undefined, capabilities: readonly string[]): readonly FeedNode[] {
	const title = plainTitle(input?.title, asString(input?.engine) ?? 'media');
	const message = firstText(result)?.trim().slice(0, ERROR_CHARS);
	const body: readonly FeedNode[] = [
		headline({state: 'error', text: `Could not make ${title}`, capabilities}),
		...(message ? [dim(message)] : []),
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
	const size = sizeOf(probe) ?? sizeOf(asRecord(input?.input));
	const durationS = asNumber(probe?.durationS);
	const meta = [engine, size ? sizeLabel(size) : undefined, durationS ? `${Number(durationS.toFixed(1))}s` : undefined]
		.filter(Boolean)
		.join(' · ');
	const body: readonly FeedNode[] = [
		headline({state: 'done', text: title, capabilities}),
		dim(meta),
		...(review === undefined && parsed === undefined ? [] : [chipRow(review, asRecord(asArray(parsed?.layout)[0]))]),
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

function pieceOf(jobId: string, deps: FeedCardDeps): Piece | undefined {
	const job = deps.readJob(jobId);
	if (job === undefined) return undefined;
	const size = sizeOf(job.input);
	return {
		title: plainTitle(job.title, job.engine),
		size: size ? sizeLabel(size) : undefined,
		src: deps.readPreview(jobId),
	};
}

function deliveredCard(input: JsonObject | undefined, deps: FeedCardDeps): readonly FeedNode[] {
	const ids = asArray(input?.job_ids).filter((id): id is string => typeof id === 'string');
	const note = asString(input?.note);
	const header: FeedNode = {
		type: 'row',
		children: [
			{type: 'text', text: 'Delivered', bold: true},
			dim(ids.length === 1 ? '1 piece' : `${ids.length} pieces`),
		],
	};
	const pieces = ids
		.slice(0, PRESENT_LIMIT)
		.map(id => pieceOf(id, deps))
		.filter((piece): piece is Piece => piece !== undefined);
	const intro: readonly FeedNode[] = [header, ...(note ? [{type: 'text', text: note} satisfies FeedNode] : [])];

	if (!hasElements(deps.capabilities, ['image', 'stack'])) {
		return [...intro, ...pieces.map(piece => dim([piece.title, piece.size].filter(Boolean).join(' · ')))];
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
	return [{type: 'stack', direction: 'column', children: [...intro, {type: 'stack', direction: 'row', align: 'start', children: columns}]}];
}

// undefined keeps the host's built-in row. The host calls this synchronously on every repaint,
// so everything it needs comes from deps that read the disk with sync calls.
export function toolRowCard(props: ToolRowProps, deps: FeedCardDeps): readonly FeedNode[] | undefined {
	const input = asRecord(props.input);
	if (props.toolName === 'atelier_create') {
		if (props.status === 'pending') return pendingCard(input, deps.capabilities);
		if (props.status === 'error') return errorCard(input, props.result, deps.capabilities);
		return successCard({input, result: props.result, deps});
	}
	if (props.toolName === 'atelier_present' && props.status === 'success') return deliveredCard(input, deps);
	return undefined;
}
