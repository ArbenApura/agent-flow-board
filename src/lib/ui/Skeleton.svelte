<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		lines = 1,
		class: extra
	}: {
		/** More than one line draws stacked bars, the last one shorter. */
		lines?: number;
		class?: string;
	} = $props();
</script>

<!-- LOADING PLACEHOLDER IN THE FINAL LAYOUT, SO NOTHING SHIFTS WHEN THE DATA ARRIVES -->
<div class={cn('flex flex-col gap-2', extra)} role="status" aria-busy="true" aria-label="Loading">
	{#each Array.from({ length: lines }, (_, i) => i) as i (i)}
		<div
			class={cn(
				'h-4 rounded-md bg-raised motion-safe:animate-pulse',
				lines > 1 && i === lines - 1 ? 'w-2/3' : 'w-full'
			)}
		></div>
	{/each}
</div>
