import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AgentMessage, ModApi} from '@commandcode/harness';
import {ENGINES, findEngine} from './engines/index.ts';
import {execFileExec, mediaKindOf} from './exec.ts';
import {
	type GalleryActionHandler,
	type GalleryActionResult,
	type GalleryHandle,
	startGallery,
} from './gallery.ts';
import {type ToolRowProps, toolRowCard} from './feed-cards.ts';
import {readsRunningJob} from './guard.ts';
import {
	createStartedAtReader,
	isFinished,
	isOwnerAlive,
	isPidAlive,
	loadJob,
	loadJobSync,
	loadJobs,
	markPresented,
	moveJob,
	PROCESS_STARTED_AT,
	saveJob,
	settleOrphan,
} from './jobs.ts';
import {
	atelierReminder,
	FRESH_RUN,
	midRunNudge,
	paidConfirmMessage,
	type PaidGate,
	paidGate,
	plainNote,
	plainTitle,
	type RunProgress,
	runningStatus,
	stillVideoFlag,
	stopNudge,
	trackTool,
} from './policy.ts';
import {type ElementCapabilities, paneNodes, supportsStatus} from './pane.ts';
import {reviewMedia} from './review.ts';
import {previewOf, readPreviewDataUrl, runJob} from './runner.ts';
import type {Engine, Job, JobError, Review} from './types.ts';

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
const ATELIER_PROMPT = `<atelier>
You can make images, voiceovers and videos with the atelier tools. Work like a designer:
1. Decide the format, size and story before making anything.
2. Make with atelier_create. Each call returns a measured review and, for images and video, a preview you can see. Fix any "fail" check before showing work.
3. Show finished work with atelier_present and a one-line note. The person watches a live gallery.
The design engine renders your HTML and CSS in Chrome at the exact pixel size, so write real layouts with real copy. The motion engine renders animated HTML and CSS (kinetic type, animated titles, logo reveals) frame by frame into a video. The video engine edits stills with camera moves, crossfades, voiceover and music, and cannot draw text: put words in rendered stills. Never re-run an "uncertain" job without asking, it may already be paid for: atelier_create refuses a paid engine that has one unless the person confirms a re-run (confirm_rerun).
Load the atelier-* skills for craft rules before a first design or video.
</atelier>`;

const GALLERY_VIEW = 'gallery';
const CLEAR: PaidGate = {kind: 'clear'};

interface ViewUi {
	readonly view?: (params: {
		readonly id: string;
		readonly title: string;
		readonly url: string;
	}) => {dispose(): void};
	readonly openView?: (id: string) => void;
	// Hosts that draw tool rows natively accept a replacement; others lack the method.
	readonly override?: (
		slot: 'tool_row',
		render: (props: ToolRowProps) => readonly unknown[] | undefined,
	) => unknown;
}

// The mod's own state survives a hot reload, so a running gallery and its token do too.
const GALLERY_STATE = 'gallery';
const TOKEN_STATE = 'gallery-token';

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

