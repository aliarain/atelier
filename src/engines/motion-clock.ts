// Chrome's virtual time budget does not drive CSS animations or requestAnimationFrame
// timestamps in headless=new: both keep following the real compositor clock. So the page
// gets its own clock instead. This function is serialised into the page before any of its
// scripts run, so it must not reference anything outside its own body.
export function installMotionClock(): void {
	let now = 0;
	let nextId = 1;
	let frames = new Map<number, FrameRequestCallback>();
	const timers = new Map<
		number,
		{due: number; every: number | undefined; run: () => void}
	>();
	// Animations (CSS, transitions, Web Animations) are placed on the clock by when they first appear.
	const startedAt = new Map<Animation, number>();
	const epoch = Date.now();

	const timer = (every: boolean) => {
		return (handler: unknown, delay?: number, ...args: unknown[]): number => {
			const id = nextId;
			nextId += 1;
			// A floor of 1 ms, as in browsers, so a zero-delay timer that re-arms itself cannot stall a seek.
			const wait = Math.max(Number(delay) || 0, 1);
			if (typeof handler !== 'function') return id;
			timers.set(id, {
				due: now + wait,
				every: every ? wait : undefined,
				run: () => handler(...args),
			});
			return id;
		};
	};
	const clear = (id?: number): void => {
		if (id !== undefined) timers.delete(id);
	};

	const dueTimer = (limit: number): [number, {due: number; every: number | undefined; run: () => void}] | undefined => {
		let best: [number, {due: number; every: number | undefined; run: () => void}] | undefined;
		for (const entry of timers.entries()) {
			if (entry[1].due > limit) continue;
			if (best === undefined || entry[1].due < best[1].due) best = entry;
		}
		return best;
	};

	const guarded = (run: () => void): void => {
		try {
			run();
		} catch (error) {
			reportError(error);
		}
	};

	const seek = (time: number): void => {
		for (let next = dueTimer(time); next !== undefined; next = dueTimer(time)) {
			const [id, entry] = next;
			now = Math.max(now, entry.due);
			if (entry.every === undefined) timers.delete(id);
			else entry.due += entry.every;
			guarded(entry.run);
		}
		now = time;
		const batch = frames;
		frames = new Map();
		for (const callback of batch.values()) guarded(() => callback(time));
		for (const animation of document.getAnimations()) {
			if (!startedAt.has(animation)) startedAt.set(animation, now);
			animation.pause();
			animation.currentTime = now - (startedAt.get(animation) ?? now);
		}
		for (const svg of document.querySelectorAll('svg')) {
			svg.pauseAnimations();
			svg.setCurrentTime(now / 1000);
		}
	};

	performance.now = (): number => now;
	Date.now = (): number => epoch + now;
	window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
		const id = nextId;
		nextId += 1;
		frames.set(id, callback);
		return id;
	};
	window.cancelAnimationFrame = (id: number): void => {
		frames.delete(id);
	};
	Object.assign(window, {
		setTimeout: timer(false),
		setInterval: timer(true),
		clearTimeout: clear,
		clearInterval: clear,
		__motionSeek: seek,
	});
}

export function clockInstallSource(): string {
	return `(${installMotionClock.toString()})()`;
}

export function seekExpression(timeMs: number): string {
	return `window.__motionSeek(${timeMs})`;
}
