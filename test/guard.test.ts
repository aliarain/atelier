import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readsRunningJob} from '../src/guard.ts';

const cwd = '/p';
const running = ['mvw-1'];
const reads = (input: Record<string, unknown>): boolean => readsRunningJob({input, cwd, runningIds: running});

test('reading a file inside a rendering job is blocked, however the path is written', () => {
	assert.equal(reads({file_path: '/p/.atelier/out/mvw-1/design.png'}), true);
	assert.equal(reads({file_path: '.atelier/out/mvw-1/design.png'}), true);
	assert.equal(reads({path: '.atelier/out/mvw-1/video.mp4'}), true);
	assert.equal(reads({paths: ['README.md', '/p/.atelier/out/mvw-1/design.png']}), true);
	assert.equal(reads({file_path: '/p/notes/../.atelier/out/mvw-1/design.png'}), true);
});

test('globs that can reach a rendering job are blocked', () => {
	assert.equal(reads({file_path: '.atelier/out/*/*.png'}), true);
	assert.equal(reads({file_path: '.atelier/out/mvw-1/*'}), true);
	assert.equal(reads({file_path: '**/*.png'}), true);
	assert.equal(reads({file_path: '**/*'}), true);
});

test('globs and paths that cannot reach a rendering job pass', () => {
	assert.equal(reads({file_path: '*.md'}), false);
	assert.equal(reads({file_path: '**/*.ts'}), false);
	assert.equal(reads({file_path: 'src/**/*.png'}), false);
	assert.equal(reads({file_path: '.atelier/out/*.png'}), false);
	assert.equal(reads({file_path: '/p/.atelier-notes/mvw-1.md'}), false);
	assert.equal(reads({file_path: '/p/.atelier/out/mvw-2/design.png'}), false);
});

test('nothing is blocked when no job is rendering', () => {
	assert.equal(readsRunningJob({input: {file_path: '**/*'}, cwd, runningIds: []}), false);
});
