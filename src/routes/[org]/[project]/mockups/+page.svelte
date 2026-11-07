<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import {
		SCOPES,
		SCOPE_LABEL,
		VIEWS,
		VIEW_LABEL,
		filterMockups,
		mockupPrompt,
		readFilters,
		scopeCounts,
		type MockupScope,
		type MockupView
	} from '#lib/board/mockups.js';
	import { ago } from '#lib/board/status.js';
	import MockupCard from '#lib/board/MockupCard.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Funnel from '@lucide/svelte/icons/funnel';
	import Settings from '@lucide/svelte/icons/settings';
	import Search from '@lucide/svelte/icons/search';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	// The search box shows the filter the address holds, so a shared or reloaded link does not look unfiltered
	let q = $state(untrack(() => page.url.searchParams.get('q') ?? ''));
	let filtersOpen = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const filters = $derived(readFilters(page.url.searchParams));
	const shown = $derived(filterMockups(data.mockups, filters));
	const counts = $derived(scopeCounts(data.mockups));
	const filtering = $derived(filters.q.trim() !== '' || filters.scope !== 'all');
	const projectName = $derived(data.summary?.project.name ?? key);

	// -- FUNCTIONS -- //

	/** Keeps the address as the one place the view and the filters live, so a view can be shared and the back button works. */
	function go(change: Record<string, string | null>) {
		const u = new URL(page.url.href);
		for (const [k, v] of Object.entries(change)) {
			if (v === null || v === '') u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		void goto(u, { replaceState: true, reset: false });
	}

	const typed = () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => go({ q: q.trim() || null }), 250);
	};

	function clearFilters() {
		q = '';
		go({ q: null, scope: null });
	}

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(mockupPrompt(projectName));
			toast.success('Prompt copied. Paste it into your coding tool.');
		} catch {
			toast.error('The prompt could not be copied. Select it and copy by hand.');
		}
	}
</script>

<svelte:head><title>Mockups, {projectName}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title="Mockups"
		context={`${data.mockups.length} ${data.mockups.length === 1 ? 'mockup' : 'mockups'}, design ideas your tools drew for this project. A mockup is inspiration, never the spec.`}
	>
		{#snippet actions()}
			<Button href={`${base}/mockups/settings`} data-testid="mockup-settings-button">
				<Settings size={16} /> Settings
			</Button>
		{/snippet}
	</PageHeader>

	{#if data.mockups.length === 0}
		<div
			class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
			data-testid="mockups-empty"
		>
			<EmptyState
				kind="files"
				title="No mockups yet"
				text="Ask your coding tool for a mockup of a screen. It draws one page that looks like the real product and puts it here."
			>
				{#snippet action()}
					{#if data.canWrite}
						<Button variant="primary" onclick={copyPrompt} data-testid="copy-prompt">
							<Copy size={16} /> Copy the prompt
						</Button>
					{/if}
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<!-- ONE TOOLBAR CARD. THE SEARCH AND THE FILTERS, WITH THE VIEW SWITCH ON THE RIGHT, AS ON THE TASKS PAGE -->
		<div class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
			<div class="min-w-56 flex-1 sm:max-w-80">
				<TextField
					label="Search mockups"
					icon={Search}
					hideLabel
					placeholder="Search by title or plan"
					type="search"
					bind:value={q}
					oninput={typed}
					data-testid="filter-q"
				/>
			</div>
			<Popover bind:open={filtersOpen} placement="bottom-start" role="dialog" label="Filters">
				{#snippet trigger({ props, toggle: open })}
					<Button variant="secondary" onclick={open} data-testid="filters-button" {...props}>
						<Funnel size={16} /> Filters
						{#if filters.scope !== 'all'}
							<span
								data-count
								class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-badge font-semibold text-accent-ink tabular-nums"
								>1</span
							>
						{/if}
					</Button>
				{/snippet}
				<div class="w-64 p-2">
					<p class="px-2.5 pt-1 pb-1 text-xs font-medium text-muted">Show</p>
					{#each SCOPES as s (s)}
						{@const on = filters.scope === s}
						<button
							type="button"
							role="radio"
							aria-checked={on}
							onclick={() => go({ scope: s === 'all' ? null : s })}
							class="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
						>
							<span
								class="inline-flex size-4 items-center justify-center rounded-full border border-line"
								aria-hidden="true"
							>
								{#if on}<Check size={12} strokeWidth={3} class="text-accent" />{/if}
							</span>
							<span class="flex-1 text-left">{SCOPE_LABEL[s as MockupScope]}</span>
							<span class="text-xs text-muted tabular-nums">{counts[s as MockupScope]}</span>
						</button>
					{/each}
					{#if filtering}
						<button
							type="button"
							onclick={clearFilters}
							class="mt-1 min-h-11 w-full cursor-pointer rounded-md border-t border-line px-2.5 pt-1 text-left text-sm text-accent-text hover:underline"
							>Clear filters</button
						>
					{/if}
				</div>
			</Popover>
			<span class="ml-auto flex flex-wrap items-center gap-3">
				<SegmentedControl
					label="View"
					value={filters.view}
					options={VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v as MockupView] }))}
					onchange={(v) => go({ view: v === 'cards' ? null : v })}
				/>
			</span>
		</div>

		{#if shown.length === 0}
			<EmptyState
				kind="search"
				title="No mockups match"
				text="Try a different word, or clear the filters."
			>
				{#snippet action()}
					<Button onclick={clearFilters}>Clear filters</Button>
				{/snippet}
			</EmptyState>
		{:else if filters.view === 'cards'}
			<div
				class="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3"
				data-testid="mockup-cards"
			>
				{#each shown as m (m.id)}
					<MockupCard mockup={m} href={`${base}/mockups/${m.id}`} />
				{/each}
			</div>
		{:else}
			<ul
				class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
				data-testid="mockup-list"
			>
				{#each shown as m (m.id)}
					<li
						class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0"
						data-row
						data-testid="mockup"
					>
						<a
							href={`${base}/mockups/${m.id}`}
							class="min-h-11 min-w-0 flex-1 cursor-pointer content-center text-sm font-medium text-ink hover:underline focus-visible:outline-2"
							><span class="line-clamp-2 [overflow-wrap:anywhere]">{m.title}</span></a
						>
						<span class="w-40 shrink-0 truncate font-mono text-xs text-muted max-md:hidden"
							>{m.plan?.ref ?? 'Not on a plan'}</span
						>
						<span class="font-mono text-xs text-muted">v{m.currentVersion}</span>
						<span class="w-24 shrink-0 text-right text-xs text-muted max-sm:hidden"
							>{ago(m.updatedAt)}</span
						>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</PageFrame>
