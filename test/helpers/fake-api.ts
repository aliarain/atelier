import type {ModApi} from '@commandcode/harness';

export type ToolRun = (call: {input: Record<string, unknown>; signal?: AbortSignal}) => Promise<{ok: boolean; error?: string; content?: readonly unknown[]}>;

export interface Recorder {
	hooks: Record<string, (...args: never[]) => Promise<unknown>>;
	readonly tools: Map<string, {run: ToolRun}>;
	readonly commands: Map<string, {handler: () => Promise<{message: string}>}>;
	readonly views: string[];
	readonly viewDisposed: string[];
	readonly calls: unknown[][];
	readonly flagValues: Map<string, boolean | string | undefined>;
	readonly state: Map<string, unknown>;
	readonly statuses: (string | null)[];
	readonly sent: string[];
	confirmAnswer: boolean;
	throwOnNextNullStatus: boolean;
}

export function makeApi(cwd: string): {readonly api: ModApi; readonly rec: Recorder} {
	const rec: Recorder = {
		hooks: {}, tools: new Map(), commands: new Map(), views: [], viewDisposed: [], calls: [],
		flagValues: new Map(), state: new Map(), statuses: [], sent: [], confirmAnswer: false,
		throwOnNextNullStatus: false,
	};
	const ui = {
		confirm: async (params: unknown): Promise<boolean> => {
			rec.calls.push(['confirm', params]);
			return rec.confirmAnswer;
		},
		setStatus: (text: string | null) => {
			if (text === null && rec.throwOnNextNullStatus) {
				rec.throwOnNextNullStatus = false;
				throw new Error('status failed');
			}
			rec.statuses.push(text);
			return {dispose() {}};
		},
		refreshWidgets: () => {},
		pane: () => ({dispose() {}}),
		openPane: () => {},
		toast: (...args: unknown[]) => rec.calls.push(['toast', ...args]),
		capabilities: {elements: ['status', 'image', 'stack']},
		view: (params: {id: string; url: string}) => {
			rec.views.push(params.url);
			return {dispose() { rec.viewDisposed.push(params.id); }};
		},
		openView: (id: string) => rec.calls.push(['openView', id]),
	};
	const api = {
		cwd,
		ui,
		state: {
			get: (key: string) => rec.state.get(key),
			set: (key: string, value: unknown) => void rec.state.set(key, value),
			subscribe: () => ({dispose() {}}),
		},
		addSkillsPath: () => {},
		addFlag: () => ({dispose() {}}),
		getFlag: (name: string) => rec.flagValues.get(name),
		hooks: (hooks: Recorder['hooks']) => { rec.hooks = hooks; },
		on: () => ({dispose() {}}),
		addTool: (tool: {schema: {name: string}; run: ToolRun}) => rec.tools.set(tool.schema.name, tool),
		addCommand: (command: {name: string; handler: () => Promise<{message: string}>}) => rec.commands.set(command.name, command),
		sendUserMessage: (message: string) => rec.sent.push(message),
	};
	return {api: api as unknown as ModApi, rec};
}

