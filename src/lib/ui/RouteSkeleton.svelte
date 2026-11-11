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
			: routeId.endsWith('/[item]') || routeId.endsWith('/notes/[n]')
				? 'item'
				: routeId.endsWith('/mockups/[id]')
					? 'item'
					: routeId.endsWith('/settings')
						? 'form'
						: routeId.endsWith('/activity') || routeId.endsWith('/trash')
							? 'activity'
							: routeId.endsWith('/[project]')
								? 'board'
								: routeId.endsWith('/notes')
									? 'notes'
									: 'list'
	);
</script>

<!-- A SKELETON OF THE NEXT SCREEN IN ITS REAL LAYOUT. IT APPEARS AFTER A SHORT DELAY, SO A FAST NAVIGATION NEVER FLASHES IT -->
<PageFrame class="route-skeleton pb-12" testid="route-skeleton">
	<div role="status" aria-busy="true" aria-label="Loading the next page">
		<div class="mt-6 mb-6 h-24 rounded-2xl border border-line bg-band"></div>
		{#if kind === 'board'}
			<!-- THE TOOLBAR CARD AND THE STATUS COLUMNS OF THE REGISTRY: FIVE, THE FIFTH BEHIND THE ARROWS UNTIL A 1640 WINDOW (AFB-20261111-1344) -->
			<div class="mb-4 h-[58px] rounded-xl border border-line bg-surface"></div>
			<div
				class="grid auto-cols-[max(290px,calc((100%-42px)/4))] grid-flow-col gap-3.5 overflow-hidden max-md:auto-cols-auto max-md:grid-flow-row min-[1640px]:auto-cols-[calc((100%-56px)/5)]"
			>
				{#each [0, 1, 2, 3, 4] as i (i)}
					<div class="h-56 rounded-xl border border-line bg-raised p-3">
						<Skeleton variant="row" lines={2} />
					</div>
				{/each}
			</div>
		{:else if kind === 'notes'}
			<!-- THE NOTES PAGE: THE TREE CARD (288 FROM lg, 320 FROM xl) BESIDE THE TOOLBAR AND THE LIST -->
			<div class="grid gap-6 lg:grid-cols-[288px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
				<div
					class="h-96 rounded-xl border border-line bg-surface p-3 shadow-[var(--elev-1)] max-lg:hidden"
				>
					<Skeleton variant="row" lines={6} />
				</div>
				<div class="flex min-w-0 flex-col gap-4">
					<div class="h-[58px] rounded-xl border border-line bg-surface"></div>
					<div class="rounded-xl border border-line bg-surface px-4 shadow-[var(--elev-1)]">
						<Skeleton variant="row" lines={6} />
					</div>
				</div>
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
