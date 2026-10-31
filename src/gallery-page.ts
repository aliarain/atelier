// "<" is escaped so a token can never close the script element.
function scriptString(value: string): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

// Every color, font and radius comes from the contract the desktop injects into mod views.
// The fallbacks are the Shades of Purple values, so the page also reads right in a browser.
export const PAGE_STYLE = `
:where(:root){color-scheme:dark}
*{box-sizing:border-box;margin:0}
html,body{min-height:100%}
body{background:var(--cc-bg,#222244);color:var(--cc-fg,#FFFFFF);font:13px/1.4 var(--cc-font-ui,system-ui,-apple-system,sans-serif);-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none}
button{font-family:inherit;color:inherit;user-select:none;-webkit-user-select:none}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 18px 14px;border-bottom:1px solid var(--cc-border,rgba(165,153,233,.11))}
header .mark{width:15px;height:15px;flex:none;stroke:var(--cc-muted,#A599E9);fill:none;stroke-width:1.6}
h1{font-size:13.5px;font-weight:600}
.embedded header .mark,.embedded h1{display:none}
#count{font-size:12.5px;color:var(--cc-muted,#A599E9)}
#filters{display:flex;gap:2px;margin-left:auto;padding:2px;border-radius:9px;border:1px solid var(--cc-border,rgba(165,153,233,.11));background:var(--cc-surface-deep,#161633)}
.seg{display:inline-flex;align-items:baseline;gap:5px;padding:3px 9px;border:0;border-radius:7px;background:transparent;color:var(--cc-muted,#A599E9);font-size:12.5px;line-height:1.3;cursor:default}
.seg:hover{color:var(--cc-fg,#FFFFFF)}
.seg[aria-pressed="true"]{background:var(--cc-surface,#1E1E3F);color:var(--cc-fg,#FFFFFF)}
.seg:focus-visible{outline:1px solid var(--cc-accent,#FAD000);outline-offset:0}
.seg .n{font-variant-numeric:tabular-nums}
#grid{padding:16px 18px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:419px){#grid{grid-template-columns:minmax(0,1fr)}}
@media (min-width:900px){#grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.tile{border-radius:var(--cc-radius,10px);border:1px solid var(--cc-border,rgba(165,153,233,.11));background:var(--cc-surface,#1E1E3F);overflow:hidden;cursor:default}
.frame{position:relative}
.actions{position:absolute;left:8px;right:8px;bottom:8px;display:flex;flex-wrap:wrap;justify-content:center;gap:6px;opacity:0;pointer-events:none;transition:opacity .12s}
.tile:hover .actions,.tile:focus-within .actions{opacity:1;pointer-events:auto}
.has-video .actions{bottom:64px}
.act{padding:4px 9px;border-radius:7px;border:1px solid var(--cc-border-strong,rgba(165,153,233,.22));background:var(--cc-surface,#1E1E3F);color:var(--cc-fg,#FFFFFF);font-size:12px;line-height:1.3;white-space:nowrap;cursor:default}
.act:hover{border-color:var(--cc-muted,#A599E9)}
.act:focus-visible{outline:1px solid var(--cc-accent,#FAD000);outline-offset:0}
.act:disabled{opacity:.55}
.well{aspect-ratio:4/5;background:var(--cc-surface-deep,#161633);overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;scrollbar-width:none}
.well>*{flex:0 0 100%;min-height:0;width:100%}
.well img,.well video{display:block;height:100%;object-fit:contain;background:var(--cc-surface-deep,#161633)}
.well .audio{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:0 12px}
.well .audio svg{width:56px;height:56px;stroke:var(--cc-muted,#A599E9);fill:none;stroke-width:1.6;stroke-linecap:round}
.well .audio audio{width:100%;max-width:100%;height:36px}
.well .empty{display:grid;place-items:center;color:var(--cc-muted,#A599E9);font-size:12px}
.pending .well{background-color:var(--cc-surface-deep,#161633);background-image:linear-gradient(110deg,var(--cc-surface-deep,#161633) 30%,color-mix(in srgb,var(--cc-muted,#A599E9) 9%,var(--cc-surface-deep,#161633)) 50%,var(--cc-surface-deep,#161633) 70%);background-size:300% 100%;animation:shimmer 1.8s linear infinite}
.body{padding:10px 12px 11px}
.title{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:12px;color:var(--cc-muted,#A599E9);white-space:nowrap}
.label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.status{width:12px;height:12px;flex:none}
svg.status{stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
svg.status.cross{color:var(--cc-danger,#EC3A37)}
.spinner{display:inline-block;border-radius:50%;border:1.6px solid color-mix(in srgb,var(--cc-info,#9EFFFF) 25%,transparent);border-top-color:var(--cc-info,#9EFFFF);animation:spin .9s linear infinite}
.shown{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:5px;color:var(--cc-fg,#FFFFFF)}
.shown i{width:6px;height:6px;border-radius:50%;background:var(--cc-accent,#FAD000);display:inline-block}
.note{margin-top:4px;font-size:12px;color:var(--cc-muted,#A599E9);overflow-wrap:anywhere}
#empty,#none{margin:60px auto;max-width:320px;padding:0 18px;text-align:center;color:var(--cc-muted,#A599E9)}
#toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:calc(100% - 36px);padding:7px 12px;border-radius:8px;border:1px solid var(--cc-border-strong,rgba(165,153,233,.22));background:var(--cc-surface,#1E1E3F);color:var(--cc-fg,#FFFFFF);font-size:12.5px;opacity:0;pointer-events:none;transition:opacity .15s}
#toast.show{opacity:1}
[hidden]{display:none!important}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
@media (prefers-reduced-motion:reduce){.spinner,.pending .well{animation:none!important}.actions,#toast{transition:none}}
`;

