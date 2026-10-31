import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paneNodes, supportsStatus} from '../src/pane.ts';

const noop = async (): Promise<void> => {};

test('supportsStatus reads the host element list and tolerates hosts without one', () => {
	assert.equal(supportsStatus({}), false);
	assert.equal(supportsStatus({capabilities: {}}), false);
	assert.equal(supportsStatus({capabilities: {elements: ['text', 'row']}}), false);
	assert.equal(supportsStatus({capabilities: {elements: ['text', 'status']}}), true);
});

test('the pane is one status element and one button row when the host has status', () => {
	const idle = paneNodes({busy: [], hasStatus: true, onOpenGallery: noop});
	assert.deepEqual(idle[0], {type: 'status', state: 'idle', text: 'Ready'});
	assert.equal(idle.length, 2);
	const running = paneNodes({busy: ['Night Bloom story v3', 'VO take 1'], hasStatus: true, onOpenGallery: noop});
	assert.deepEqual(running[0], {
		type: 'status',
		state: 'running',
		text: 'Making Night Bloom story v3, VO take 1',
	});
});

test('the pane falls back to the text line on hosts without status', () => {
	assert.deepEqual(paneNodes({busy: [], hasStatus: false, onOpenGallery: noop})[0], {
		type: 'text',
		text: 'Idle',
		bold: true,
	});
	assert.deepEqual(paneNodes({busy: ['Poster'], hasStatus: false, onOpenGallery: noop})[0], {
		type: 'text',
		text: 'Making: Poster',
		bold: true,
	});
});

test('the only button opens the gallery and the pane never prints the url', () => {
	const flat = JSON.stringify(paneNodes({busy: [], hasStatus: true, onOpenGallery: noop}));
	assert.equal(flat.match(/"type":"button"/g)?.length, 1);
	assert.match(flat, /"label":"Open gallery"/);
	assert.doesNotMatch(flat, /http:/);
});
