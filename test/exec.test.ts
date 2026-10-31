import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {environmentFailure, execFileExec} from '../src/exec.ts';

// A child that ignores SIGTERM, the way ffmpeg does while stuck in a decoder. With `readyFile`
// it writes that file once the handler is installed, so a test can abort only after that point.
function stubborn(marker: string, readyFile?: string): readonly string[] {
	const ready = readyFile ? `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, '1');` : '';
	return [
		'-e',
		`process.on('SIGTERM', () => {}); ${ready} setInterval(() => {}, 1000); // ${marker}`,
	];
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`${path} never appeared`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

async function stillRunning(marker: string): Promise<boolean> {
	const result = await execFileExec({command: 'pgrep', args: ['-f', marker]});
	return result.code === 0;
}

test('execFileExec captures output and the exit code', async () => {
	const result = await execFileExec({
		command: process.execPath,
		args: ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
	});
	assert.deepEqual(result, {code: 3, stdout: 'out', stderr: 'err'});
});

test('execFileExec reports a missing program as ENOENT', async () => {
	const result = await execFileExec({command: 'atelier-no-such-tool', args: []});
	assert.equal(result.code, 1);
	assert.equal(result.errno, 'ENOENT');
	assert.equal(result.timedOut, undefined);
});

test('execFileExec marks a timeout and stops a cooperative child with SIGTERM', async () => {
	const started = Date.now();
	const result = await execFileExec({command: 'sleep', args: ['30'], timeoutMs: 200});
	assert.equal(result.timedOut, true);
	assert.equal(result.signal, 'SIGTERM');
	assert.ok(Date.now() - started < 1400, `took ${Date.now() - started}ms`);
});

test('execFileExec escalates to SIGKILL and resolves only after a SIGTERM-proof child exited', async () => {
	const marker = `atelier-stubborn-${randomUUID()}`;
	const started = Date.now();
	const result = await execFileExec({
		command: process.execPath,
		args: stubborn(marker),
		timeoutMs: 200,
	});
	const elapsed = Date.now() - started;
	assert.equal(result.timedOut, true);
	assert.equal(result.signal, 'SIGKILL');
	assert.ok(elapsed >= 1500 && elapsed < 4000, `took ${elapsed}ms`);
	assert.equal(await stillRunning(marker), false);
});

test('execFileExec on abort resolves after the child exited, not when the signal fired', async () => {
	const marker = `atelier-abort-${randomUUID()}`;
	const readyFile = join(tmpdir(), `${marker}.ready`);
	const controller = new AbortController();
	const running = execFileExec({
		command: process.execPath,
		args: stubborn(marker, readyFile),
		signal: controller.signal,
	});
	// Under load node can take longer to boot than a fixed delay, and an abort that lands
	// before the SIGTERM handler exists ends the child with SIGTERM instead.
	await waitForFile(readyFile);
	const started = Date.now();
	controller.abort();
	const result = await running;
	const elapsed = Date.now() - started;
	await rm(readyFile, {force: true});
	assert.equal(result.signal, 'SIGKILL');
	assert.equal(result.timedOut, undefined);
	assert.ok(elapsed >= 1500 && elapsed < 4000, `took ${elapsed}ms`);
	assert.equal(await stillRunning(marker), false);
});

test('execFileExec does not start a program for a signal that is already aborted', async () => {
	const marker = `atelier-preaborted-${randomUUID()}`;
	const result = await execFileExec({
		command: process.execPath,
		args: stubborn(marker),
		signal: AbortSignal.abort(),
	});
	assert.deepEqual(result, {code: 1, stdout: '', stderr: ''});
	assert.equal(await stillRunning(marker), false);
});

test('environmentFailure names a missing tool and a timeout, and leaves other results alone', () => {
	const missing = environmentFailure({
		tool: 'ffmpeg',
		result: {code: 1, stdout: '', stderr: '', errno: 'ENOENT'},
		timeoutMs: 90_000,
	});
	assert.equal(missing?.code, 'missing_tool');
	assert.equal(missing?.retryable, false);
	assert.equal(missing?.message, 'ffmpeg is not installed or not on PATH');

	const slow = environmentFailure({
		tool: 'ffmpeg',
		result: {code: 1, stdout: '', stderr: '', timedOut: true, signal: 'SIGTERM'},
		timeoutMs: 160_000,
	});
	assert.equal(slow?.code, 'timeout');
	assert.equal(slow?.retryable, false);
	assert.equal(slow?.message, 'ffmpeg took longer than 160s and was stopped');

	assert.equal(
		environmentFailure({
			tool: 'ffmpeg',
			result: {code: 1, stdout: '', stderr: 'boom'},
			timeoutMs: 1000,
		}),
		undefined,
	);
});
