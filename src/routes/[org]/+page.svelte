<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- MODULES -- //
	import { STATUSES, STATUS_TONE, tagDot } from '#lib/board/status.js';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import { cn } from '#lib/ui/cn.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.org.name}</title></svelte:head>

<div class="mx-auto flex max-w-[1200px] flex-col gap-6 px-4 py-6 max-sm:px-3.5">
	<div>
		<h1 class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8" data-testid="page-title">
			Projects
		</h1>
		<p class="text-sm leading-[22px] text-muted">You are {ROLE_LABEL[data.org.role]} here.</p>
	</div>

	{#if data.overview.length === 0}
		<Card>
			<EmptyState
				title="No projects yet"
				text="An admin creates the first project. Once it exists, plans from your tools and your team show up here."
			/>
		</Card>
	{:else}
		<ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-cards">
			{#each data.overview as o (o.project.id)}
				<li>
					<a
						href={`/${data.org.slug}/${o.project.key}`}
						class="flex h-full min-h-11 flex-col gap-3 rounded-xl border border-line bg-surface p-4 hover:bg-raised"
						data-card
					>
						<span class="flex items-center gap-2">
							<span class={cn('size-2.5 rounded-full', tagDot(o.project.colourTag))}></span>
							<span class="font-mono text-xs text-muted">{o.project.key}</span>
							{#if o.running > 0}<Badge tone="running">{o.running} running</Badge>{/if}
						</span>
						<span class="text-base leading-6 font-semibold">{o.project.name}</span>
						<span class="flex flex-wrap gap-1.5">
							<Badge>{o.total} {o.total === 1 ? 'item' : 'items'}</Badge>
							{#each STATUSES.filter((s) => (o.byStatus[s] ?? 0) > 0 && s !== 'REMOVED') as s (s)}
								<Badge tone={STATUS_TONE[s]}>{o.byStatus[s]} {s.toLowerCase()}</Badge>
							{/each}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<section class="flex flex-col gap-2">
		<h2 class="text-base leading-6 font-semibold sm:text-lg sm:leading-[26px]">Members</h2>
		<Card padded={false}>
			<ul>
				{#each data.members as m (m.userId)}
					<li
						class="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0"
						data-row
					>
						<span>{m.name} <span class="text-muted">{m.email}</span></span>
						<Badge>{ROLE_LABEL[m.role]}</Badge>
					</li>
				{/each}
			</ul>
		</Card>
	</section>
</div>
