<script lang="ts">
	// IMPORTED TYPES
	import type { Hsv } from '#lib/theme/hsv.js';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import {
		areaGradient,
		handleRing,
		hexToHsv,
		hsvToHex,
		hueColour,
		hueGradient
	} from '#lib/theme/hsv.js';

	// -- REQUIRED PROPS -- //

	let {
		value,
		onchange
	}: {
		/** The current six digit colour. */
		value: string;
		onchange: (hex: string) => void;
	} = $props();

	// -- STATES -- //

	let hsv = $state<Hsv>(untrack(() => hexToHsv(value)));
	let area = $state<HTMLElement>();
	let bar = $state<HTMLElement>();

	// -- REACTIVE STATEMENTS -- //

	// Follows the colour when it changes from outside (a preset, the hex box). The hue is kept when the colour is grey, so the slider does not jump to red.
	$effect(() => {
		const v = value;
		untrack(() => {
			if (hsvToHex(hsv) === v.toLowerCase()) return;
			const next = hexToHsv(v);
			hsv = { h: next.s === 0 || next.v === 0 ? hsv.h : next.h, s: next.s, v: next.v };
		});
	});

	// -- FUNCTIONS -- //

	function set(next: Hsv) {
		hsv = next;
		onchange(hsvToHex(next));
	}

	const clamp = (n: number, hi = 1) => Math.min(hi, Math.max(0, n));

	// Dragging keeps following the pointer outside the box because the pointer is captured
	function dragArea(e: PointerEvent) {
		if (!area || (e.type === 'pointermove' && e.buttons === 0)) return;
		if (e.type === 'pointerdown') area.setPointerCapture(e.pointerId);
		const r = area.getBoundingClientRect();
		set({
			...hsv,
			s: clamp((e.clientX - r.left) / r.width),
			v: 1 - clamp((e.clientY - r.top) / r.height)
		});
	}

	function dragBar(e: PointerEvent) {
		if (!bar || (e.type === 'pointermove' && e.buttons === 0)) return;
		if (e.type === 'pointerdown') bar.setPointerCapture(e.pointerId);
		const r = bar.getBoundingClientRect();
		set({ ...hsv, h: clamp((e.clientX - r.left) / r.width, 1) * 360 });
	}

	function keyArea(e: KeyboardEvent) {
		const step = e.shiftKey ? 0.1 : 0.02;
		const moves: Record<string, [number, number]> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, step],
			ArrowDown: [0, -step]
		};
		const m = moves[e.key];
		if (!m) return;
		e.preventDefault();
		set({ ...hsv, s: clamp(hsv.s + m[0]), v: clamp(hsv.v + m[1]) });
	}

	function keyBar(e: KeyboardEvent) {
		const step = e.shiftKey ? 20 : 4;
		const d =
			e.key === 'ArrowLeft' || e.key === 'ArrowDown'
				? -step
				: e.key === 'ArrowRight' || e.key === 'ArrowUp'
					? step
					: 0;
		if (!d) return;
		e.preventDefault();
		set({ ...hsv, h: (hsv.h + d + 360) % 360 });
	}
</script>

<div class="flex w-[248px] max-w-full flex-col gap-3" data-testid="color-panel">
	<!-- SATURATION AND BRIGHTNESS BOX: THE BASE HUE AND THE WHITE AND BLACK OVERLAYS ARE A RUNTIME MULTI-STOP GRADIENT -->
	<div
		bind:this={area}
		role="slider"
		tabindex="0"
		aria-label="Shade and brightness"
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={Math.round(hsv.v * 100)}
		aria-valuetext="Colour {value}"
		onpointerdown={dragArea}
		onpointermove={dragArea}
		onkeydown={keyArea}
		class="relative h-40 w-full cursor-crosshair touch-none rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		style="background: {areaGradient(hsv.h)};"
	>
		<!-- RUNTIME POSITION OF THE HANDLE IN PERCENT -->
		<span
			class="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full"
			style="left: {hsv.s * 100}%; top: {(1 - hsv.v) *
				100}%; background: {value}; box-shadow: {handleRing};"
		></span>
	</div>

	<!-- HUE SLIDER: THE RAINBOW IS A MULTI-STOP GRADIENT -->
	<div
		bind:this={bar}
		role="slider"
		tabindex="0"
		aria-label="Hue"
		aria-valuemin={0}
		aria-valuemax={360}
		aria-valuenow={Math.round(hsv.h)}
		onpointerdown={dragBar}
		onpointermove={dragBar}
		onkeydown={keyBar}
		class="relative h-4 w-full cursor-pointer touch-none rounded-full border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		style="background: {hueGradient};"
	>
		<!-- RUNTIME POSITION OF THE HANDLE IN PERCENT -->
		<span
			class="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full"
			style="left: {(hsv.h / 360) * 100}%; background: {hueColour(
				hsv.h
			)}; box-shadow: {handleRing};"
		></span>
	</div>
</div>