// The design engine leaves a layout.json beside its PNG when Chrome could measure the page.
async function layoutReport(outputPath: string): Promise<unknown> {
	const raw = await readFile(join(dirname(outputPath), 'layout.json'), 'utf8').catch(() => undefined);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
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

export default function atelier(cmd: ModApi): void {
	let sessionId = 'local';
	let progress: RunProgress = FRESH_RUN;
	let galleryStart: Promise<GalleryHandle> | undefined;
	let galleryView: {dispose(): void} | undefined;
	const running = new Map<string, string>();
	const token = cmd.state.get<string>(TOKEN_STATE) ?? randomBytes(16).toString('hex');
	cmd.state.set(TOKEN_STATE, token);
	const now = (): number => Date.now();
	const deps = {exec: execFileExec, env: process.env, fetch: globalThis.fetch};

	// Command Code builds that predate mod views lack these; the gallery link still works there.
	const viewUi = cmd.ui as ModApi['ui'] & ViewUi & ElementCapabilities;

	const onGalleryAction: GalleryActionHandler = async ({action, job}): Promise<GalleryActionResult> => {
		if (action === 'variant' && (job.state === 'failed' || job.state === 'cancelled')) {
			cmd.sendUserMessage(
				`Try atelier job ${job.id} ("${job.title}") again with the same brief. Its input is in atelier_jobs. Fix whatever stopped it.`,
			);
			return {ok: true, message: 'Asked to try again.'};
		}
		const first = job.outputs[0];
		if (job.state !== 'completed' || first === undefined) {
			return {ok: false, message: 'Nothing to work with yet.'};
		}
		if (action === 'reveal') {
			const result = await execFileExec({command: 'open', args: ['-R', first.path]});
			return result.code === 0
				? {ok: true, message: 'Shown in Finder.'}
				: {ok: false, message: 'Could not open Finder.'};
		}
		if (action === 'present') {
			await saveJob(cmd.cwd, markPresented(job, now()));
			cmd.ui.toast(`${job.title} marked as shown`, {level: 'success'});
			return {ok: true, message: 'Marked as shown.'};
		}
		cmd.sendUserMessage(
			`Make a variant of atelier job ${job.id} ("${job.title}"): keep the format and message, try a different composition.`,
		);
		return {ok: true, message: 'Asked for a variant.'};
	};

	const registerView = (handle: GalleryHandle): void => {
		galleryView?.dispose();
		galleryView = viewUi.view?.({id: GALLERY_VIEW, title: 'Atelier', url: handle.url});
	};

	// Two callers racing to open the gallery share one start, so only one server ever listens.
	const ensureGallery = (): Promise<GalleryHandle> => {
		galleryStart ??= startGallery({cwd: cmd.cwd, token, onAction: onGalleryAction}).then(
			handle => {
				cmd.state.set(GALLERY_STATE, handle);
				registerView(handle);
				return handle;
			},
			(error: unknown) => {
				galleryStart = undefined;
				throw error;
			},
		);
		return galleryStart;
	};

	const revealGallery = async (): Promise<GalleryHandle> => {
		const handle = await ensureGallery();
		if (galleryView === undefined) registerView(handle);
		viewUi.openView?.(GALLERY_VIEW);
		return handle;
	};

	// A hot reload ends this code and starts new code in the same session. The server and its
	// token live in cmd.state, so the new code adopts the running gallery.
	const adoptGallery = (): void => {
		const kept = cmd.state.get<GalleryHandle>(GALLERY_STATE);
		if (kept === undefined || galleryStart !== undefined) return;
		galleryStart = Promise.resolve(kept);
		registerView(kept);
	};

	const closeGallery = async (): Promise<void> => {
		galleryView?.dispose();
		galleryView = undefined;
		const start = galleryStart;
		galleryStart = undefined;
		cmd.state.set(GALLERY_STATE, undefined);
		const handle = await start?.catch(() => undefined);
		await handle?.close();
	};

	const refreshStatus = (): void => {
		cmd.ui.setStatus(runningStatus([...running.values()]));
		cmd.ui.refreshWidgets();
	};

	const settleOrphans = async (): Promise<void> => {
		const jobs = await loadJobs(cmd.cwd);
		const startedAtOf = createStartedAtReader();
		for (const job of jobs) {
			if (isFinished(job.state) || job.state === 'uncertain') continue;
			const alive = await isOwnerAlive(job, {
				isAlive: isPidAlive,
				startedAtOf,
				selfPid: process.pid,
				selfStartedAt: PROCESS_STARTED_AT,
			});
			const settled = settleOrphan(job, {isAlive: () => alive, now: now()});
			if (settled !== job) await saveJob(cmd.cwd, settled);
		}
	};

	const cancelUncertain = async (jobs: readonly Job[], error: JobError): Promise<void> => {
		for (const job of jobs) {
			const moved = moveJob(job, {state: 'cancelled', error}, now());
			if (moved.ok) await saveJob(cmd.cwd, moved.job);
		}
	};

	// Paid spend and an uncertain earlier run are the person's call. Returns why the run must not
	// start, or undefined when it may.
	const paidRefusal = async (params: {
		readonly engine: Engine;
		readonly title: string;
		readonly input: unknown;
		readonly gate: PaidGate;
		readonly rerun: boolean;
	}): Promise<string | undefined> => {
		const {engine, title, input, gate, rerun} = params;
		if (!engine.paid || gate.kind === 'resume') return undefined;
		const message = paidConfirmMessage({engineId: engine.id, title, input});
		if (gate.kind === 'blocked') {
			const ids = gate.jobs.map(job => job.id).join(', ');
			if (!rerun) {
				return `Nothing was run. ${engine.id} job ${ids} is uncertain and may already be billed. Ask the person first. If they want a new paid run, call atelier_create again with confirm_rerun: true and they will be asked to confirm. This applies even with --atelier-allow-paid.`;
			}
			const approved = await cmd.ui.confirm({
				title: `Run ${engine.id} again?`,
				message: `${message} An earlier run (${ids}) is uncertain and may already be billed.`,
			});
			return approved
				? undefined
				: `Nothing was run. The person did not confirm the re-run of ${engine.id}. Headless runs cannot confirm, so confirm_rerun cannot be used there.`;
		}
		if (cmd.getFlag('atelier-allow-paid') === true) return undefined;
		const approved = await cmd.ui.confirm({title: `Run paid engine ${engine.id}?`, message});
		return approved ? undefined : 'The person did not approve this paid run. Offer a free engine or ask them.';
	};

	// The manifest's `commandcode.skills` is not honored by every host (the desktop app skipped it),
	// so the craft skills are also registered from code, which every host collects at factory time.
	cmd.addSkillsPath(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills'));

	cmd.addFlag('atelier-allow-paid', {
		type: 'boolean',
		default: false,
		description: 'Run paid engines without asking first (headless runs cannot ask).',
	});

	cmd.hooks({
		onSessionStart: async ({sessionId: id, source}) => {
			sessionId = id ?? sessionId;
			if (source === 'reload') adoptGallery();
			await settleOrphans();
		},
		onSessionEnd: async params => {
			if (params?.reason === 'reload') {
				galleryView?.dispose();
				galleryView = undefined;
				return;
			}
			await closeGallery();
		},
		appendSystemPrompt: () => ATELIER_PROMPT,
		transformContext: async ({messages}) => {
			const reminder = atelierReminder(await loadJobs(cmd.cwd), sessionId);
			return reminder === undefined ? messages : withReminder(messages, reminder);
		},
		// Reading an image atelier is still writing returns half a file.
		beforeToolCall: async ({toolName, input}) => {
			if (toolName !== 'read_file' || running.size === 0) return undefined;
			if (!readsRunningJob({input, cwd: cmd.cwd, runningIds: [...running.keys()]})) return undefined;
			return {
				block: true,
				additionalContext: 'That atelier job is still rendering. atelier_create returns its outputs when it finishes.',
			};
		},
		afterToolCall: async ({toolName, isError}) => {
			if (toolName === 'atelier_present' && !isError) {
				progress = trackTool(progress, {type: 'presented'});
				return undefined;
			}
			if (toolName !== 'atelier_create') return undefined;
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
			name: 'atelier_engines',
			label: 'ATELIER',
			description: 'List the atelier engines (design images, motion graphics, voiceover, video edits, paid AI images), whether each works on this machine, and the exact input schema each takes. Call once before your first atelier_create.',
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
			name: 'atelier_create',
			label: 'ATELIER',
			description: 'Make one piece of media with an atelier engine and wait for it. Returns the job, its output files, a measured review (fix "fail" checks before presenting) and a preview image you can see. Get each engine\'s input schema from atelier_engines.',
			input_schema: {
				type: 'object',
				properties: {
					engine: {type: 'string', enum: ENGINES.map(engine => engine.id)},
					title: {type: 'string', description: 'Short human title shown in the gallery, e.g. "Launch poster v2".'},
					input: {type: 'object', description: 'Engine input, exactly as its input_schema describes.'},
					confirm_rerun: {
						type: 'boolean',
						description: 'Only after the person agreed: run a paid engine again although an earlier run of it is uncertain and may already be billed. They are asked to confirm.',
					},
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

			const title = plainTitle(input.title, engine.id);
			const gate = engine.paid ? paidGate(await loadJobs(cmd.cwd), engine.id, parsed.value) : CLEAR;
			const refusal = await paidRefusal({engine, title, input: parsed.value, gate, rerun: input.confirm_rerun === true});
			if (refusal !== undefined) return {ok: false, error: refusal};
			if (gate.kind === 'blocked') {
				await cancelUncertain(gate.jobs, {code: 'rerun_confirmed', message: 'The person chose to run it again.', retryable: false});
			}

			const controller = new AbortController();
			signal?.addEventListener('abort', () => controller.abort(), {once: true});
			const started = new Set<string>();
			const job = await runJob({
				cwd: cmd.cwd,
				sessionId,
				engine,
				input: parsed.value,
				title,
				...deps,
				signal: controller.signal,
				now,
				...(gate.kind === 'resume' ? {resume: gate.billedResult} : {}),
				onChange: changed => {
					if (changed.state === 'running') {
						started.add(changed.id);
						running.set(changed.id, changed.title);
					}
					if (changed.state !== 'running') running.delete(changed.id);
					refreshStatus();
				},
			}).finally(() => {
				// A save that throws must not leave the footer saying a dead job is still rendering.
				for (const id of started) running.delete(id);
				refreshStatus();
			});
			if (gate.kind === 'resume' && job.state === 'completed') {
				await cancelUncertain([gate.job], {code: 'recovered', message: `Fetched by job ${job.id} without paying again.`, retryable: false});
			}
			if (job.state !== 'completed') {
				return {ok: false, error: `Job ${job.id} ${job.state}: ${job.error?.message ?? 'no detail'}`};
			}

			const reviews = await Promise.all(
				job.outputs.map(output => reviewMedia({path: output.path, exec: execFileExec, ...stillVideoFlag(job)}).catch(() => undefined)),
			);
			const layouts = await Promise.all(job.outputs.map(output => layoutReport(output.path)));
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
					...(layouts.some(Boolean) ? {layout: layouts} : {}),
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
			name: 'atelier_review',
			label: 'ATELIER',
			description: 'Measure an image, video or audio file: size, duration, black or frozen frames, silence, loudness and peaks. Use it on files you did not make with atelier_create.',
			input_schema: {
				type: 'object',
				properties: {path: {type: 'string', description: 'Absolute path to the media file.'}},
				required: ['path'],
			},
		},
		run: async ({input, signal}): Promise<ToolOutcome> => {
			const path = String(input.path ?? '');
			if (!mediaKindOf(path)) return {ok: false, error: `Not a media file atelier can review: ${path}`};
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
			name: 'atelier_jobs',
			label: 'ATELIER',
			description: 'List atelier jobs with their state, outputs and errors. Defaults to this conversation; scope "project" lists every job in the project.',
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
			name: 'atelier_present',
			label: 'ATELIER',
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
			const ids = [...new Set(stringArray(input.job_ids))];
			if (ids.length === 0) return {ok: false, error: 'job_ids must list at least one job id from atelier_create.'};
			const jobs = await Promise.all(ids.map(id => loadJob(cmd.cwd, id)));
			const missing = ids.filter((_, index) => jobs[index] === undefined);
			if (missing.length > 0) return {ok: false, error: `Unknown job ids: ${missing.join(', ')}`};
			const unfinished = jobs.filter((job): job is Job => job !== undefined && job.state !== 'completed');
			if (unfinished.length > 0) {
				return {ok: false, error: `Only completed jobs can be presented: ${unfinished.map(job => `${job.id} is ${job.state}`).join(', ')}`};
			}
			const done = jobs.filter((job): job is Job => job !== undefined).map(job => markPresented(job, now()));
			await Promise.all(done.map(job => saveJob(cmd.cwd, job)));
			const handle = await revealGallery();
			const note = plainNote(input.note);
			cmd.ui.toast(note === '' ? `Shown: ${done.map(job => job.title).join(', ')}` : note, {level: 'success'});
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

	if (typeof viewUi.override === 'function') {
		viewUi.override('tool_row', props =>
			toolRowCard(props, {
				readPreview: jobId => readPreviewDataUrl(cmd.cwd, jobId),
				readJob: jobId => loadJobSync(cmd.cwd, jobId),
				// Read per paint: a host may fill its element list after the mod loads.
				capabilities: viewUi.capabilities?.elements ?? [],
				openGallery: async () => {
					const handle = await revealGallery();
					if (!viewUi.openView) await execFileExec({command: 'open', args: [handle.url]});
				},
			}),
		);
	}

	cmd.ui.pane({
		id: 'atelier',
		title: 'Atelier',
		render: () =>
			paneNodes({
				busy: [...running.values()],
				hasStatus: supportsStatus(viewUi),
				onOpenGallery: async () => {
					const handle = await revealGallery();
					if (!viewUi.openView) await execFileExec({command: 'open', args: [handle.url]});
					cmd.ui.refreshWidgets();
				},
			}),
	});

	cmd.addCommand({
		name: 'atelier',
		description: 'Open the Atelier pane and its live gallery',
		handler: async () => {
			const handle = await revealGallery();
			cmd.ui.openPane('atelier');
			return {message: `Atelier gallery: ${handle.url}`};
		},
	});
}
