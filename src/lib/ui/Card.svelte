<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		children,
		header,
		footer,
		padded = true,
		class: extra,
		...rest
	}: {
		children: Snippet;
		header?: Snippet;
		footer?: Snippet;
		padded?: boolean;
		class?: string;
	} & Omit<HTMLAttributes<HTMLDivElement>, 'class'> = $props();
</script>

<div
	data-card
	class={cn(
		'overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-[var(--elev-1)]',
		extra
	)}
	{...rest}
>
	{#if header}
		<div class="flex items-center gap-2 border-b border-line px-4 py-3 max-sm:px-3.5">
			{@render header()}
		</div>
	{/if}
	<div class={cn(padded && 'p-4 max-sm:p-3.5')}>
		{@render children()}
	</div>
	{#if footer}
		<div class="flex items-center justify-end gap-2 border-t border-line px-4 py-3 max-sm:px-3.5">
			{@render footer()}
		</div>
	{/if}
</div>
