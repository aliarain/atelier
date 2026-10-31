import {execFile} from 'node:child_process';
import {mkdtemp, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Chrome profiles go under os.tmpdir(). Pointing TMPDIR at a private folder for the length of
// a test makes "no profile left behind" and "no Chrome still running" exact checks, even while
// other test files run Chrome in parallel.
export async function withIsolatedTmp<T>(
	body: (root: string) => Promise<T>,
): Promise<T> {
	const previous = process.env.TMPDIR;
	const root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-tmp-')));
	process.env.TMPDIR = root;
	try {
		return await body(root);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		await rm(root, {recursive: true, force: true});
	}
}

export function isChromeAlive(root: string): Promise<boolean> {
	return new Promise(resolve => {
		execFile('pgrep', ['-f', root], error => resolve(error === null));
	});
}

export async function leftoverProfiles(root: string): Promise<readonly string[]> {
	return (await readdir(root)).filter(name => name.startsWith('atelier-chrome-'));
}
