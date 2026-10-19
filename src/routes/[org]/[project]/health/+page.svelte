<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { DRIFT_TEXT } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Sparkline from '#lib/ui/Sparkline.svelte';
	import Card from '#lib/ui/Card.svelte';
	// -- DEP-COMPONENTS -- //
	import GitCompare from '@lucide/svelte/icons/git-compare';
	import Hourglass from '@lucide/svelte/icons/hourglass';
	import Moon from '@lucide/svelte/icons/moon';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const h = $derived(data.health);
	const link = (ref: string) => `/${org}/${key}/${ref}`;
	const tiles = $derived(
		h
			? [
					{ label: 'Stale claims', icon: Hourglass, count: h.staleClaims.length },
					{ label: 'Quiet items', icon: Moon, count: h.quietItems.length },
					{ label: 'Drift', icon: GitCompare, count: h.drift.length }
				]
			: []
	);
	const total = $derived(
		h
			? h.staleClaims.length +
					h.stepsWithoutEvidence.length +
					h.quietItems.length +
					h.drift.length +
					(h.backup && !h.backup.ok ? 1 : 0)
			: 0
	);
</script>

<svelte:head><title>Health, {data.summary?.project.name ?? ''}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title="Health"
		context="What needs a look in this project. Nothing here blocks any work."
	/>

	{#if h}
		<ul class="grid grid-cols-2 gap-4 lg:grid-cols-3" data-testid="health-tiles">
			{#each tiles as t (t.label)}
				<li
					class="flex items-center gap-4 rounded-xl border border-line bg-surface p-5 shadow-[var(--elev-1)]"
					data-card
				>
					<span
						class={cn(
							'inline-flex size-11 shrink-0 items-center justify-center rounded-xl',
							t.count ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success'
						)}
						aria-hidden="true"><t.icon size={22} /></span
					>
					<span class="flex min-w-0 flex-col">
						<span
							class={cn(
								'text-2xl leading-tight font-semibold tabular-nums',
								t.count ? 'text-warning' : 'text-success'
							)}>{t.count}</span
						>
						<span class="text-sm break-words text-muted">{t.label}</span>
					</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if h}
		<Card role="region" aria-label="Changes per day" data-testid="activity-spark">
			{#snippet header()}
				<h2 class="text-lg font-semibold">Changes per day, last 14 days</h2>
			{/snippet}
			<Sparkline
				values={data.daily.map((d) => d.count)}
				labels={data.daily.map((d) => d.day)}
				label="Changes per day"
			/>
		</Card>
	{/if}

	{#if !h}
		<EmptyState
			kind="locked"
			title="Not available"
			text="You do not have access to this project."
		/>
	{:else if total === 0}
		<EmptyState
			kind="health"
			title="Nothing needs attention"
			text="No claim is stale, and no item has drifted from its steps."
		/>
	{/if}

	{#if h}
		{#if h.staleClaims.length}
			<section class="flex flex-col gap-2" aria-label="Stale claims" data-testid="stale-claims">
				<h2 class="text-lg font-semibold">Stale claims</h2>
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each h.staleClaims as c (c.sessionId)}
						<li
							class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
							data-row
						>
							<Badge tone="warning">{c.kind === 'idle' ? 'idle' : 'not recorded'}</Badge>
							<span class="min-w-0 flex-1 text-sm">
								{c.tool} on
								<a class="font-mono text-xs text-accent-text hover:underline" href={link(c.itemRef)}
									>{c.itemRef}</a
								>{c.phase ? `, phase ${c.phase}` : ''}
								<span class="block text-xs text-muted">{c.reason}</span>
							</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if h.stepsWithoutEvidence.length}
			<section
				class="flex flex-col gap-2"
				aria-label="Steps without evidence"
				data-testid="no-evidence"
			>
				<h2 class="text-lg font-semibold">Steps without evidence</h2>
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each h.stepsWithoutEvidence as s (s.itemRef + s.key)}
						<li
							class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
							data-row
						>
							<a
								class="w-24 shrink-0 font-mono text-xs text-accent-text hover:underline"
								href={link(s.itemRef)}>{s.itemRef}</a
							>
							<span class="min-w-0 flex-1 truncate text-sm">{s.key} {s.text}</span>
							{#if s.target}<Badge tone="info">needs {s.target}</Badge>{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if h.quietItems.length}
			<section class="flex flex-col gap-2" aria-label="Quiet items" data-testid="quiet">
				<h2 class="text-lg font-semibold">Quiet items</h2>
				<div class="text-xs text-muted">
					In progress with no activity for {h.project.staleDays} days or more.
				</div>
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each h.quietItems as q (q.ref)}
						<li
							class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
							data-row
						>
							<a
								class="w-24 shrink-0 font-mono text-xs text-accent-text hover:underline"
								href={link(q.ref)}>{q.ref}</a
							>
							<span class="min-w-0 flex-1 truncate text-sm">{q.title}</span>
							<span class="shrink-0 text-xs text-muted">{q.days} days</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if h.drift.length}
			<section class="flex flex-col gap-2" aria-label="Drift" data-testid="drift-list">
				<h2 class="text-lg font-semibold">Drift</h2>
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each h.drift as d (d.ref)}
						<li
							class="flex flex-col gap-0.5 border-b border-line px-3 py-2 last:border-b-0"
							data-row
						>
							<span class="text-sm">
								<a class="font-mono text-xs text-accent-text hover:underline" href={link(d.ref)}
									>{d.ref}</a
								>
								{d.title}
							</span>
							{#each d.codes as code (code)}
								<span class="text-xs text-muted">{DRIFT_TEXT[code] ?? code}</span>
							{/each}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if h.backup && !h.backup.ok}
			<section class="flex flex-col gap-2" aria-label="Backups" data-testid="backup-health">
				<h2 class="text-lg font-semibold">Backups</h2>
				<Notice tone="danger">{h.backup.message}</Notice>
			</section>
		{/if}
	{/if}
</PageFrame>
