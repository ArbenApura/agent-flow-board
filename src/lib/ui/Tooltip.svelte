<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import { portal } from '#lib/actions/portal.js';
	import { boxOf, place } from '#lib/ui/position.js';

	// -- REQUIRED PROPS -- //

	let {
		text,
		children,
		delay = 400
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
	let pos = $state({ x: 0, y: 0 });
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
		if (!visible || !anchor || !tip) return;
		const r = tip.getBoundingClientRect();
		const placed = place(
			boxOf(anchor),
			{ width: r.width, height: r.height },
			{ width: innerWidth, height: innerHeight },
			'top'
		);
		pos = { x: placed.x, y: placed.y };
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

{#if visible}
	<!-- DYNAMIC RUNTIME POSITION OF THE TOOLTIP -->
	<div
		bind:this={tip}
		use:portal
		id={tipId}
		role="tooltip"
		style="position:fixed;left:{pos.x}px;top:{pos.y}px;"
		class="pointer-events-none z-[3000] max-w-64 rounded-md bg-ink px-2 py-1 text-xs text-bg"
	>
		{text}
	</div>
{/if}
