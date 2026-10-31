import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {designEngine} from '../src/engines/design.ts';
import {findEngine} from '../src/engines/index.ts';
import {execFileExec} from '../src/exec.ts';
import {outputDir} from '../src/jobs.ts';
import {previewOf, readPreviewDataUrl, runJob} from '../src/runner.ts';
import type {Availability} from '../src/types.ts';

const chrome: Availability = await designEngine.available({exec: execFileExec, env: process.env});
const ffmpeg = await execFileExec({command: 'ffmpeg', args: ['-version']}).catch(() => ({code: 1}));
const live = chrome.ok && ffmpeg.code === 0 ? {} : {skip: 'Chrome or ffmpeg is not installed'};

describe('preview.jpg', () => {
	test('a real design run leaves a JPEG the chat card can read, outside the job outputs', live, async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'atelier-preview-'));
		try {
			const engine = findEngine('design');
			assert.ok(engine);
			const job = await runJob({
				cwd,
				sessionId: 's',
				engine,
				input: {html: '<body style="margin:0;background:#f00"><h1>Red</h1></body>', width: 200, height: 120, scale: 1},
				title: 'Red',
				exec: execFileExec,
				env: process.env,
				fetch: globalThis.fetch,
				signal: AbortSignal.timeout(90_000),
				now: () => 42,
			});
			assert.equal(job.state, 'completed');
			const output = job.outputs[0];
			assert.ok(output);
			const base64 = await previewOf({output, exec: execFileExec});
			const saved = await readFile(join(outputDir(cwd, job.id), 'preview.jpg'));
			assert.deepEqual([...saved.subarray(0, 3)], [0xff, 0xd8, 0xff]);
			assert.equal(base64, saved.toString('base64'));
			assert.equal(readPreviewDataUrl(cwd, job.id), `data:image/jpeg;base64,${base64}`);
			assert.deepEqual(job.outputs.map(o => o.path), [join(outputDir(cwd, job.id), 'design.png')]);
		} finally {
			await rm(cwd, {recursive: true, force: true});
		}
	});
});

describe('readPreviewDataUrl', () => {
	test('returns a data url for a small file and nothing for a missing job, a bad id or a file over 600 KB', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'atelier-preview-'));
		try {
			await mkdir(outputDir(cwd, 'small'), {recursive: true});
			await mkdir(outputDir(cwd, 'big'), {recursive: true});
			await writeFile(join(outputDir(cwd, 'small'), 'preview.jpg'), Buffer.from([1, 2, 3]));
			await writeFile(join(outputDir(cwd, 'big'), 'preview.jpg'), Buffer.alloc(600 * 1024 + 1));
			assert.equal(readPreviewDataUrl(cwd, 'small'), 'data:image/jpeg;base64,AQID');
			assert.equal(readPreviewDataUrl(cwd, 'big'), undefined);
			assert.equal(readPreviewDataUrl(cwd, 'missing'), undefined);
			assert.equal(readPreviewDataUrl(cwd, '../small'), undefined);
		} finally {
			await rm(cwd, {recursive: true, force: true});
		}
	});
});
