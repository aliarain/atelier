import {isAbsolute, join, resolve, sep} from 'node:path';
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

// A glob reaches into a folder when the fixed text before its first wildcard and the folder lie
// on one path, in either direction.
function globReaches(pattern: string, cwd: string, folder: string): boolean {
	const literal = pattern.slice(0, pattern.search(GLOB_CHARS));
	const prefix = isAbsolute(literal) ? join(literal) : join(cwd, literal);
	return folder.startsWith(prefix) || prefix.startsWith(folder);
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
