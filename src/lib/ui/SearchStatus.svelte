<script lang="ts">
	// IMPORTED DEP-COMPONENTS
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	// -- REQUIRED PROPS -- //

	let {
		query,
		count,
		searching = false
	}: { query: string; count: number | null; searching?: boolean } = $props();
</script>

<!-- ONE LINE THAT SAYS WHAT THE SEARCH IS DOING, READ OUT POLITELY -->
<p class="flex min-h-6 items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
	{#if searching}
		<LoaderCircle size={16} class="animate-spin" aria-hidden="true" /> Searching for "{query}"
	{:else if query === ''}
		Type to search items, decisions and tasks
	{:else if count === 0}
		Nothing found for "{query}"
	{:else}
		{count} {count === 1 ? 'result' : 'results'} for "{query}"
	{/if}
</p>
