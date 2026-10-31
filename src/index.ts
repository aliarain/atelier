import {randomBytes} from 'node:crypto';
import type {AgentMessage, ModApi} from '@commandcode/harness';
import {ENGINES, findEngine} from './engines/index.ts';
import {execFileExec, mediaKindOf} from './exec.ts';
import {startGallery, type GalleryHandle} from './gallery.ts';
import {
	isPidAlive,
	loadJob,
	loadJobs,
	markPresented,
	saveJob,
	settleOrphan,
	studioDir,
} from './jobs.ts';
import {
	FRESH_RUN,
	midRunNudge,
	plainTitle,
	type RunProgress,
	stopNudge,
	studioReminder,
	trackTool,
} from './policy.ts';
import {reviewMedia} from './review.ts';
import {previewOf, runJob} from './runner.ts';
import type {Engine, Job, Review} from './types.ts';

type ToolContent =
	| {readonly type: 'text'; readonly text: string}
	| {
			readonly type: 'image';
			readonly source: {
				readonly type: 'base64';
				readonly media_type: string;
				readonly data: string;
			};
	  };

type ToolOutcome =
	| {readonly ok: true; readonly content: readonly ToolContent[]}
	| {readonly ok: false; readonly error: string};

// Byte-stable on purpose: anything that changes per round goes through transformContext.
const STUDIO_PROMPT = `<studio>
You can make images, voiceovers and videos with the studio tools. Work like a designer:
1. Decide the format, size and story before making anything.
2. Make with studio_create. Each call returns a measured review and, for images and video, a preview you can see. Fix any "fail" check before showing work.
3. Show finished work with studio_present and a one-line note. The person watches a live gallery.
The design engine renders your HTML and CSS in Chrome at the exact pixel size, so write real layouts with real copy. The video engine cannot draw text: put words in rendered stills. Never re-run an "uncertain" job without asking, it may already be paid for.
Load the studio-* skills for craft rules before a first design or video.
</studio>`;

const text = (value: string): ToolContent => ({type: 'text', text: value});
const json = (value: unknown): ToolContent => text(JSON.stringify(value, null, 2));

function reviewSummary(review: Review): unknown {
	return {
		verdict: review.verdict,
		probe: review.probe,
		issues: review.checks.filter(check => check.status !== 'pass'),
	};
}

function engineCard(engine: Engine, available: {ok: boolean; reason?: string}): unknown {
	return {
		id: engine.id,
		kind: engine.kind,
		paid: engine.paid,
		summary: engine.summary,
		available: available.ok,
		...(available.ok ? {} : {reason: available.reason}),
		input_schema: engine.inputSchema,
	};
}

function withReminder(
	messages: readonly AgentMessage[],
	reminder: string,
): readonly AgentMessage[] {
	const last = messages.at(-1);
	if (last?.role !== 'user') return messages;
	const tail: AgentMessage = {
		...last,
		content: [...last.content, {type: 'text', text: reminder}],
	};
	return [...messages.slice(0, -1), tail];
}

function stringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string');
}

