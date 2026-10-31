import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createJob} from '../src/jobs.ts';
import {
	FRESH_RUN,
	midRunNudge,
	plainTitle,
	stopNudge,
	studioReminder,
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
	assert.equal(plainTitle('Studio reel — v2', 'video'), 'Studio reel: v2');
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
	assert.equal(studioReminder(jobs, 's1'), undefined);
});

test('the reminder lists unshown, running and uncertain work of this session only', () => {
	const jobs = [
		job({state: 'completed', outputs: [{path: '/p/a.png', kind: 'image', bytes: 1}]}),
		job({id: 'j2', title: 'Ad', engine: 'fal-image', state: 'uncertain', error: {code: 'interrupted', message: 'stopped', retryable: false}}),
		job({id: 'x', sessionId: 's2', state: 'running'}),
	];
	assert.equal(
		studioReminder(jobs, 's1'),
		[
			'<studio_jobs>',
			'- j1 "Poster" (design) completed: /p/a.png',
			'- j2 "Ad" (fal-image) uncertain: stopped',
			'An uncertain job may already be billed. Ask before making it again.',
			'</studio_jobs>',
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
	assert.match(first.reason ?? '', /studio_present/);
	assert.equal(stopNudge(first.progress).reason, undefined);
	assert.equal(stopNudge(FRESH_RUN).reason, undefined);
});
