import assert from 'node:assert/strict';
import {test} from 'node:test';
import {type FeedCardDeps, toolRowCard} from '../src/feed-cards.ts';
import type {Job} from '../src/types.ts';

const FULL = ['text', 'row', 'box', 'button', 'status', 'image', 'stack'];
const SRC = 'data:image/jpeg;base64,AAAA';
const openGallery = async (): Promise<void> => {};

function job(overrides: Partial<Job>): Job {
	return {
		id: 'j1',
		sessionId: 's',
		engine: 'design',
		title: 'Night Bloom story v3',
		input: {width: 1080, height: 1920},
		state: 'completed',
		paid: false,
		ownerPid: 1,
		createdAt: 1,
		updatedAt: 1,
		outputs: [],
		presented: false,
		...overrides,
	};
}

function depsOf(overrides: Partial<FeedCardDeps> = {}): FeedCardDeps {
	return {
		readPreview: () => SRC,
		readJob: () => undefined,
		capabilities: FULL,
		openGallery,
		...overrides,
	};
}

function created(result: unknown, input: unknown = {engine: 'design', title: 'Night Bloom story v2', input: {width: 1080, height: 1920}}) {
	return {
		toolName: 'atelier_create',
		input,
		status: 'success' as const,
		result: [{type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result)}],
	};
}

const CLEAN = {
	job_id: 'j1',
	state: 'completed',
	outputs: [{path: '/x/design.png', kind: 'image', bytes: 10}],
	reviews: [{verdict: 'pass', probe: {kind: 'image', width: 1080, height: 1920, hasAudio: false, bytes: 10}, issues: []}],
};

test('a pending create is a running status and a dim engine and size line', () => {
	const props = {toolName: 'atelier_create', status: 'pending' as const, input: {engine: 'design', title: 'Night Bloom story v4', input: {width: 1080, height: 1920}}};
	assert.deepEqual(toolRowCard(props, depsOf()), [
		{
			type: 'stack',
			direction: 'column',
			children: [
				{type: 'status', state: 'running', text: 'Making Night Bloom story v4'},
				{type: 'text', text: 'design · 1080 × 1920', dim: true},
			],
		},
	]);
});

test('a pending voiceover names the kind of work instead of a size', () => {
	const props = {toolName: 'atelier_create', status: 'pending' as const, input: {engine: 'voice', title: 'VO take 1', input: {}}};
	assert.deepEqual(toolRowCard(props, depsOf()), [
		{
			type: 'stack',
			direction: 'column',
			children: [
				{type: 'status', state: 'running', text: 'Making VO take 1'},
				{type: 'text', text: 'voiceover', dim: true},
			],
		},
	]);
});

test('a finished create with an unsafe-area warning shows a portrait thumbnail and one yellow chip', () => {
	const probe = {kind: 'image', width: 1080, height: 1920, durationS: 4, hasAudio: false, bytes: 10};
	const result = {
		...CLEAN,
		reviews: [{verdict: 'warn', probe, issues: [{id: 'blank', status: 'warn', detail: 'x'}]}],
		layout: [{checked: 3, issues: [{kind: 'safe_area', text: '09', rect: {x: 0, y: 0, w: 1, h: 1}}]}],
	};
	const nodes = toolRowCard(created(result), depsOf());
	assert.deepEqual(nodes, [
		{
			type: 'stack',
			direction: 'row',
			align: 'start',
			children: [
				{type: 'image', src: SRC, alt: 'Night Bloom story v2', width: 64, height: 80, fit: 'cover'},
				{
					type: 'stack',
					direction: 'column',
					children: [
						{type: 'status', state: 'done', text: 'Night Bloom story v2'},
						{type: 'text', text: 'design · 1080 × 1920 · 4s', dim: true},
						{
							type: 'row',
							children: [
								{type: 'text', text: 'Blank render', color: 'yellow'},
								{type: 'text', text: 'Text in unsafe area', color: 'yellow'},
							],
						},
						{type: 'button', label: 'Open in gallery', onPress: openGallery},
					],
				},
			],
		},
	]);
});

test('failures sort before warnings, repeats collapse, and the rest becomes a count', () => {
	const issues = [
		{id: 'silence', status: 'warn', detail: ''},
		{id: 'true_peak', status: 'fail', detail: ''},
		{id: 'loudness', status: 'warn', detail: ''},
		{id: 'silence', status: 'warn', detail: ''},
		{id: 'duration', status: 'warn', detail: ''},
	];
	const nodes = toolRowCard(created({...CLEAN, reviews: [{verdict: 'fail', probe: {}, issues}]}), depsOf({capabilities: ['status']}));
	const chips = nodes?.[2];
	assert.deepEqual(chips, {
		type: 'row',
		children: [
			{type: 'text', text: 'Clipping peaks', color: 'red'},
			{type: 'text', text: 'Silence', color: 'yellow'},
			{type: 'text', text: 'Loudness', color: 'yellow'},
			{type: 'text', text: '+1 more', dim: true},
		],
	});
});

