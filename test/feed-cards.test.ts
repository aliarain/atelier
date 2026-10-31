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
	layout: [{checked: 3, issues: []}],
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
		reviews: [{verdict: 'warn', probe, issues: [{id: 'blank', status: 'warn', detail: 'brightness spans 2 of 255'}]}],
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
								{type: 'text', text: 'Brightness spans 2 of 255', color: 'yellow'},
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
			{type: 'text', text: 'Peaks', color: 'red'},
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

test('an error shows the first line of what failed and a way into the gallery', () => {
	const props = {
		toolName: 'atelier_create',
		status: 'error' as const,
		input: {engine: 'design', title: 'Poster', input: {}},
		result: [{type: 'text', text: `Job j9 failed: ${'x'.repeat(200)}\nat render (a.ts:1)\nat run (b.ts:2)`}],
	};
	assert.deepEqual(toolRowCard(props, depsOf()), [
		{
			type: 'stack',
			direction: 'column',
			children: [
				{type: 'status', state: 'error', text: 'Could not make Poster'},
				{type: 'text', text: 'x'.repeat(140), dim: true},
				{type: 'button', label: 'Open in gallery', onPress: openGallery},
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

const cardOf = (nodes: ReturnType<typeof toolRowCard>): string => JSON.stringify(nodes);

test('a cancelled run reads Stopped, not Could not make, and still offers the gallery', () => {
	const props = {
		toolName: 'atelier_create',
		status: 'error' as const,
		input: {engine: 'voice', title: 'VO'},
		result: [{type: 'text', text: 'Job mvwk-abc cancelled: The run was stopped.'}],
	};
	assert.deepEqual(toolRowCard(props, depsOf()), [
		{
			type: 'stack',
			direction: 'column',
			children: [
				{type: 'status', state: 'error', text: 'Stopped VO'},
				{type: 'button', label: 'Open in gallery', onPress: openGallery},
			],
		},
	]);
});

test('an uncertain run does not claim it could not be made', () => {
	const props = {
		toolName: 'atelier_create',
		status: 'error' as const,
		input: {engine: 'fal-image', title: 'Fox'},
		result: [{type: 'text', text: 'Job j1 uncertain: The provider already billed this run, but it did not finish: network.'}],
	};
	assert.match(cardOf(toolRowCard(props, depsOf())), /"text":"Could not finish Fox"/);
});

test('a pending design shows the pixels it will have, scale included', () => {
	const props = {toolName: 'atelier_create', status: 'pending' as const, input: {engine: 'design', title: 'P', input: {width: 1080, height: 1350, scale: 2}}};
	assert.match(cardOf(toolRowCard(props, depsOf())), /design · 2160 × 2700/);
	const unscaled = {...props, input: {engine: 'motion', title: 'M', input: {width: 1080, height: 1920}}};
	assert.match(cardOf(toolRowCard(unscaled, depsOf())), /motion · 1080 × 1920/);
});

test('a delivered piece prefers the reviewed size, then input times scale, then shows none', () => {
	const jobs: Readonly<Record<string, Job>> = {
		reviewed: job({id: 'reviewed', input: {width: 1080, height: 1350, scale: 2}, size: {width: 2160, height: 2700}}),
		scaled: job({id: 'scaled', input: {width: 1080, height: 1350, scale: 2}}),
		bare: job({id: 'bare', input: {}}),
	};
	const props = {toolName: 'atelier_present', status: 'success' as const, input: {job_ids: ['reviewed', 'scaled', 'bare'], note: 'n'}};
	const flat = cardOf(toolRowCard(props, depsOf({capabilities: ['status'], readJob: id => jobs[id]})));
	assert.match(flat, /Night Bloom story v3 · 2160 × 2700/);
	assert.equal(flat.match(/2160 × 2700/g)?.length, 2);
	assert.match(flat, /"text":"Night Bloom story v3","dim":true/);
});

test('the delivered note is cleaned like a title', () => {
	const props = {toolName: 'atelier_present', status: 'success' as const, input: {job_ids: ['a'], note: 'Ember &amp; Oak \u2014 final'}};
	assert.match(cardOf(toolRowCard(props, depsOf({capabilities: ['status'], readJob: () => job({})}))), /"text":"Ember & Oak: final"/);
});

test('delivered counts distinct pieces that loaded and says how many more', () => {
	const known = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
	const readJob = (id: string): Job | undefined => (known.has(id) ? job({id}) : undefined);
	const ids = ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'ghost'];
	const nodes = toolRowCard({toolName: 'atelier_present', status: 'success', input: {job_ids: ids, note: 'n'}}, depsOf({readJob}));
	const outer = nodes?.[0];
	const children = outer && 'children' in outer ? outer.children : [];
	assert.deepEqual(children[0], {type: 'row', children: [{type: 'text', text: 'Delivered', bold: true}, {type: 'text', text: '6 pieces', dim: true}]});
	assert.equal(children[2] && 'children' in children[2] ? children[2].children.length : 0, 4);
	assert.deepEqual(children[3], {type: 'text', text: '+2 more', dim: true});
});

test('a present whose jobs cannot be read keeps the built-in row', () => {
	const props = {toolName: 'atelier_present', status: 'success' as const, input: {job_ids: ['ghost'], note: 'n'}};
	assert.equal(toolRowCard(props, depsOf({readJob: () => undefined})), undefined);
});

test('a chip uses the check\'s own first clause, capitalized and cut to 40 characters', () => {
	const issues = [
		{id: 'duration', status: 'fail', detail: 'the file reports no duration'},
		{id: 'true_peak', status: 'fail', detail: 'no true peak could be measured, the audio may be silent'},
		{id: 'resolution', status: 'warn', detail: 'a very long description of the frame size problem that goes on'},
	];
	const nodes = toolRowCard(created({...CLEAN, reviews: [{verdict: 'fail', probe: {}, issues}]}), depsOf({capabilities: ['status']}));
	assert.deepEqual(nodes?.[2], {
		type: 'row',
		children: [
			{type: 'text', text: 'The file reports no duration', color: 'red'},
			{type: 'text', text: 'No true peak could be measured', color: 'red'},
			{type: 'text', text: 'A very long description of the frame…', color: 'yellow'},
		],
	});
});

test('a design review with no layout check says Layout not checked, not All checks passed', () => {
	const { layout: _layout, ...noLayout } = CLEAN;
	const flat = cardOf(toolRowCard(created(noLayout), depsOf()));
	assert.match(flat, /"text":"Layout not checked","dim":true/);
	assert.doesNotMatch(flat, /All checks passed/);
});

// The desktop host passes the row's input as a summary string and the result as output text
// (ModUiOverrideProps['tool_row']), not the raw input object or a content array.
test('with the host contract a finished create takes its title, engine and size from the saved job', () => {
	const props = {toolName: 'atelier_create', status: 'success' as const, input: 'design', result: JSON.stringify(CLEAN)};
	const deps = depsOf({readJob: id => (id === 'j1' ? job({title: 'Atelier announce: IG square', input: {width: 1080, height: 1080}}) : undefined)});
	const flat = cardOf(toolRowCard(props, deps));
	assert.match(flat, /"text":"Atelier announce: IG square"/);
	assert.match(flat, /"type":"image","src":"data:image\/jpeg;base64,AAAA"/);
	assert.match(flat, /design · 1080 × 1920/);
	assert.doesNotMatch(flat, /"text":"media"/);
});

test('with the host contract a pending create uses a short summary as its title', () => {
	const props = {toolName: 'atelier_create', status: 'pending' as const, input: 'Launch poster v2'};
	assert.deepEqual(toolRowCard(props, depsOf()), [
		{type: 'stack', direction: 'column', children: [{type: 'status', state: 'running', text: 'Making Launch poster v2'}]},
	]);
});

test('with the host contract a pending create with no summary says it is making a new piece', () => {
	const props = {toolName: 'atelier_create', status: 'pending' as const, input: ''};
	assert.deepEqual(toolRowCard(props, depsOf()), [
		{type: 'stack', direction: 'column', children: [{type: 'status', state: 'running', text: 'Making a new piece'}]},
	]);
});

test('with the host contract the delivered card reads its pieces from the present result', () => {
	const result = JSON.stringify({gallery_url: 'http://127.0.0.1:1/?t=x', presented: [{job_id: 'j1', title: 'A', outputs: []}]});
	const props = {toolName: 'atelier_present', status: 'success' as const, input: '', result};
	const deps = depsOf({readJob: id => (id === 'j1' ? job({title: 'Atelier announce: IG square'}) : undefined)});
	const flat = cardOf(toolRowCard(props, deps));
	assert.match(flat, /"text":"Delivered","bold":true/);
	assert.match(flat, /"text":"1 piece","dim":true/);
	assert.match(flat, /"text":"Atelier announce: IG square"/);
});