export default function studio(cmd: ModApi): void {
	let sessionId = 'local';
	let progress: RunProgress = FRESH_RUN;
	let gallery: GalleryHandle | undefined;
	const running = new Map<string, string>();
	const token = randomBytes(16).toString('hex');
	const now = (): number => Date.now();
	const deps = {exec: execFileExec, env: process.env, fetch: globalThis.fetch};

	const ensureGallery = async (): Promise<GalleryHandle> => {
		gallery ??= await startGallery({cwd: cmd.cwd, token});
		return gallery;
	};

	const refreshStatus = (): void => {
		const titles = [...running.values()];
		cmd.ui.setStatus(titles.length === 0 ? null : `studio: making ${titles.join(', ')}`);
		cmd.ui.refreshWidgets();
	};

	const settleOrphans = async (): Promise<void> => {
		const jobs = await loadJobs(cmd.cwd);
		for (const job of jobs) {
			const settled = settleOrphan(job, {isAlive: isPidAlive, now: now()});
			if (settled !== job) await saveJob(cmd.cwd, settled);
		}
	};

	cmd.addFlag('studio-allow-paid', {
		type: 'boolean',
		default: false,
		description: 'Run paid engines without asking first (headless runs cannot ask).',
	});

	cmd.hooks({
		onSessionStart: async ({sessionId: id}) => {
			sessionId = id ?? sessionId;
			await settleOrphans();
		},
		onSessionEnd: async () => {
			await gallery?.close();
			gallery = undefined;
		},
		appendSystemPrompt: () => STUDIO_PROMPT,
		transformContext: async ({messages}) => {
			const reminder = studioReminder(await loadJobs(cmd.cwd), sessionId);
			return reminder === undefined ? messages : withReminder(messages, reminder);
		},
		// Reading an image the studio is still writing returns half a file.
		beforeToolCall: async ({toolName, input}) => {
			if (toolName !== 'read_file' || running.size === 0) return undefined;
			const path = typeof input.file_path === 'string' ? input.file_path : '';
			if (!path.startsWith(studioDir(cmd.cwd))) return undefined;
			if (![...running.keys()].some(id => path.includes(id))) return undefined;
			return {
				block: true,
				additionalContext: 'That studio job is still rendering. studio_create returns its outputs when it finishes.',
			};
		},
		afterToolCall: async ({toolName, isError}) => {
			if (toolName === 'studio_present' && !isError) {
				progress = trackTool(progress, {type: 'presented'});
				return undefined;
			}
			if (toolName !== 'studio_create') return undefined;
			progress = trackTool(progress, {type: 'created', ok: !isError});
			const nudge = midRunNudge(progress);
			progress = nudge.progress;
			return nudge.text === undefined ? undefined : {additionalContext: nudge.text};
		},
		onStop: async () => {
			const nudge = stopNudge(progress);
			progress = nudge.progress;
			return nudge.reason === undefined ? undefined : {continue: true, reason: nudge.reason};
		},
	});

	cmd.on('run_start', () => {
		progress = FRESH_RUN;
	});

	cmd.addTool({
		alwaysLoad: true,
		readOnly: true,
		schema: {
			name: 'studio_engines',
			label: 'STUDIO',
			description: 'List the studio engines (design images, voiceover, video, paid AI images), whether each works on this machine, and the exact input schema each takes. Call once before your first studio_create.',
			input_schema: {type: 'object', properties: {}, required: []},
		},
		run: async (): Promise<ToolOutcome> => {
			const cards = await Promise.all(
				ENGINES.map(async engine => engineCard(engine, await engine.available(deps))),
			);
			return {ok: true, content: [json(cards)]};
		},
	});

	cmd.addTool({
		alwaysLoad: true,
		schema: {
			name: 'studio_create',
			label: 'STUDIO',
			description: 'Make one piece of media with a studio engine and wait for it. Returns the job, its output files, a measured review (fix "fail" checks before presenting) and a preview image you can see. Get each engine\'s input schema from studio_engines.',
			input_schema: {
				type: 'object',
				properties: {
					engine: {type: 'string', enum: ENGINES.map(engine => engine.id)},
					title: {type: 'string', description: 'Short human title shown in the gallery, e.g. "Launch poster v2".'},
					input: {type: 'object', description: 'Engine input, exactly as its input_schema describes.'},
				},
				required: ['engine', 'title', 'input'],
			},
		},
		run: async ({input, signal}): Promise<ToolOutcome> => {
			const engine = findEngine(String(input.engine));
			if (!engine) {
				return {ok: false, error: `Unknown engine "${String(input.engine)}". Engines: ${ENGINES.map(e => e.id).join(', ')}.`};
			}
			const parsed = engine.parse(input.input);
			if (!parsed.ok) return {ok: false, error: `Invalid ${engine.id} input: ${parsed.error}`};
			const available = await engine.available(deps);
			if (!available.ok) return {ok: false, error: `${engine.id} is not available: ${available.reason}`};

			if (engine.paid && cmd.getFlag('studio-allow-paid') !== true) {
				const approved = await cmd.ui.confirm({
					title: `Run paid engine ${engine.id}?`,
					message: `"${String(input.title)}" calls a paid provider and may cost money.`,
				});
				if (!approved) return {ok: false, error: 'The person did not approve this paid run. Offer a free engine or ask them.'};
			}

			const title = plainTitle(input.title, engine.id);
			const controller = new AbortController();
			signal?.addEventListener('abort', () => controller.abort(), {once: true});
			const job = await runJob({
				cwd: cmd.cwd,
				sessionId,
				engine,
				input: parsed.value,
				title,
				...deps,
				signal: controller.signal,
				now,
				onChange: changed => {
					if (changed.state === 'running') running.set(changed.id, changed.title);
					if (changed.state !== 'running') running.delete(changed.id);
					refreshStatus();
				},
			});
			if (job.state !== 'completed') {
				return {ok: false, error: `Job ${job.id} ${job.state}: ${job.error?.message ?? 'no detail'}`};
			}

			const reviews = await Promise.all(
				job.outputs.map(output => reviewMedia({path: output.path, exec: execFileExec}).catch(() => undefined)),
			);
			const first = job.outputs[0];
			const preview = first
				? await previewOf({output: first, exec: execFileExec, durationS: reviews[0]?.probe.durationS})
				: undefined;
			const content: ToolContent[] = [
				json({
					job_id: job.id,
					state: job.state,
					outputs: job.outputs,
					reviews: reviews.map(review => (review ? reviewSummary(review) : 'review unavailable')),
				}),
			];
			if (preview) content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: preview}});
			return {ok: true, content};
		},
	});

	cmd.addTool({
		alwaysLoad: true,
		readOnly: true,
		schema: {
			name: 'studio_review',
			label: 'STUDIO',
			description: 'Measure an image, video or audio file: size, duration, black or frozen frames, silence, loudness and peaks. Use it on files you did not make with studio_create.',
			input_schema: {
				type: 'object',
				properties: {path: {type: 'string', description: 'Absolute path to the media file.'}},
				required: ['path'],
			},
		},
		run: async ({input, signal}): Promise<ToolOutcome> => {
			const path = String(input.path ?? '');
			if (!mediaKindOf(path)) return {ok: false, error: `Not a media file the studio can review: ${path}`};
			const review = await reviewMedia({path, exec: execFileExec, signal}).catch((error: unknown) =>
				error instanceof Error ? error : new Error(String(error)),
			);
			if (review instanceof Error) return {ok: false, error: review.message};
			return {ok: true, content: [json(review)]};
		},
	});

	cmd.addTool({
		alwaysLoad: true,
		readOnly: true,
		schema: {
			name: 'studio_jobs',
			label: 'STUDIO',
			description: 'List studio jobs with their state, outputs and errors. Defaults to this conversation; scope "project" lists every job in the project.',
			input_schema: {
				type: 'object',
				properties: {
					scope: {type: 'string', enum: ['session', 'project']},
					limit: {type: 'integer', minimum: 1, maximum: 100},
				},
				required: [],
			},
		},
		run: async ({input}): Promise<ToolOutcome> => {
			const all = await loadJobs(cmd.cwd);
			const scoped = input.scope === 'project' ? all : all.filter(job => job.sessionId === sessionId);
			const limit = typeof input.limit === 'number' ? input.limit : 20;
			return {ok: true, content: [json(scoped.slice(0, limit))]};
		},
	});

	cmd.addTool({
		alwaysLoad: true,
		schema: {
			name: 'studio_present',
			label: 'STUDIO',
			description: 'Show finished work to the person: marks the jobs as delivered in the live gallery and returns the gallery URL. Use it for final or milestone outputs, with a one-line note.',
			input_schema: {
				type: 'object',
				properties: {
					job_ids: {type: 'array', items: {type: 'string'}, minItems: 1},
					note: {type: 'string', description: 'One line on what this is and what changed.'},
				},
				required: ['job_ids', 'note'],
			},
		},
		run: async ({input}): Promise<ToolOutcome> => {
			const ids = stringArray(input.job_ids);
			const jobs = await Promise.all(ids.map(id => loadJob(cmd.cwd, id)));
			const missing = ids.filter((_, index) => jobs[index] === undefined);
			if (missing.length > 0) return {ok: false, error: `Unknown job ids: ${missing.join(', ')}`};
			const unfinished = jobs.filter((job): job is Job => job !== undefined && job.state !== 'completed');
			if (unfinished.length > 0) {
				return {ok: false, error: `Only completed jobs can be presented: ${unfinished.map(job => `${job.id} is ${job.state}`).join(', ')}`};
			}
			const done = jobs.filter((job): job is Job => job !== undefined).map(job => markPresented(job, now()));
			await Promise.all(done.map(job => saveJob(cmd.cwd, job)));
			const handle = await ensureGallery();
			const note = String(input.note ?? '').slice(0, 300);
			cmd.ui.toast(`Studio: ${note}`, {level: 'success'});
			return {
				ok: true,
				content: [
					json({
						gallery_url: handle.url,
						presented: done.map(job => ({job_id: job.id, title: job.title, outputs: job.outputs.map(o => o.path)})),
					}),
					text('Tell the person what you made in one line and include the gallery URL so they can open it.'),
				],
			};
		},
	});

	cmd.ui.pane({
		id: 'studio',
		title: 'Studio',
		render: () => {
			const url = gallery?.url;
			const busy = [...running.values()];
			return [
				{type: 'text', text: busy.length > 0 ? `Making: ${busy.join(', ')}` : 'Idle', bold: true},
				{type: 'text', text: url ? `Gallery: ${url}` : 'Gallery starts when work is presented, or press g.', dim: true},
				{
					type: 'row',
					children: [
						{
							type: 'button',
							label: 'Open gallery',
							hotkey: 'g',
							onPress: async () => {
								const handle = await ensureGallery();
								await execFileExec({command: 'open', args: [handle.url]});
								cmd.ui.refreshWidgets();
							},
						},
					],
				},
			];
		},
	});

	cmd.addCommand({
		name: 'studio',
		description: 'Open the studio pane and its live gallery link',
		handler: async () => {
			await ensureGallery();
			cmd.ui.openPane('studio');
			return {message: `Studio gallery: ${gallery?.url ?? 'starting'}`};
		},
	});
}