test('a clean create says all checks passed', () => {
	const nodes = toolRowCard(created(CLEAN), depsOf());
	const row = nodes?.[0];
	assert.deepEqual(row && 'children' in row ? row.children[1] : undefined, {
		type: 'stack',
		direction: 'column',
		children: [
			{type: 'status', state: 'done', text: 'Night Bloom story v2'},
			{type: 'text', text: 'design · 1080 × 1920', dim: true},
			{type: 'row', children: [{type: 'text', text: 'All checks passed', color: 'green'}]},
			{type: 'button', label: 'Open in gallery', onPress: openGallery},
		],
	});
});

test('a video gets the play badge and a landscape frame follows the probed size', () => {
	const result = {
		job_id: 'j2',
		outputs: [{path: '/x/video.mp4', kind: 'video', bytes: 10}],
		reviews: [{verdict: 'pass', probe: {kind: 'video', width: 1920, height: 1080, durationS: 15.64, hasAudio: true, bytes: 10}, issues: []}],
	};
	const nodes = toolRowCard(created(result, {engine: 'video', title: 'Studio reel', input: {}}), depsOf());
	const row = nodes?.[0];
	const children = row && 'children' in row ? row.children : [];
	assert.deepEqual(children[0], {type: 'image', src: SRC, alt: 'Studio reel', width: 112, height: 80, fit: 'cover', badge: 'play'});
	const column = children[1];
	assert.deepEqual(column && 'children' in column ? column.children[1] : undefined, {
		type: 'text',
		text: 'video · 1920 × 1080 · 15.6s',
		dim: true,
	});
});

test('an error shows what failed and no button', () => {
	const props = {
		toolName: 'atelier_create',
		status: 'error' as const,
		input: {engine: 'design', title: 'Poster', input: {}},
		result: [{type: 'text', text: `Job j9 failed: ${'x'.repeat(200)}`}],
	};
	assert.deepEqual(toolRowCard(props, depsOf()), [
		{
			type: 'stack',
			direction: 'column',
			children: [
				{type: 'status', state: 'error', text: 'Could not make Poster'},
				{type: 'text', text: `Job j9 failed: ${'x'.repeat(125)}`, dim: true},
			],
		},
	]);
});

test('present shows Delivered, the note and a contained image with a caption per piece', () => {
	const jobs: Readonly<Record<string, Job>> = {
		a: job({id: 'a', title: 'Night Bloom story v3'}),
		b: job({id: 'b', title: 'Ember &amp; Oak fall menu', input: {width: 1080, height: 1080}}),
	};
	const props = {
		toolName: 'atelier_present',
		status: 'success' as const,
		input: {job_ids: ['a', 'b'], note: 'Final cut and the square post.'},
		result: [{type: 'text', text: '{}'}],
	};
	assert.deepEqual(toolRowCard(props, depsOf({readJob: id => jobs[id]})), [
		{
			type: 'stack',
			direction: 'column',
			children: [
				{type: 'row', children: [{type: 'text', text: 'Delivered', bold: true}, {type: 'text', text: '2 pieces', dim: true}]},
				{type: 'text', text: 'Final cut and the square post.'},
				{
					type: 'stack',
					direction: 'row',
					align: 'start',
					children: [
						{
							type: 'stack',
							direction: 'column',
							children: [
								{type: 'image', src: SRC, alt: 'Night Bloom story v3', width: 180, height: 225, fit: 'contain'},
								{type: 'row', children: [{type: 'text', text: 'Night Bloom story v3'}, {type: 'text', text: '1080 × 1920', dim: true}]},
							],
						},
						{
							type: 'stack',
							direction: 'column',
							children: [
								{type: 'image', src: SRC, alt: 'Ember & Oak fall menu', width: 180, height: 225, fit: 'contain'},
								{type: 'row', children: [{type: 'text', text: 'Ember & Oak fall menu'}, {type: 'text', text: '1080 × 1080', dim: true}]},
							],
						},
					],
				},
			],
		},
	]);
});