// Plain functions shared by the page and the tests, which run this exact source in a vm.
export const PAGE_HELPERS = `
const ACTIVE = {queued: true, running: true};
const STATUS_ICON = {
	queued: 'spinner',
	running: 'spinner',
	completed: 'check',
	failed: 'cross',
	uncertain: 'cross',
	cancelled: 'dash',
};
const STATE_WORD = {
	queued: 'Queued',
	running: 'Rendering',
	completed: 'Completed',
	failed: 'Failed',
	uncertain: 'Uncertain',
	cancelled: 'Stopped',
};

const isActive = (state) => ACTIVE[state] === true;
const statusIcon = (state) => STATUS_ICON[state] || 'dash';
const stateWord = (state) => STATE_WORD[state] || state;

const FILTERS = ['all', 'image', 'video', 'audio'];
const FILTER_LABEL = {all: 'All', image: 'Images', video: 'Videos', audio: 'Audio'};
const FILTER_WORD = {
	all: ['render', 'renders'],
	image: ['image', 'images'],
	video: ['video', 'videos'],
	audio: ['audio clip', 'audio clips'],
};
const KIND_BY_ENGINE = {design: 'image', 'fal-image': 'image', video: 'video', motion: 'video', voice: 'audio'};

// A finished job is what it made. A job still running has made nothing yet, so its engine decides.
const jobKind = (job) => {
	const first = job.outputs && job.outputs[0];
	if (first) return first.kind;
	return KIND_BY_ENGINE[job.engine] || null;
};

// A kind filter lists what exists to open: finished jobs with an output. A render still going or a
// failed one has no file of that kind, so it only shows under All.
const hasOutput = (job) => job.state === 'completed' && Array.isArray(job.outputs) && job.outputs.length > 0;

const jobsFor = (jobs, filter) =>
	filter === 'all' ? jobs : jobs.filter((job) => hasOutput(job) && jobKind(job) === filter);

const filterCounts = (jobs) => {
	const counts = {all: jobs.length, image: 0, video: 0, audio: 0};
	jobs.forEach((job) => {
		if (!hasOutput(job)) return;
		const kind = jobKind(job);
		if (kind in counts) counts[kind] += 1;
	});
	return counts;
};

// The model gets the whole error; a tile has room for the first line.
const firstLine = (text) => String(text || '').split('\\n')[0].trim();

// A tile is named by what it is and where it stands, so a screen reader hears more than the title.
const tileLabel = (job) => job.title + ', ' + stateWord(job.state).toLowerCase();

// Variant is the one action a failed or stopped job can take: the same brief, tried again. An
// uncertain paid job may already be billed, so it offers nothing.
const actionsFor = (job) => {
	if (job.state === 'failed' || job.state === 'cancelled') return ['variant'];
	if (job.state !== 'completed' || !hasOutput(job)) return [];
	return job.presented ? ['variant', 'reveal'] : ['variant', 'reveal', 'present'];
};

const actionLabel = (label, title) => label + ' ' + title;

// A segment with nothing in it is hidden, unless it is the selected one: hiding that would leave the bar with no selection.
const visibleFilters = (counts, selected) =>
	FILTERS.filter((name) => name === 'all' || counts[name] > 0 || name === selected);

const parseFilter = (value) => {
	const name = String(value || '').toLowerCase();
	if (FILTERS.includes(name)) return name;
	const singular = name.endsWith('s') ? name.slice(0, -1) : name;
	return FILTERS.includes(singular) ? singular : null;
};

const emptyText = (filter) => 'No ' + FILTER_LABEL[filter].toLowerCase() + ' yet.';

const countText = (jobs, filter = 'all') => {
	const shown = jobsFor(jobs, filter);
	if (shown.length === 0) return '';
	const words = FILTER_WORD[filter];
	const total = shown.length + ' ' + (shown.length === 1 ? words[0] : words[1]);
	const active = shown.filter((job) => job.state === 'running').length;
	if (active === 0) return total;
	return total + ', ' + active + ' rendering';
};

const ago = (ms, nowMs) => {
	const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
	if (seconds < 5) return 'just now';
	if (seconds < 60) return seconds + 's ago';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return minutes + 'm ago';
	const hours = Math.round(minutes / 60);
	if (hours < 48) return hours + 'h ago';
	return Math.round(hours / 24) + 'd ago';
};
`;

