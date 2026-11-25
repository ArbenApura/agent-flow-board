<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { portal } from '#lib/actions/portal.js';
	import { boxOf, place } from '#lib/ui/position.js';

	// -- REQUIRED PROPS -- //

	let {
		text,
		children,
		delay = 250
	}: {
		text: string;
		children: Snippet<[{ props: Record<string, unknown> }]>;
		delay?: number;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const tipId = `${uid}-tip`;

	// -- STATES -- //

	let anchor = $state<HTMLElement>();
	let tip = $state<HTMLElement>();
	let visible = $state(false);
	/** Stays true for the out fade, so the tip does not vanish at once. */
	let mounted = $state(false);
	let shown = $state(false);
	// The arrow sits over the middle of the anchor, whatever the tip had to shift to stay inside the screen
	let pos = $state({ x: 0, y: 0, arrow: 0, above: true });
	let timer: ReturnType<typeof setTimeout> | undefined;

	// -- FUNCTIONS -- //

	function show() {
		clearTimeout(timer);
		timer = setTimeout(() => (visible = true), delay);
	}

	function hide() {
		clearTimeout(timer);
		visible = false;
	}

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		if (visible) {
			mounted = true;
			const frame = requestAnimationFrame(() => (shown = true));
			return () => {
				cancelAnimationFrame(frame);
				shown = false;
				const t = setTimeout(() => (mounted = false), 120);
				return () => clearTimeout(t);
			};
		}
	});

	$effect(() => {
		if (!mounted || !anchor || !tip) return;
		const r = tip.getBoundingClientRect();
		const box = boxOf(anchor);
		const placed = place(
			box,
			{ width: r.width, height: r.height },
			{ width: innerWidth, height: innerHeight },
			'top'
		);
		// Keep the arrow inside the rounded corners of the tip
		const centre = box.left + box.width / 2 - placed.x;
		pos = {
			x: placed.x,
			y: placed.y,
			arrow: Math.min(Math.max(10, centre), Math.max(10, r.width - 10)),
			above: placed.placement.startsWith('top')
		};
	});
</script>

<span
	bind:this={anchor}
	class="inline-flex"
	role="presentation"
	onpointerenter={show}
	onpointerleave={hide}
	onfocusin={show}
	onfocusout={hide}
	onkeydown={(e) => e.key === 'Escape' && hide()}
>
	{@render children({ props: { 'aria-describedby': visible ? tipId : undefined } })}
</span>

{#if mounted}
	<!-- DYNAMIC RUNTIME POSITION OF THE TOOLTIP -->
	<div
		bind:this={tip}
		use:portal
		id={tipId}
		role="tooltip"
		style="position:fixed;left:{pos.x}px;top:{pos.y}px;"
		class="pointer-events-none z-[3000] w-max max-w-64 rounded-md bg-ink px-2.5 py-1.5 text-xs leading-4 font-medium text-bg shadow-[var(--elev-2)] transition-[opacity,translate] duration-100 motion-reduce:transition-none {shown
			? 'translate-y-0 opacity-100'
			: 'translate-y-0.5 opacity-0'}"
	>
		{text}
		<!-- THE ARROW POINTS AT THE ANCHOR. ITS POSITION ALONG THE TIP IS A RUNTIME COORDINATE -->
		<span
			aria-hidden="true"
			class="absolute size-2 -translate-x-1/2 rotate-45 bg-ink {pos.above ? '-bottom-1' : '-top-1'}"
			style="left:{pos.arrow}px;"
		></span>
	</div>
{/if}
