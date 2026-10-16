<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const ui = $derived(data.ui);
	const link = (ref: string) => `/${org}/${key}/${ref}?tab=ui`;
	/** The first after picture of a run, desktop and the first theme, as the card's thumbnail. */
	const thumb = (r: NonNullable<typeof ui>['runs'][number]) =>
		r.results.find((x) => x.side === 'after' && x.image && x.viewport === 1440)?.image ??
		r.results.find((x) => x.side === 'after' && x.image)?.image;
</script>

<svelte:head><title>UI, {data.summary?.project.name ?? ''}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		title="UI"
		context="The newest screens of every item, measured against the project scale and the pages around them."
	/>

	{#if !ui}
		<EmptyState title="Not available" text="You do not have access to this project." />
	{:else if ui.runs.length === 0}
		<EmptyState
			title="No UI shots yet"
			text="Open an item that adds or changes a screen, list its pages on the UI changes tab, and run the shots."
		/>
	{:else}
		<ul class="flex flex-col gap-3" data-testid="ui-runs">
			{#each ui.runs as r (r.id)}
				<li
					class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
					data-card
					data-testid="ui-run"
				>
					<div class="flex flex-wrap items-center gap-2">
						<a class="font-mono text-sm text-accent-text hover:underline" href={link(r.item.ref)}
							>{r.item.ref}</a
						>
						<span class="min-w-0 flex-1 truncate text-sm font-medium">{r.item.title}</span>
						{#if r.flags.length}
							<Badge tone="danger">{r.flags.length} to fix</Badge>
						{:else}
							<Badge tone="success">Fits</Badge>
						{/if}
					</div>
					<div class="text-xs text-muted">
						{r.pages} page{r.pages === 1 ? '' : 's'}, {ago(r.createdAt)}{r.target
							? `, on the ${r.target}`
							: ''}{r.afterCommit ? `, commit ${r.afterCommit.slice(0, 7)}` : ''}
					</div>
					{#if thumb(r) && ui.canSeePictures}
						<a href={link(r.item.ref)}>
							<img
								src={`/${org}/shot/${thumb(r)}`}
								alt={`The newest screen of ${r.item.ref}`}
								loading="lazy"
								class="max-h-64 w-full rounded-lg border border-line object-cover object-top"
							/>
						</a>
					{/if}
					{#if r.flags.length}
						<ul class="flex flex-col gap-1">
							{#each r.flags.slice(0, 3) as f, i (i)}
								<li class="text-sm text-danger">{f.page ? `${f.page}: ` : ''}{f.text}</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</PageFrame>
