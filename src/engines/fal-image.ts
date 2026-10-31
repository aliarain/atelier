import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {engineFailure} from '../exec.ts';
import type {EngineFailure} from '../exec.ts';
import type {
	Availability,
	Engine,
	EngineRunContext,
	MediaOutput,
	Parsed,
} from '../types.ts';

const DEFAULT_MODEL = 'fal-ai/flux/schnell';
const MODEL_PATTERN = /^[a-z0-9-]+\/[a-z0-9./-]+$/;
const IMAGE_SIZES = [
	'square_hd',
	'square',
	'portrait_4_3',
	'portrait_16_9',
	'landscape_4_3',
	'landscape_16_9',
] as const;
const DEFAULT_IMAGE_SIZE = 'portrait_4_3';
const MAX_PROMPT_CHARS = 4000;
const BODY_TAIL_CHARS = 300;

export type FalImageSize = (typeof IMAGE_SIZES)[number];

export interface FalImageInput {
	readonly prompt: string;
	readonly model: string;
	readonly image_size: FalImageSize;
	readonly seed?: number;
}

export interface FalRequest {
	readonly url: string;
	readonly init: {
		readonly method: 'POST';
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
	};
}

type RawInput = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RawInput {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImageSize(value: unknown): value is FalImageSize {
	return IMAGE_SIZES.some(size => size === value);
}

export function parseFalImageInput(raw: unknown): Parsed<FalImageInput> {
	if (!isRecord(raw)) return {ok: false, error: 'input must be an object'};

	const prompt = raw.prompt;
	if (typeof prompt !== 'string' || prompt.trim() === '') {
		return {ok: false, error: 'prompt is required and must be a non-empty string'};
	}
	if (prompt.length > MAX_PROMPT_CHARS) {
		return {ok: false, error: `prompt must be at most ${MAX_PROMPT_CHARS} characters`};
	}

	const model = raw.model ?? DEFAULT_MODEL;
	if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
		return {
			ok: false,
			error: 'model must look like "fal-ai/flux/schnell" (lowercase owner/name)',
		};
	}

	const imageSize = raw.image_size ?? DEFAULT_IMAGE_SIZE;
	if (!isImageSize(imageSize)) {
		return {ok: false, error: `image_size must be one of ${IMAGE_SIZES.join(', ')}`};
	}

	const seed = raw.seed;
	if (seed !== undefined && !Number.isSafeInteger(seed)) {
		return {ok: false, error: 'seed must be an integer'};
	}

	return {
		ok: true,
		value: {
			prompt,
			model,
			image_size: imageSize,
			...(typeof seed === 'number' ? {seed} : {}),
		},
	};
}

export function falRequest(input: FalImageInput, key: string): FalRequest {
	return {
		url: `https://fal.run/${input.model}`,
		init: {
			method: 'POST',
			headers: {
				Authorization: `Key ${key}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				prompt: input.prompt,
				image_size: input.image_size,
				num_images: 1,
				...(input.seed === undefined ? {} : {seed: input.seed}),
			}),
		},
	};
}

export function falImageUrls(json: unknown): readonly string[] {
	if (!isRecord(json) || !Array.isArray(json.images)) return [];
	return json.images.flatMap((image: unknown): readonly string[] => {
		if (!isRecord(image) || typeof image.url !== 'string') return [];
		return [image.url];
	});
}

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/webp': 'webp',
};

export function imageExtension(contentType: string | null): string | undefined {
	const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	return EXTENSION_BY_CONTENT_TYPE[mime];
}

function statusFailure(status: number, body: string): EngineFailure | undefined {
	if (status >= 200 && status < 300) return undefined;
	if (status === 401 || status === 403) {
		return engineFailure({
			code: 'auth',
			message: `fal.ai rejected the key (HTTP ${status}). Check FAL_KEY.`,
			retryable: false,
		});
	}
	if (status === 429 || status >= 500) {
		return engineFailure({
			code: 'provider_busy',
			message: `fal.ai is busy or rate limited (HTTP ${status}). Try again shortly.`,
			retryable: true,
		});
	}
	return engineFailure({
		code: 'request_rejected',
		message: `fal.ai rejected the request (HTTP ${status}): ${body.slice(0, BODY_TAIL_CHARS)}`,
		retryable: false,
	});
}

// An abort is the person cancelling, not a network fault, so it passes through untouched.
async function send(
	ctx: EngineRunContext,
	url: string,
	init: RequestInit,
): Promise<Response> {
	try {
		return await ctx.fetch(url, {...init, signal: ctx.signal});
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		throw engineFailure({
			code: 'network',
			message: `Network error talking to fal.ai: ${error instanceof Error ? error.message : String(error)}`,
			retryable: true,
		});
	}
}

async function readOk(response: Response): Promise<Response> {
	const failure = statusFailure(
		response.status,
		response.ok ? '' : await response.text(),
	);
	if (failure !== undefined) throw failure;
	return response;
}

export const falImageEngine: Engine<FalImageInput> = {
	id: 'fal-image',
	kind: 'image',
	paid: true,
	summary:
		'Generate an image from a text prompt with a fal.ai model (default FLUX schnell). Paid per image; use for photos and illustrations, not for exact text or layouts (use design for those).',
	inputSchema: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description: 'What to draw. Describe subject, style, lighting and composition.',
			},
			model: {
				type: 'string',
				description: `A fal.ai model path. Default ${DEFAULT_MODEL}.`,
			},
			image_size: {
				type: 'string',
				enum: [...IMAGE_SIZES],
				description: `Aspect preset. Default ${DEFAULT_IMAGE_SIZE}.`,
			},
			seed: {
				type: 'integer',
				description: 'Repeat a result by passing the same seed.',
			},
		},
		required: ['prompt'],
	},
	parse: parseFalImageInput,
	available: async ({env}): Promise<Availability> =>
		env.FAL_KEY === undefined || env.FAL_KEY === ''
			? {ok: false, reason: 'Set FAL_KEY to use fal.ai models.'}
			: {ok: true},
	run: async ({input, ctx}): Promise<readonly MediaOutput[]> => {
		const key = ctx.env.FAL_KEY;
		if (key === undefined || key === '') {
			throw engineFailure({
				code: 'auth',
				message: 'Set FAL_KEY to use fal.ai models.',
				retryable: false,
			});
		}

		const request = falRequest(input, key);
		const generated = await readOk(await send(ctx, request.url, request.init));
		const imageUrl = falImageUrls(await generated.json().catch(() => undefined))[0];
		if (imageUrl === undefined) {
			throw engineFailure({
				code: 'no_image',
				message: 'fal.ai answered without an image. The prompt may have been filtered.',
				retryable: false,
			});
		}

		const download = await readOk(await send(ctx, imageUrl, {method: 'GET'}));
		const extension = imageExtension(download.headers.get('content-type'));
		if (extension === undefined) {
			throw engineFailure({
				code: 'bad_response',
				message: `fal.ai returned an unsupported image type: ${download.headers.get('content-type') ?? 'none'}.`,
				retryable: false,
			});
		}

		const path = join(ctx.outDir, `fal-image.${extension}`);
		const bytes = Buffer.from(await download.arrayBuffer());
		await writeFile(path, bytes);
		return [{path, kind: 'image', bytes: bytes.length}];
	},
};
