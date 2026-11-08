<script lang="ts">
	// IMPORTED DEP-MODULES
	import { onMount } from 'svelte';

	// -- TYPES -- //

	type Pulse = { horizontal: boolean; line: number; start: number; age: number };

	// -- CONSTANTS -- //

	// Cell size, how far the pointer reaches and how far it bends the mesh, all in CSS pixels
	const CELL = 48;
	const REACH = 210;
	const PULL = 16;
	const PULSE_MS = 1500;
	const PULSE_CELLS = 5;
	const PULSE_EVERY_MS = 900;
	const MAX_PULSES = 4;
	const BUCKETS = 4;
	// Capped so a high density screen never pays for pixels nobody can tell apart
	const MAX_DPR = 1.5;

	// -- STATES -- //

	let canvas = $state<HTMLCanvasElement>();

	// -- LIFECYCLES -- //

	// The mesh is a square grid on a canvas. Each crossing eases toward the pointer so the lines bend, cells near
	// it light up, and a pulse of light now and then runs along a line. Nothing here is reactive state, the loop
	// reads plain variables so no frame ever touches Svelte. It runs only while it is on screen and the tab is
	// visible, and never under reduced motion.
	onMount(() => {
		const el = canvas;
		const host = el?.parentElement;
		if (!el || !host) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const ctx = el.getContext('2d', { alpha: true });
		if (!ctx) return;

		let w = 0;
		let h = 0;
		let cols = 0;
		let rows = 0;
		// Displacement of every crossing, one pair per crossing, row by row
		let ox = new Float32Array(0);
		let oy = new Float32Array(0);
		let pulses: Pulse[] = [];
		// Fallback until the accent token is read; canvas resolves currentcolor from the element
		let color = 'currentcolor';
		let raf = 0;
		let last = 0;
		let sincePulse = 0;
		let onScreen = true;
		let started = false;
		const pointer = { x: 0, y: 0, active: false };

		function readColor() {
			const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
			if (v) color = v;
		}

		function resize() {
			if (!el || !ctx) return;
			w = el.clientWidth;
			h = el.clientHeight;
			const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
			el.width = Math.round(w * dpr);
			el.height = Math.round(h * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			cols = Math.ceil(w / CELL) + 1;
			rows = Math.ceil(h / CELL) + 1;
			ox = new Float32Array(cols * rows);
			oy = new Float32Array(cols * rows);
			pulses = [];
		}

		// Where a crossing is right now
		const px = (c: number, r: number) => c * CELL + ox[r * cols + c];
		const py = (c: number, r: number) => r * CELL + oy[r * cols + c];

		function spawnPulse() {
			if (pulses.length >= MAX_PULSES || cols < PULSE_CELLS + 2 || rows < PULSE_CELLS + 2) return;
			const horizontal = Math.random() < 0.5;
			const count = horizontal ? rows : cols;
			const span = (horizontal ? cols : rows) - 1 - PULSE_CELLS;
			pulses.push({
				horizontal,
				line: 1 + Math.floor(Math.random() * (count - 2)),
				start: Math.floor(Math.random() * Math.max(1, span)),
				age: 0
			});
		}

		// A point along a line, given in crossings, between the two crossings it falls between
		function onLine(p: Pulse, u: number): [number, number] {
			const i = Math.min(Math.floor(u), (p.horizontal ? cols : rows) - 2);
			const f = u - i;
			const c0 = p.horizontal ? i : p.line;
			const r0 = p.horizontal ? p.line : i;
			const c1 = p.horizontal ? i + 1 : p.line;
			const r1 = p.horizontal ? p.line : i + 1;
			return [
				px(c0, r0) + (px(c1, r1) - px(c0, r0)) * f,
				py(c0, r0) + (py(c1, r1) - py(c0, r0)) * f
			];
		}

		function frame(now: number) {
			raf = 0;
			if (!ctx || !onScreen || document.hidden) return;
			const dt = Math.min(now - last, 50);
			last = now;
			const ease = Math.min(1, 0.12 * (dt / 16.667));

			// Ease every crossing toward where the pointer would pull it
			for (let r = 0; r < rows; r++) {
				for (let c = 0; c < cols; c++) {
					const i = r * cols + c;
					let tx = 0;
					let ty = 0;
					if (pointer.active) {
						const dx = pointer.x - c * CELL;
						const dy = pointer.y - r * CELL;
						const d = Math.hypot(dx, dy);
						if (d < REACH && d > 1) {
							const f = (1 - d / REACH) ** 2 * PULL;
							tx = (dx / d) * f;
							ty = (dy / d) * f;
						}
					}
					ox[i] += (tx - ox[i]) * ease;
					oy[i] += (ty - oy[i]) * ease;
				}
			}

			ctx.clearRect(0, 0, w, h);
			ctx.strokeStyle = color;
			ctx.fillStyle = color;
			ctx.lineWidth = 1;
			ctx.lineJoin = 'round';

			// Cells near the pointer glow softly
			if (pointer.active) {
				const c0 = Math.max(0, Math.floor((pointer.x - REACH) / CELL));
				const c1 = Math.min(cols - 2, Math.ceil((pointer.x + REACH) / CELL));
				const r0 = Math.max(0, Math.floor((pointer.y - REACH) / CELL));
				const r1 = Math.min(rows - 2, Math.ceil((pointer.y + REACH) / CELL));
				for (let r = r0; r <= r1; r++) {
					for (let c = c0; c <= c1; c++) {
						const d = Math.hypot(pointer.x - (c + 0.5) * CELL, pointer.y - (r + 0.5) * CELL);
						if (d >= REACH) continue;
						ctx.globalAlpha = (1 - d / REACH) ** 2 * 0.13;
						ctx.beginPath();
						ctx.moveTo(px(c, r), py(c, r));
						ctx.lineTo(px(c + 1, r), py(c + 1, r));
						ctx.lineTo(px(c + 1, r + 1), py(c + 1, r + 1));
						ctx.lineTo(px(c, r + 1), py(c, r + 1));
						ctx.closePath();
						ctx.fill();
					}
				}
			}

			// Every line, in one stroke
			ctx.globalAlpha = 0.11;
			ctx.beginPath();
			for (let r = 0; r < rows; r++) {
				ctx.moveTo(px(0, r), py(0, r));
				for (let c = 1; c < cols; c++) ctx.lineTo(px(c, r), py(c, r));
			}
			for (let c = 0; c < cols; c++) {
				ctx.moveTo(px(c, 0), py(c, 0));
				for (let r = 1; r < rows; r++) ctx.lineTo(px(c, r), py(c, r));
			}
			ctx.stroke();

			// Segments near the pointer brighten, batched into a few alpha buckets
			if (pointer.active) {
				const c0 = Math.max(0, Math.floor((pointer.x - REACH) / CELL));
				const c1 = Math.min(cols - 1, Math.ceil((pointer.x + REACH) / CELL));
				const r0 = Math.max(0, Math.floor((pointer.y - REACH) / CELL));
				const r1 = Math.min(rows - 1, Math.ceil((pointer.y + REACH) / CELL));
				const buckets: number[][] = Array.from({ length: BUCKETS }, () => []);
				const add = (ax: number, ay: number, bx: number, by: number) => {
					const d = Math.hypot(pointer.x - (ax + bx) / 2, pointer.y - (ay + by) / 2);
					if (d >= REACH) return;
					const b = Math.min(BUCKETS - 1, Math.floor((1 - d / REACH) * BUCKETS));
					buckets[b].push(ax, ay, bx, by);
				};
				for (let r = r0; r <= r1; r++) {
					for (let c = c0; c <= c1; c++) {
						if (c < cols - 1) add(px(c, r), py(c, r), px(c + 1, r), py(c + 1, r));
						if (r < rows - 1) add(px(c, r), py(c, r), px(c, r + 1), py(c, r + 1));
					}
				}
				for (let b = 0; b < BUCKETS; b++) {
					const s = buckets[b];
					if (!s.length) continue;
					ctx.globalAlpha = ((b + 1) / BUCKETS) * 0.5;
					ctx.beginPath();
					for (let k = 0; k < s.length; k += 4) {
						ctx.moveTo(s[k], s[k + 1]);
						ctx.lineTo(s[k + 2], s[k + 3]);
					}
					ctx.stroke();
				}
			}

			// A pulse of light running along a line, a bright head with a fading tail
			sincePulse += dt;
			if (sincePulse > PULSE_EVERY_MS) {
				sincePulse = 0;
				spawnPulse();
			}
			for (let k = pulses.length - 1; k >= 0; k--) {
				const p = pulses[k];
				p.age += dt;
				if (p.age >= PULSE_MS) {
					pulses.splice(k, 1);
					continue;
				}
				const t = p.age / PULSE_MS;
				const fade = Math.sin(t * Math.PI);
				const head = p.start + t * PULSE_CELLS;
				for (let tail = 0; tail < 6; tail++) {
					const u = head - tail * 0.22;
					if (u < p.start) break;
					const [x, y] = onLine(p, u);
					ctx.globalAlpha = fade * (0.95 - tail * 0.16);
					ctx.beginPath();
					ctx.arc(x, y, 2.6 - tail * 0.3, 0, Math.PI * 2);
					ctx.fill();
					if (tail === 0) {
						ctx.globalAlpha = fade * 0.18;
						ctx.beginPath();
						ctx.arc(x, y, 9, 0, Math.PI * 2);
						ctx.fill();
					}
				}
			}
			ctx.globalAlpha = 1;
			raf = requestAnimationFrame(frame);
		}

		function play() {
			if (raf || !started || !onScreen || document.hidden) return;
			last = performance.now();
			raf = requestAnimationFrame(frame);
		}

		function onMove(e: PointerEvent) {
			if (e.pointerType !== 'mouse' || !el) return;
			const r = el.getBoundingClientRect();
			pointer.x = e.clientX - r.left;
			pointer.y = e.clientY - r.top;
			pointer.active = true;
		}
		function onLeave() {
			pointer.active = false;
		}

		const sizeWatch = new ResizeObserver(resize);
		const visibleWatch = new IntersectionObserver((entries) => {
			onScreen = entries[0]?.isIntersecting ?? true;
			if (onScreen) play();
		});
		// A theme switch changes the accent, so read it again
		const themeWatch = new MutationObserver(readColor);
		const onVisibility = () => {
			if (!document.hidden) play();
		};

		// Start once the page is idle so the sign in form never waits on the mesh
		const begin = () => {
			readColor();
			resize();
			started = true;
			el.style.opacity = '1';
			play();
		};
		const hasIdle = 'requestIdleCallback' in window;
		const startHandle = hasIdle
			? requestIdleCallback(begin, { timeout: 1200 })
			: window.setTimeout(begin, 400);

		sizeWatch.observe(el);
		visibleWatch.observe(el);
		themeWatch.observe(document.documentElement, { attributes: true });
		host.addEventListener('pointermove', onMove, { passive: true });
		host.addEventListener('pointerleave', onLeave, { passive: true });
		document.addEventListener('visibilitychange', onVisibility);

		return () => {
			if (hasIdle) cancelIdleCallback(startHandle);
			else clearTimeout(startHandle);
			cancelAnimationFrame(raf);
			sizeWatch.disconnect();
			visibleWatch.disconnect();
			themeWatch.disconnect();
			host.removeEventListener('pointermove', onMove);
			host.removeEventListener('pointerleave', onLeave);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
</script>

<!-- THE INTERACTIVE BACKGROUND. A CANVAS FILLING ITS PARENT (THE WHOLE PAGE), WIDE SCREENS ONLY. FADES OUT TOWARD THE BOTTOM LIKE THE GRID TEXTURE DID. DECORATIVE, SO IT IGNORES THE POINTER AND IS HIDDEN FROM SCREEN READERS -->
<canvas
	bind:this={canvas}
	aria-hidden="true"
	class="pointer-events-none absolute inset-0 hidden size-full [mask-image:linear-gradient(to_bottom,black,transparent_75%)] opacity-0 transition-opacity duration-700 lg:block"
></canvas>
