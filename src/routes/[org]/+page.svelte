<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import { STATUSES, tagDot } from '#lib/board/status.js';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import { cn } from '#lib/ui/cn.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	// One colour for each status in the stacked bar of a project card. Tokens only
	const SEGMENT: Record<string, string> = {
		PLANNED: 'bg-line',
		'IN PROGRESS': 'bg-info',
		TESTING: 'bg-accent',
		'IN REVIEW': 'bg-warning',
		'ON HOLD': 'bg-muted',
		COMPLETED: 'bg-success'
	};
</script>

<svelte:head><title>{data.org.name}</title></svelte:head>

<PageFrame class="flex flex-col gap-6 pb-12">
	<PageHeader title="Projects" context={`You are ${ROLE_LABEL[data.org.role]} here.`} />

	{#if data.overview.length === 0}
		<Card>
			<EmptyState
				title="No projects yet"
				text="An admin creates the first project. Once it exists, plans from your tools and your team show up here."
			/>
		</Card>
	{:else}
		<ul
			class="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
			data-testid="project-cards"
		>
			{#each data.overview as o, i (o.project.id)}
				<li style="--i:{i}">
					<a
						href={`/${data.org.slug}/${o.project.key}`}
						class="lift flex h-full min-h-11 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] hover:bg-raised"
						data-card
					>
						<span class="flex items-center gap-2">
							<span class={cn('size-2.5 rounded-full', tagDot(o.project.colourTag))}></span>
							<span class="font-mono text-xs text-muted">{o.project.key}</span>
							{#if o.running > 0}<Badge tone="running">{o.running} running</Badge>{/if}
						</span>
						<span class="text-base leading-6 font-semibold">{o.project.name}</span>
						<span
							class="flex h-2 w-full overflow-hidden rounded-full bg-raised"
							role="img"
							aria-label={`${o.total} items by status`}
						>
							{#each STATUSES.filter((x) => (o.byStatus[x] ?? 0) > 0 && x !== 'REMOVED') as x (x)}
								<span class={SEGMENT[x]} style="width:{((o.byStatus[x] ?? 0) / o.total) * 100}%"
								></span>
							{/each}
						</span>
						<span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
							<span class="font-medium text-ink">{o.total} {o.total === 1 ? 'item' : 'items'}</span>
							{#each STATUSES.filter((x) => (o.byStatus[x] ?? 0) > 0 && x !== 'REMOVED' && x !== 'COMPLETED' && x !== 'PLANNED') as x (x)}
								<span>{o.byStatus[x]} {x.toLowerCase()}</span>
							{/each}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<section class="flex flex-col gap-2">
		<h2 class="text-lg font-semibold">Members</h2>
		<Card padded={false}>
			<ul>
				{#each data.members as m (m.userId)}
					<li
						class="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0"
						data-row
					>
						<span class="flex items-center gap-3"
							><Avatar name={m.name} size={32} /><span class="flex flex-col"
								><span class="font-medium">{m.name}</span><span class="text-sm text-muted"
									>{m.email}</span
								></span
							></span
						>
						<Badge>{ROLE_LABEL[m.role]}</Badge>
					</li>
				{/each}
			</ul>
		</Card>
	</section>
</PageFrame>