test('present shows at most four pieces but counts them all', () => {
	const ids = ['a', 'b', 'c', 'd', 'e'];
	const props = {toolName: 'atelier_present', status: 'success' as const, input: {job_ids: ids, note: 'n'}};
	const nodes = toolRowCard(props, depsOf({readJob: id => job({id})}));
	const outer = nodes?.[0];
	const header = outer && 'children' in outer ? outer.children[0] : undefined;
	const pieces = outer && 'children' in outer ? outer.children[2] : undefined;
	assert.deepEqual(header && 'children' in header ? header.children[1] : undefined, {type: 'text', text: '5 pieces', dim: true});
	assert.equal(pieces && 'children' in pieces ? pieces.children.length : 0, 4);
});

test('other tools and unfinished presents keep the built-in row', () => {
	assert.equal(toolRowCard({toolName: 'read_file', status: 'success', input: {}}, depsOf()), undefined);
	assert.equal(toolRowCard({toolName: 'atelier_jobs', status: 'success', input: {}}, depsOf()), undefined);
	assert.equal(toolRowCard({toolName: 'atelier_present', status: 'pending', input: {}}, depsOf()), undefined);
	assert.equal(toolRowCard({toolName: 'atelier_present', status: 'error', input: {}}, depsOf()), undefined);
});

test('a host without image or stack gets flat text nodes and never an image', () => {
	const caps = ['text', 'row', 'button', 'status'];
	const pending = toolRowCard({toolName: 'atelier_create', status: 'pending', input: {engine: 'design', title: 'Poster', input: {width: 100, height: 200}}}, depsOf({capabilities: caps}));
	assert.deepEqual(pending, [
		{type: 'status', state: 'running', text: 'Making Poster'},
		{type: 'text', text: 'design · 100 × 200', dim: true},
	]);
	const done = toolRowCard(created(CLEAN), depsOf({capabilities: caps}));
	assert.deepEqual(done, [
		{type: 'status', state: 'done', text: 'Night Bloom story v2'},
		{type: 'text', text: 'design · 1080 × 1920', dim: true},
		{type: 'row', children: [{type: 'text', text: 'All checks passed', color: 'green'}]},
		{type: 'button', label: 'Open in gallery', onPress: openGallery},
	]);
	const present = toolRowCard(
		{toolName: 'atelier_present', status: 'success', input: {job_ids: ['a'], note: 'Done.'}},
		depsOf({capabilities: caps, readJob: () => job({})}),
	);
	assert.deepEqual(present, [
		{type: 'row', children: [{type: 'text', text: 'Delivered', bold: true}, {type: 'text', text: '1 piece', dim: true}]},
		{type: 'text', text: 'Done.'},
		{type: 'text', text: 'Night Bloom story v3 · 1080 × 1920', dim: true},
	]);
});

test('a host with image but no stack is treated as text only', () => {
	const nodes = toolRowCard(created(CLEAN), depsOf({capabilities: ['status', 'image']}));
	assert.equal(JSON.stringify(nodes).includes('"image"'), false);
});

test('without status the headline becomes bold text', () => {
	const nodes = toolRowCard({toolName: 'atelier_create', status: 'pending', input: {engine: 'design', title: 'Poster', input: {}}}, depsOf({capabilities: []}));
	assert.deepEqual(nodes, [
		{type: 'text', text: 'Making Poster', bold: true},
		{type: 'text', text: 'design', dim: true},
	]);
});

test('malformed result JSON still gives a safe minimal card', () => {
	const nodes = toolRowCard(created('{not json'), depsOf());
	assert.deepEqual(nodes, [
		{
			type: 'stack',
			direction: 'column',
			children: [
				{type: 'status', state: 'done', text: 'Night Bloom story v2'},
				{type: 'text', text: 'design · 1080 × 1920', dim: true},
				{type: 'button', label: 'Open in gallery', onPress: openGallery},
			],
		},
	]);
});

test('an absent result and hostile props do not throw', () => {
	assert.doesNotThrow(() => toolRowCard({toolName: 'atelier_create', status: 'success'}, depsOf()));
	assert.doesNotThrow(() => toolRowCard({toolName: 'atelier_create', status: 'success', input: 'x', result: [null, 7, {type: 'text', text: '[1]'}]}, depsOf()));
});

test('a review that could not run says so instead of claiming a pass', () => {
	const nodes = toolRowCard(created({...CLEAN, reviews: ['review unavailable']}), depsOf());
	assert.match(JSON.stringify(nodes), /Review unavailable/);
	assert.doesNotMatch(JSON.stringify(nodes), /All checks passed/);
});

test('an oversized or missing preview leaves the text column without an image', () => {
	const nodes = toolRowCard(created(CLEAN), depsOf({readPreview: () => undefined}));
	assert.equal(nodes?.length, 1);
	assert.equal(nodes?.[0]?.type, 'stack');
	assert.equal(JSON.stringify(nodes).includes('"image"'), false);
	assert.equal((nodes?.[0] as {direction: string}).direction, 'column');
});
