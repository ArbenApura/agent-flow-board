<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- DEP-MODULES -- //
	import { onMount } from 'svelte';
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	// -- REQUIRED PROPS -- //

	let {
		label,
		children,
		count,
		open = $bindable(false),
		aside
	}: {
		label: string;
		children: Snippet;
		/** A quiet number after the label, for example how many earlier runs there are. */
		count?: number;
		open?: boolean;
		/** Small extras on the right of the header, outside the toggle button, such as a copy button. */
		aside?: Snippet;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const bodyId = `${uid}-body`;

	// -- STATES -- //

	// Motion starts after the first paint, so a section that starts open never visibly moves on load
	let animate = $state(false);

	// -- LIFECYCLES -- //

	onMount(() => {
		requestAnimationFrame(() => requestAnimationFrame(() => (animate = true)));
	});
</script>

<!-- A FOLDED SECTION INSIDE A CARD. THE BODY OPENS BY ANIMATING ITS GRID ROW BETWEEN 0 AND 1 FRACTION, SO THE HEIGHT NEEDS NO MEASURING -->
<div class="rounded-lg border border-line">
	<div class="flex min-h-11 items-center gap-2 pr-2">
		<button
			type="button"
			aria-expanded={open}
			aria-controls={bodyId}
			onclick={() => (open = !open)}
			class="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-muted transition-colors hover:text-ink motion-reduce:transition-none"
		>
			<ChevronDown
				size={16}
				aria-hidden="true"
				class={cn(
					'shrink-0 motion-reduce:transition-none',
					animate && 'transition-transform duration-200',
					!open && '-rotate-90'
				)}
			/>
			<span class="min-w-0 truncate">{label}</span>
			{#if count !== undefined}
				<span class="rounded-[6px] bg-raised px-1.5 text-xs text-muted tabular-nums">{count}</span>
			{/if}
		</button>
		{#if aside}{@render aside()}{/if}
	</div>
	<div
		id={bodyId}
		inert={!open}
		class={cn(
			'grid motion-reduce:transition-none',
			animate && 'transition-[grid-template-rows,visibility] duration-200 ease-out',
			open ? 'grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
		)}
	>
		<div class="min-h-0 overflow-hidden">
			<div class="border-t border-line p-3">
				{@render children()}
			</div>
		</div>
	</div>
</div>
