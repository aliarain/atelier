import {isAbsolute, join, resolve, sep} from 'node:path';
import {mediaKindOf} from './exec.ts';
import {outputDir} from './jobs.ts';

const GLOB_CHARS = /[*?[\]{}]/;
const PATH_KEYS = ['file_path', 'path'] as const;

function pathsOf(input: Readonly<Record<string, unknown>>): readonly string[] {
	const single = PATH_KEYS.map(key => input[key]).filter((value): value is string => typeof value === 'string');
	const many = Array.isArray(input.paths)
		? input.paths.filter((value): value is string => typeof value === 'string')
		: [];
	return [...single, ...many];
}

// A glob reaches into a job folder when it starts inside it, or starts above it and can descend
// that deep (a `**`, or enough path segments) to a file that could be media. A leading `*.md`
// or `**/*.ts` stays out of the way of a render.
function globReaches(pattern: string, cwd: string, folder: string): boolean {
	const lastSegment = pattern.split('/').pop() ?? '';
	const extension = /\.([A-Za-z0-9]+)$/.exec(lastSegment)?.[1];
	if (extension !== undefined && !GLOB_CHARS.test(extension) && mediaKindOf(`x.${extension}`) === undefined) {
		return false;
	}
	const literal = pattern.slice(0, pattern.search(GLOB_CHARS));
	const base = literal.slice(0, literal.lastIndexOf('/') + 1);
	const prefix = `${isAbsolute(base) ? join(base) : join(cwd, base)}${sep}`.replace(/[\\/]+$/, sep);
	if (prefix.startsWith(folder)) return true;
	if (!folder.startsWith(prefix)) return false;
	const rest = pattern.slice(base.length);
	if (rest.includes('**')) return true;
	const depth = folder.slice(prefix.length).split(sep).filter(Boolean).length;
	return rest.split('/').filter(Boolean).length > depth;
}

// True when a read_file call would open something inside a job folder that is still being
// written. Paths may be absolute or relative to the project, and may carry globs or "..".
export function readsRunningJob(params: {
	readonly input: Readonly<Record<string, unknown>>;
	readonly cwd: string;
	readonly runningIds: readonly string[];
}): boolean {
	const {input, cwd, runningIds} = params;
	const folders = runningIds.map(id => `${outputDir(cwd, id)}${sep}`);
	return pathsOf(input).some(raw =>
		folders.some(folder =>
			GLOB_CHARS.test(raw)
				? globReaches(raw, cwd, folder)
				: `${resolve(cwd, raw)}${sep}`.startsWith(folder),
		),
	);
}
