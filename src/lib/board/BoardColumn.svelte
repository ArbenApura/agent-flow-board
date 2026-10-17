<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import { drag, dropzone } from '#lib/actions/dnd.svelte.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		zone,
		title,
		count,
		total,
		dot,
		top,
		empty,
		ondrop,
		children
	}: {
		zone: string;
		title: string;
		/** How many cards this column shows. */
		count: number;
		/** How many items the status has in all. */
		total: number;
		/** Token classes for the status dot and the top edge, from STATUS_STYLE. */
		dot: string;
		top: string;
		empty: string;
		ondrop?: (id: string) => void;
		children: Snippet;
	} = $props();

	// -- REACTIVE STATES -- //

	const active = $derived(drag.zone === zone);
</script>

<!-- A STATUS COLUMN. A COLOURED TOP EDGE, THE NAME, THE COUNT, AND A DROP ZONE FOR CARDS -->
<section
	use:dropzone={{ zone, disabled: !ondrop, ondrop: (id) => ondrop?.(id) }}
	aria-label={title}
	class={cn(
		'flex min-w-0 flex-col rounded-xl border border-t-[3px] transition-colors duration-150',
		top,
		active ? 'border-accent bg-accent-soft' : 'border-line bg-raised'
	)}
>
	<header class="flex items-center gap-2 px-3.5 pt-3 pb-2">
		<span class={cn('size-2 rounded-full', dot)} aria-hidden="true"></span>
		<h2 class="text-badge font-bold tracking-wider text-ink uppercase">{title}</h2>
		<span
			class="rounded-full border border-line bg-surface px-2 text-badge font-semibold text-muted tabular-nums"
			>{total}</span
		>
	</header>
	<div class="flex min-h-24 flex-1 flex-col gap-2.5 px-2.5 pb-3">
		{@render children()}
		{#if count === 0}
			<p
				class="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted"
			>
				{active ? 'Drop here' : empty}
			</p>
		{/if}
	</div>
</section>
