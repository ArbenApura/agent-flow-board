<script lang="ts">
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';

	// -- REQUIRED PROPS -- //

	let { routeId }: { routeId: string | null } = $props();

	// -- REACTIVE STATES -- //

	/** The shape of the screen being opened, taken from its route, so the skeleton matches the page that arrives. */
	const kind = $derived(
		!routeId
			? 'list'
			: routeId.endsWith('/[item]')
				? 'item'
				: routeId.endsWith('/settings')
					? 'form'
					: routeId.endsWith('/activity') || routeId.endsWith('/trash')
						? 'activity'
						: routeId.endsWith('/[project]')
							? 'board'
							: 'list'
	);
</script>

<!-- A SKELETON OF THE NEXT SCREEN IN ITS REAL LAYOUT. IT APPEARS AFTER A SHORT DELAY, SO A FAST NAVIGATION NEVER FLASHES IT -->
<PageFrame class="route-skeleton pb-12" testid="route-skeleton">
	<div role="status" aria-busy="true" aria-label="Loading the next page">
		<div class="mt-6 mb-6 h-24 rounded-2xl border border-line bg-band"></div>
		{#if kind === 'board'}
			<div class="grid grid-cols-2 gap-4 lg:grid-cols-6">
				{#each [0, 1, 2, 3, 4, 5] as i (i)}
					<div class="h-56 rounded-xl border border-line bg-surface p-3 shadow-[var(--elev-1)]">
						<Skeleton variant="row" lines={2} />
					</div>
				{/each}
			</div>
		{:else if kind === 'item'}
			<div class="mb-6 h-32 rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"></div>
			<div class="rounded-xl border border-line bg-surface px-4 shadow-[var(--elev-1)]">
				<Skeleton variant="row" lines={4} />
			</div>
		{:else if kind === 'form'}
			<div class="flex flex-col gap-4">
				{#each [0, 1, 2] as i (i)}
					<div class="rounded-xl border border-line bg-surface p-5 shadow-[var(--elev-1)]">
						<Skeleton lines={3} />
					</div>
				{/each}
			</div>
		{:else if kind === 'activity'}
			<div class="rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]">
				<Skeleton variant="row" lines={6} />
			</div>
		{:else}
			<div class="rounded-xl border border-line bg-surface px-4 shadow-[var(--elev-1)]">
				<Skeleton variant="row" lines={6} />
			</div>
		{/if}
	</div>
</PageFrame>
