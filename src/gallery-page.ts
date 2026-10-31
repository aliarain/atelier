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
header{display:flex;align-items:center;gap:8px;padding:10px 18px 14px;border-bottom:1px solid var(--cc-border,rgba(165,153,233,.11))}
header .mark{width:15px;height:15px;flex:none;stroke:var(--cc-muted,#A599E9);fill:none;stroke-width:1.6}
h1{font-size:13.5px;font-weight:600}
#count{font-size:12.5px;color:var(--cc-muted,#A599E9)}
#grid{padding:16px 18px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:419px){#grid{grid-template-columns:minmax(0,1fr)}}
@media (min-width:900px){#grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
.tile{border-radius:var(--cc-radius,10px);border:1px solid var(--cc-border,rgba(165,153,233,.11));background:var(--cc-surface,#1E1E3F);overflow:hidden;cursor:default;outline:none}
.tile.selected{border-color:var(--cc-border-strong,rgba(165,153,233,.22));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--cc-accent,#FAD000) 55%,transparent)}
.tile:focus-visible{border-color:var(--cc-accent,#FAD000)}
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
#empty{margin:60px auto;max-width:320px;padding:0 18px;text-align:center;color:var(--cc-muted,#A599E9)}
[hidden]{display:none!important}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
@media (prefers-reduced-motion:reduce){.spinner,.pending .well{animation:none!important}}
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
	cancelled: 'Cancelled',
};

const isActive = (state) => ACTIVE[state] === true;
const statusIcon = (state) => STATUS_ICON[state] || 'dash';
const stateWord = (state) => STATE_WORD[state] || state;

const countText = (jobs) => {
	if (jobs.length === 0) return '';
	const total = jobs.length + (jobs.length === 1 ? ' render' : ' renders');
	const active = jobs.filter((job) => isActive(job.state)).length;
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
const count = document.getElementById('count');
const cards = new Map();
const selected = new Set();
let lastText = '';
let lastCount = '';

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
	const time = make('span', 'time', ago(job.createdAt, Date.now()));
	time.dataset.ts = String(job.createdAt);
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
	const lines = job.error ? [make('div', 'note', job.error.message)] : [];
	if (job.state === 'uncertain') lines.push(make('div', 'note', 'May already be paid. Ask before re-running.'));
	return lines;
};

const toggleSelected = (id, node) => {
	if (selected.has(id)) selected.delete(id);
	else selected.add(id);
	node.classList.toggle('selected', selected.has(id));
};

const buildCard = (job) => {
	const card = make('article', 'tile');
	card.tabIndex = 0;
	if (selected.has(job.id)) card.classList.add('selected');
	const well = make('div', 'well');
	job.outputs.forEach((output) => well.append(mediaNode(output, job.title)));
	if (job.outputs.length === 0 && !isActive(job.state)) well.append(make('div', 'empty', 'No output'));
	if (job.outputs.length === 0 && isActive(job.state)) card.classList.add('pending');
	const body = make('div', 'body');
	const title = make('div', 'title', job.title);
	title.title = job.title;
	body.append(title, metaRow(job), ...noteLines(job));
	card.append(well, body);
	card.addEventListener('click', (event) => {
		if (event.target.closest('video,audio')) return;
		toggleSelected(job.id, card);
	});
	card.addEventListener('keydown', (event) => {
		if (event.target !== card) return;
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		toggleSelected(job.id, card);
	});
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
const render = (jobs) => {
	const nodes = jobs.map(cardFor);
	const keep = new Set(nodes);
	const ids = new Set(jobs.map((job) => job.id));
	[...cards.keys()].filter((id) => !ids.has(id)).forEach((id) => {
		cards.delete(id);
		selected.delete(id);
	});
	[...grid.children].filter((child) => !keep.has(child)).forEach((child) => child.remove());
	nodes.forEach((node, index) => {
		if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
	});
	empty.hidden = jobs.length > 0;
	lastCount = countText(jobs);
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
			render(JSON.parse(text));
		}
		refreshTimes();
		count.textContent = lastCount;
	} catch (error) {
		count.textContent = 'Connection lost, retrying';
	}
	setTimeout(tick, POLL_MS);
};

tick();
`;

const MARK_PATH = 'M3 3.5h4v4H3zM9 3.5h4v4H9zM3 9.5h4v4H3zM9 9.5h4v4H9z';

export function renderIndexHtml(token: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Studio</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header><svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><path d="${MARK_PATH}"/></svg><h1>Studio</h1><span id="count"></span></header>
<main>
<div id="empty" hidden>Nothing made yet. Ask for a poster, a voiceover or a short video.</div>
<div id="grid"></div>
</main>
<script>${PAGE_HELPERS}${PAGE_SCRIPT.replace('__TOKEN__', () => scriptString(token))}</script>
</body>
</html>
`;
}
