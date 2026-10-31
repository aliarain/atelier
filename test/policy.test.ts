import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createJob} from '../src/jobs.ts';
import {
	atelierReminder,
	FRESH_RUN,
	midRunNudge,
	paidConfirmMessage,
	paidGate,
	plainNote,
	plainTitle,
	runningStatus,
	stillVideoFlag,
	stopNudge,
	trackTool,
} from '../src/policy.ts';
import type {Job} from '../src/types.ts';

const job = (overrides: Partial<Job>): Job => ({
	...createJob({
		id: 'j1',
		sessionId: 's1',
		engine: 'design',
		title: 'Poster',
		input: {},
		paid: false,
		ownerPid: 1,
		now: 1,
	}),
	...overrides,
});

test('titles decode HTML entities, collapse whitespace and fall back when empty', () => {
	assert.equal(plainTitle('Ember &amp; Oak  Fall\nMenu', 'design'), 'Ember & Oak Fall Menu');
	assert.equal(plainTitle('&lt;b&gt; &quot;hi&quot; &#39;x&#39; &amp;amp;', 'design'), '<b> "hi" \'x\' &amp;');
	assert.equal(plainTitle('Atelier reel — v2', 'video'), 'Atelier reel: v2');
	assert.equal(plainTitle('Scene 1 – Reveal', 'design'), 'Scene 1: Reveal');
	assert.equal(plainTitle('6–11 PM', 'design'), '6-11 PM');
	assert.equal(plainTitle('   ', 'design'), 'design');
	assert.equal(plainTitle(42, 'video'), 'video');
	assert.equal(plainTitle('x'.repeat(200), 'design').length, 120);
});

test('no reminder when every job in the session is presented or finished', () => {
	const jobs = [
		job({state: 'completed', presented: true}),
		job({id: 'j2', state: 'failed'}),
		job({id: 'other', sessionId: 's2', state: 'running'}),
	];
	assert.equal(atelierReminder(jobs, 's1'), undefined);
});

test('the reminder lists unshown, running and uncertain work of this session only', () => {
	const jobs = [
		job({state: 'completed', outputs: [{path: '/p/a.png', kind: 'image', bytes: 1}]}),
		job({id: 'j2', title: 'Ad', engine: 'fal-image', state: 'uncertain', error: {code: 'interrupted', message: 'stopped', retryable: false}}),
		job({id: 'x', sessionId: 's2', state: 'running'}),
	];
	assert.equal(
		atelierReminder(jobs, 's1'),
		[
			'<atelier_jobs>',
			'- j1 "Poster" (design) completed: /p/a.png',
			'- j2 "Ad" (fal-image) uncertain: stopped',
			'An uncertain job may already be billed. Ask before making it again.',
			'</atelier_jobs>',
		].join('\n'),
	);
});

test('the mid-run nudge fires once at the third unshown make', () => {
	let progress = FRESH_RUN;
	const texts: (string | undefined)[] = [];
	for (let index = 0; index < 4; index++) {
		progress = trackTool(progress, {type: 'created', ok: true});
		const nudge = midRunNudge(progress);
		progress = nudge.progress;
		texts.push(nudge.text);
	}
	assert.deepEqual(texts.map(Boolean), [false, false, true, false]);
});

test('failed makes do not count and presenting silences the nudges', () => {
	let progress = trackTool(FRESH_RUN, {type: 'created', ok: false});
	assert.equal(progress.created, 0);
	progress = trackTool(trackTool(progress, {type: 'created', ok: true}), {type: 'presented'});
	assert.equal(stopNudge(progress).reason, undefined);
});

test('the stop nudge asks once to present work made this run', () => {
	const made = trackTool(FRESH_RUN, {type: 'created', ok: true});
	const first = stopNudge(made);
	assert.match(first.reason ?? '', /atelier_present/);
	assert.equal(stopNudge(first.progress).reason, undefined);
	assert.equal(stopNudge(FRESH_RUN).reason, undefined);
});

test('a presented note is decoded, undashed and cut at 300 characters', () => {
	assert.equal(plainNote('Ember &amp; Oak \u2014 final cut'), 'Ember & Oak: final cut');
	assert.equal(plainNote('a\u2013b'), 'a-b');
	assert.equal(plainNote('x'.repeat(400)).length, 300);
	assert.equal(plainNote(undefined), '');
});

test('the footer says Making followed by the titles, or nothing', () => {
	assert.equal(runningStatus([]), null);
	assert.equal(runningStatus(['Night Bloom']), 'Making Night Bloom');
	assert.equal(runningStatus(['A', 'B']), 'Making A, B');
});

const uncertain = (overrides: Partial<Job>): Job => job({state: 'uncertain', paid: true, engine: 'fal-image', ...overrides});

test('paidGate is clear with no uncertain job for the engine', () => {
	assert.deepEqual(paidGate([], 'fal-image', {}), {kind: 'clear'});
	assert.deepEqual(paidGate([uncertain({engine: 'other'}), job({state: 'completed'})], 'fal-image', {}), {kind: 'clear'});
});

test('paidGate resumes the same input that has a stored result and blocks everything else', () => {
	const stored = uncertain({id: 'u1', input: {prompt: 'fox'}, billedResult: {url: 'https://cdn.example/a.png'}});
	assert.deepEqual(paidGate([stored], 'fal-image', {prompt: 'fox'}), {
		kind: 'resume',
		job: stored,
		billedResult: {url: 'https://cdn.example/a.png'},
	});
	assert.deepEqual(paidGate([stored], 'fal-image', {prompt: 'cat'}), {kind: 'blocked', jobs: [stored]});
	const noResult = uncertain({id: 'u2', input: {prompt: 'fox'}});
	assert.deepEqual(paidGate([noResult], 'fal-image', {prompt: 'fox'}), {kind: 'blocked', jobs: [noResult]});
});

test('the paid confirm text names the engine and the model id', () => {
	assert.equal(
		paidConfirmMessage({engineId: 'fal-image', title: 'Fox', input: {prompt: 'x', model: 'fal-ai/flux/schnell'}}),
		'"Fox" calls a paid provider (fal-image, model fal-ai/flux/schnell) and may cost money.',
	);
	assert.equal(
		paidConfirmMessage({engineId: 'tts', title: 'Hi', input: {}}),
		'"Hi" calls a paid provider (tts) and may cost money.',
	);
});

test('only a video of nothing but still scenes expects stillness', () => {
	const still = {scenes: [{motion: 'still'}, {motion: 'still'}]};
	assert.deepEqual(stillVideoFlag(job({engine: 'video', input: still})), {expectStill: true});
	assert.deepEqual(stillVideoFlag(job({engine: 'video', input: {scenes: [{motion: 'still'}, {motion: 'zoom_in'}]}})), {});
	assert.deepEqual(stillVideoFlag(job({engine: 'video', input: {scenes: []}})), {});
	assert.deepEqual(stillVideoFlag(job({engine: 'motion', input: still})), {});
	assert.deepEqual(stillVideoFlag(job({engine: 'video', input: null})), {});
});
