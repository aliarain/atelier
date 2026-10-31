export type MediaKind = 'image' | 'video' | 'audio';

// `uncertain` is a paid job whose process died mid-run: the provider may have billed it, so it
// is never re-run without the person's say-so.
export type JobState =
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'uncertain'
	| 'cancelled';

export interface MediaOutput {
	readonly path: string;
	readonly kind: MediaKind;
	readonly bytes: number;
}

export interface JobError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

// What a paid provider already made for a run it billed, so a retry can fetch it without paying
// again.
export interface BilledResult {
	readonly url: string;
}

export interface Job {
	readonly id: string;
	readonly sessionId: string;
	readonly engine: string;
	readonly title: string;
	readonly input: unknown;
	readonly state: JobState;
	readonly paid: boolean;
	readonly ownerPid: number;
	// When the owning process started, so a recycled pid is not mistaken for the owner.
	readonly ownerStartedAt?: number;
	readonly billedResult?: BilledResult;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly outputs: readonly MediaOutput[];
	readonly presented: boolean;
	readonly error?: JobError;
}

export interface ExecParams {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface ExecResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	// Set only when the run was stopped for taking longer than timeoutMs.
	readonly timedOut?: boolean;
	// The signal that ended the process, such as SIGTERM after a timeout or an abort.
	readonly signal?: string;
	// The system error name when the process could not start, such as ENOENT.
	readonly errno?: string;
}

export type Exec = (params: ExecParams) => Promise<ExecResult>;

export type Env = Readonly<Record<string, string | undefined>>;

export type Parsed<T> =
	| {readonly ok: true; readonly value: T}
	| {readonly ok: false; readonly error: string};

export type Availability =
	| {readonly ok: true}
	| {readonly ok: false; readonly reason: string};

export interface JsonObjectSchema {
	readonly type: 'object';
	readonly properties: Readonly<Record<string, unknown>>;
	readonly required: readonly string[];
}

export interface EngineRunContext {
	// A fresh directory owned by this job; engines write every output inside it.
	readonly outDir: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly exec: Exec;
	readonly env: Env;
	readonly fetch: typeof fetch;
	// A paid engine calls this the moment the provider has accepted the billable request, with
	// the result it can be fetched from once known. From then on any failure is `uncertain`.
	readonly markBilled?: (result?: BilledResult) => void;
	// Set when an earlier run was billed but never delivered: skip the paid request and fetch this.
	readonly resume?: BilledResult;
}

export interface Engine<I = unknown> {
	readonly id: string;
	readonly kind: MediaKind;
	readonly paid: boolean;
	// One line for the model: what it makes and when to pick it.
	readonly summary: string;
	readonly inputSchema: JsonObjectSchema;
	readonly parse: (raw: unknown) => Parsed<I>;
	readonly available: (params: {
		readonly exec: Exec;
		readonly env: Env;
	}) => Promise<Availability>;
	// Throws an EngineFailure-shaped Error (see engineFailure) on a known failure.
	readonly run: (params: {
		readonly input: I;
		readonly ctx: EngineRunContext;
	}) => Promise<readonly MediaOutput[]>;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface ReviewCheck {
	readonly id: string;
	readonly status: CheckStatus;
	readonly detail: string;
}

export interface MediaProbe {
	readonly kind: MediaKind;
	readonly width?: number;
	readonly height?: number;
	readonly durationS?: number;
	readonly fps?: number;
	readonly hasAudio: boolean;
	readonly bytes: number;
}

export interface Review {
	readonly path: string;
	readonly probe: MediaProbe;
	readonly checks: readonly ReviewCheck[];
	// The worst status across checks.
	readonly verdict: CheckStatus;
}
