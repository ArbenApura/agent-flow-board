<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	let q = $derived(data.q);

	// -- REACTIVE STATES -- //

	const KIND: Record<string, string> = {
		item: 'Item',
		section: 'Document',
		decision: 'Decision',
		task: 'Task'
	};

	// -- FUNCTIONS -- //

	function href(h: (typeof data.hits)[number]) {
		const base = `/${data.org.slug}/${h.projectKey}`;
		if (h.kind === 'task') return `${base}/tasks`;
		return h.itemRef ? `${base}/${h.itemRef}` : base;
	}
</script>

<svelte:head><title>Search, {data.org.name}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		title="Search"
		context="Items, documents, decisions and tasks across the organisation."
	/>
	<form method="GET" class="flex items-end gap-2">
		<TextField
			label="Search items, documents, decisions and tasks"
			name="q"
			type="search"
			bind:value={q}
			class="flex-1"
			data-testid="search-q"
		/>
		{#if data.project}<input type="hidden" name="project" value={data.project} />{/if}
		<Button type="submit" variant="primary" data-testid="search-submit">Search</Button>
	</form>

	{#if !data.q}
		<p class="text-sm text-muted">Type a word or a reference. Quotes find an exact phrase.</p>
	{:else if data.hits.length === 0}
		<EmptyState
			title="Nothing found"
			text={`No item, document, decision or task matches "${data.q}". Try fewer or different words.`}
		/>
	{:else}
		<ul
			class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
			data-testid="search-hits"
		>
			{#each data.hits as h (h.kind + h.id)}
				<li class="border-b border-line last:border-b-0">
					<a
						href={href(h)}
						class="flex min-h-12 items-center gap-3 px-3 py-2 hover:bg-raised"
						data-row
						data-testid="search-hit"
					>
						<Badge>{KIND[h.kind]}</Badge>
						<span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{h.title}</span>
						<span class="font-mono text-xs text-muted">{h.projectKey}</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</PageFrame>
