<script lang="ts">
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		lines = 1,
		variant = 'lines',
		class: extra
	}: {
		/** A row draws a status dot, a title bar and a short tail, the shape of one list row. */
		variant?: 'lines' | 'row';
		/** More than one line draws stacked bars, the last one shorter. */
		lines?: number;
		class?: string;
	} = $props();
</script>

<!-- LOADING PLACEHOLDER IN THE FINAL LAYOUT, SO NOTHING SHIFTS WHEN THE DATA ARRIVES -->
<div class={cn('flex flex-col gap-2', extra)} role="status" aria-busy="true" aria-label="Loading">
	{#if variant === 'row'}
		{#each Array.from({ length: lines }, (_, i) => i) as i (i)}
			<div class="flex min-h-12 items-center gap-4">
				<div class="size-5 shrink-0 rounded-[5px] bg-raised motion-safe:animate-pulse"></div>
				<div class="h-4 flex-1 rounded-md bg-raised motion-safe:animate-pulse"></div>
				<div class="h-4 w-16 shrink-0 rounded-md bg-raised motion-safe:animate-pulse"></div>
			</div>
		{/each}
	{:else}
		{#each Array.from({ length: lines }, (_, i) => i) as i (i)}
			<div
				class={cn(
					'h-4 rounded-md bg-raised motion-safe:animate-pulse',
					lines > 1 && i === lines - 1 ? 'w-2/3' : 'w-full'
				)}
			></div>
		{/each}
	{/if}
</div>