const PAGE_SCRIPT = `
const TOKEN = __TOKEN__;
const POLL_MS = 1500;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {check: 'M2.5 6.3l2.3 2.2L9.5 3.8', cross: 'M3 3l6 6M9 3l-6 6', dash: 'M3 6h6'};
const WAVE_BARS = ['M8 28v8', 'M16 20v24', 'M24 12v40', 'M32 22v20', 'M40 16v32', 'M48 24v16'];
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const none = document.getElementById('none');
const count = document.getElementById('count');
const filterBar = document.getElementById('filters');
const toast = document.getElementById('toast');
const FILTER_KEY = 'atelier.gallery.filter';
const ACTIONS = [
	{id: 'variant', label: 'Variant'},
	{id: 'reveal', label: 'Show in Finder'},
	{id: 'present', label: 'Mark shown'},
];
const cards = new Map();
const segments = new Map();
let allJobs = [];
let lastText = '';
let lastCount = '';
let toastTimer = 0;

const readStoredFilter = () => {
	try {
		return localStorage.getItem(FILTER_KEY);
	} catch (error) {
		return null;
	}
};

const storeFilter = (name) => {
	try {
		localStorage.setItem(FILTER_KEY, name);
	} catch (error) {}
};

// The address wins over the saved choice, so a link can open the gallery on one kind.
let filter = parseFilter(new URLSearchParams(location.search).get('filter')) || parseFilter(readStoredFilter()) || 'all';

// The desktop injects its theme after the page loads, so the answer can change from false to true.
const detectEmbedded = () => {
	const injected = getComputedStyle(document.documentElement).getPropertyValue('--cc-bg').trim() !== '';
	document.documentElement.classList.toggle('embedded', injected);
};

const showToast = (message) => {
	toast.textContent = message;
	toast.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
};

const runAction = async (action, job, button) => {
	button.disabled = true;
	try {
		const response = await fetch('/api/action?t=' + encodeURIComponent(TOKEN), {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({action, jobId: job.id}),
		});
		const body = await response.json().catch(() => ({}));
		showToast(body.message || 'That did not work. Try again.');
	} catch (error) {
		showToast('Could not reach Atelier. Try again.');
	}
	button.disabled = false;
};

const make = (tag, className, text) => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
};

const svgNode = (viewBox, className, paths) => {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', viewBox);
	if (className) svg.setAttribute('class', className);
	paths.forEach((d) => {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		svg.append(path);
	});
	return svg;
};

const statusNode = (state) => {
	const kind = statusIcon(state);
	const node = kind === 'spinner' ? make('span', 'status spinner') : svgNode('0 0 12 12', 'status ' + kind, [ICON_PATHS[kind]]);
	node.setAttribute('role', 'img');
	node.setAttribute('aria-label', stateWord(state));
	return node;
};

const imageNode = (output, title) => {
	const img = make('img');
	img.loading = 'lazy';
	img.alt = title;
	img.src = output.url;
	return img;
};

const videoNode = (output) => {
	const video = make('video');
	video.controls = true;
	video.preload = 'metadata';
	video.playsInline = true;
	video.src = output.url;
	return video;
};

const audioNode = (output) => {
	const tile = make('div', 'audio');
	const audio = make('audio');
	audio.controls = true;
	audio.preload = 'metadata';
	audio.src = output.url;
	tile.append(svgNode('0 0 56 56', '', WAVE_BARS), audio);
	return tile;
};

const mediaNode = (output, title) => {
	if (output.kind === 'image') return imageNode(output, title);
	if (output.kind === 'video') return videoNode(output);
	return audioNode(output);
};

const metaRow = (job) => {
	const meta = make('div', 'meta');
	meta.append(statusNode(job.state));
	if (isActive(job.state)) {
		meta.append(make('span', 'label', stateWord(job.state)));
		return meta;
	}
	const time = make('span', 'time', ago(job.updatedAt, Date.now()));
	time.dataset.ts = String(job.updatedAt);
	const label = make('span', 'label');
	label.append(job.engine + ' \\u00b7 ', time);
	meta.append(label);
	if (!job.presented) return meta;
	const shown = make('span', 'shown');
	shown.append(make('i'), 'Shown');
	meta.append(shown);
	return meta;
};

const noteLines = (job) => {
	const failed = job.state === 'failed' || job.state === 'uncertain';
	if (!failed) return [];
	const lines = job.error ? [make('div', 'note', firstLine(job.error.message))] : [];
	if (job.state === 'uncertain') lines.push(make('div', 'note', 'May already be paid. Ask before re-running.'));
	return lines;
};

const actionRow = (job) => {
	const row = make('div', 'actions');
	const offered = actionsFor(job);
	ACTIONS.filter((action) => offered.includes(action.id)).forEach((action) => {
		const button = make('button', 'act', action.label);
		button.type = 'button';
		button.setAttribute('aria-label', actionLabel(action.label, job.title));
		button.addEventListener('click', () => runAction(action.id, job, button));
		row.append(button);
	});
	return row;
};

const buildCard = (job) => {
	const card = make('article', 'tile');
	card.setAttribute('aria-label', tileLabel(job));
	const well = make('div', 'well');
	job.outputs.forEach((output) => well.append(mediaNode(output, job.title)));
	if (job.outputs.length === 0 && !isActive(job.state)) well.append(make('div', 'empty', 'No output'));
	if (job.outputs.length === 0 && isActive(job.state)) card.classList.add('pending');
	const frame = make('div', 'frame');
	frame.append(well);
	if (actionsFor(job).length > 0) {
		frame.append(actionRow(job));
		if (hasOutput(job) && jobKind(job) === 'video') card.classList.add('has-video');
	}
	const body = make('div', 'body');
	const title = make('div', 'title', job.title);
	title.title = job.title;
	body.append(title, metaRow(job), ...noteLines(job));
	card.append(frame, body);
	return card;
};

const cardFor = (job) => {
	const signature = JSON.stringify(job);
	const cached = cards.get(job.id);
	if (cached && cached.signature === signature) return cached.node;
	const node = buildCard(job);
	cards.set(job.id, {signature, node});
	return node;
};

// Moving a media element in the DOM pauses it, so nodes that are already in place are left alone.
const setFilter = (name) => {
	filter = name;
	storeFilter(name);
	render();
	count.textContent = lastCount;
};

const buildSegment = (name) => {
	const button = make('button', 'seg');
	button.type = 'button';
	button.append(make('span', 'name', FILTER_LABEL[name]), make('span', 'n'));
	button.addEventListener('click', () => setFilter(name));
	segments.set(name, button);
	filterBar.append(button);
};

// The buttons are built once and updated in place, so a click never drops keyboard focus.
const renderSegments = (counts) => {
	if (segments.size === 0) FILTERS.forEach(buildSegment);
	const visible = visibleFilters(counts, filter);
	FILTERS.forEach((name) => {
		const button = segments.get(name);
		button.hidden = !visible.includes(name);
		button.setAttribute('aria-pressed', String(name === filter));
		button.lastChild.textContent = String(counts[name]);
	});
	filterBar.hidden = counts.all === 0 || visible.length < 2;
};

const render = () => {
	const shown = jobsFor(allJobs, filter);
	const nodes = shown.map(cardFor);
	const keep = new Set(nodes);
	const ids = new Set(allJobs.map((job) => job.id));
	[...cards.keys()].filter((id) => !ids.has(id)).forEach((id) => cards.delete(id));
	[...grid.children].filter((child) => !keep.has(child)).forEach((child) => child.remove());
	nodes.forEach((node, index) => {
		if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
	});
	renderSegments(filterCounts(allJobs));
	empty.hidden = allJobs.length > 0;
	none.hidden = allJobs.length === 0 || shown.length > 0;
	none.textContent = emptyText(filter);
	lastCount = countText(allJobs, filter);
};

const refreshTimes = () => {
	document.querySelectorAll('.time').forEach((node) => {
		node.textContent = ago(Number(node.dataset.ts), Date.now());
	});
};

const tick = async () => {
	try {
		const response = await fetch('/api/jobs?t=' + encodeURIComponent(TOKEN), {cache: 'no-store'});
		if (!response.ok) throw new Error('status ' + response.status);
		const text = await response.text();
		if (text !== lastText) {
			lastText = text;
			allJobs = JSON.parse(text);
			render();
		}
		detectEmbedded();
		refreshTimes();
		count.textContent = lastCount;
	} catch (error) {
		count.textContent = 'Connection lost, retrying';
	}
	setTimeout(tick, POLL_MS);
};

detectEmbedded();
setTimeout(detectEmbedded, 300);
tick();
`;

const MARK_PATH = 'M3 3.5h4v4H3zM9 3.5h4v4H9zM3 9.5h4v4H3zM9 9.5h4v4H9z';

export function renderIndexHtml(token: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atelier</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header><svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><path d="${MARK_PATH}"/></svg><h1>Atelier</h1><span id="count"></span><div id="filters" role="group" aria-label="Filter by type" hidden></div></header>
<main>
<div id="empty" hidden>Nothing made yet. Ask for a poster, a voiceover or a short video.</div>
<div id="none" hidden></div>
<div id="grid"></div>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>${PAGE_HELPERS}${PAGE_SCRIPT.replace('__TOKEN__', () => scriptString(token))}</script>
</body>
</html>
`;
}
