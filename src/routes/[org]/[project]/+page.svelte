<script lang="ts">
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { ApiItem, ItemRow, Running } from '#lib/board/rows.js';
	// -- ENVS -- //
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { slimItem } from '#lib/board/rows.js';
	import ItemLine from '#lib/board/ItemLine.svelte';
	import { STATUSES, STATUS_TONE, VIEWS, ago, type View } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import VirtualList from '#lib/ui/VirtualList.svelte';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import Funnel from '@lucide/svelte/icons/funnel';
	import Plus from '@lucide/svelte/icons/plus';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const VIEW_LABEL: Record<View, string> = { board: 'Board', areas: 'Areas', list: 'List' };
	const PAGE = 200;

	// -- STATES -- //

	// The search box shows the filter the address holds, so a shared or reloaded link does not look unfiltered
	let q = $state(untrack(() => data.filters.q ?? ''));
	// Starts with the first page the server sent, so the list is in the first HTML and not only after hydration
	let listItems = $state<ItemRow[]>(untrack(() => data.list?.items ?? []));
	let cursor = $state<number | null>(untrack(() => data.list?.nextCursor ?? null));
	let loadingMore = $state(false);
	let loadError = $state('');
	let wanted = 0;
	/** Counts how many times the filter changed, so pages that were loading for an old filter are thrown away. */
	let generation = 0;
	let creating = $state(false);
	let filtersOpen = $state(false);
	let newTitle = $state('');
	let newError = $state('');
	let busy = $state(false);
	/** A phone gets taller rows, the same as the other lists. */
	let narrow = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// -- REACTIVE STATES -- //

	const summary = $derived(data.summary);
	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const running = $derived<Running[]>(summary?.running ?? []);
	const canWrite = $derived(summary?.caps.includes('write') ?? false);

	// -- FUNCTIONS -- //

	/** Keeps the address as the one place the filters live, so a view can be shared and the back button works. */
	function go(change: Record<string, string | null>, replace = true) {
		const u = new URL(page.url.href);
		// Changing the view or a filter leaves the quick look behind, so it does not pop open later on another list
		if (!('item' in change)) u.searchParams.delete('item');
		for (const [k, v] of Object.entries(change)) {
			if (v === null || v === '') u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		void goto(u, { reset: false, replaceState: replace });
	}

	const typed = () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => go({ q: q.trim() || null }), 250);
	};

	function toggleStatus(s: string) {
		const now = (page.url.searchParams.get('status') ?? '').split(',').filter(Boolean);
		const next = now.includes(s) ? now.filter((x) => x !== s) : [...now, s];
		go({ status: next.join(',') || null });
	}

	const itemHref = (ref: string) => `${base}/${ref}`;
	/** The quick look is part of the address, so it can be shared and Back closes it. */
	const peek = (row: ItemRow) => go({ item: row.ref }, false);
	let fetched = $state<ItemRow | null>(null);
	/** The last item shown, kept while the drawer slides out, so it does not flash empty. */
	let lastPeeked = $state<ItemRow | null>(null);
	const peekRef = $derived(page.url.searchParams.get('item'));
	const peeked = $derived.by(() => {
		if (!peekRef) return null;
		const all = [
			...data.columns.flatMap((c) => c.items),
			...data.areas.flatMap((a) => a.items),
			...listItems
		];
		return all.find((r) => r.ref === peekRef) ?? (fetched?.ref === peekRef ? fetched : null);
	});
	const runningOf = (id: string) => running.filter((r) => r.itemId === id);

	/** Loads the pages the list scrolled into, one after another by keyset, until the screen is covered. */
	async function reach(index: number) {
		// After a failure nothing is retried by itself, so a broken connection is not hammered; the person presses Try again
		if (data.view !== 'list' || loadingMore || loadError || cursor === null) return;
		wanted = Math.max(wanted, index);
		if (index < listItems.length - 40) return;
		loadingMore = true;
		loadError = '';
		const started = generation;
		try {
			while (cursor !== null && index >= listItems.length - 40) {
				// A local value built and dropped inside the call, never state
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				const params: URLSearchParams = new URLSearchParams({
					limit: String(PAGE),
					cursor: String(cursor)
				});
				if (data.filters.status.length) params.set('status', data.filters.status.join(','));
				if (data.filters.q) params.set('q', data.filters.q);
				if (data.filters.stream) params.set('stream', data.filters.stream);
				if (data.filters.scope) params.set('scope', data.filters.scope);
				const more: { items: ApiItem[]; nextCursor: number | null } = await api(
					org,
					`/projects/${key}/items?${params}`
				);
				// The filter changed while this page was coming: it belongs to the old list and is dropped
				if (started !== generation) return;
				listItems = [...listItems, ...more.items.map(slimItem)];
				cursor = more.nextCursor;
			}
		} catch (e) {
			loadError = e instanceof ApiError ? e.message : 'The next items did not load.';
		} finally {
			loadingMore = false;
		}
	}

	async function createItem() {
		newError = '';
		busy = true;
		try {
			const made = await api<{ ref: string }>(org, `/projects/${key}/items`, {
				body: { title: newTitle.trim(), phases: [] },
				key: newKey()
			});
			creating = false;
			newTitle = '';
			await goto(itemHref(made.ref));
		} catch (e) {
			newError = e instanceof ApiError ? e.message : 'The item was not created.';
		} finally {
			busy = false;
		}
	}

	const shown = $derived(peeked ?? lastPeeked);

	// -- EFFECTS -- //

	$effect(() => {
		if (peeked) lastPeeked = peeked;
	});

	// A shared link can name an item this page has not loaded (past the first rows of a long list). It is fetched on its own, and a name that
	// matches nothing is taken out of the address
	$effect(() => {
		const ref = peekRef;
		if (!ref || peeked || fetched?.ref === ref) return;
		let live = true;
		api<ApiItem>(org, `/items/${encodeURIComponent(ref)}`).then(
			(item) => {
				if (live) fetched = slimItem(item);
			},
			() => {
				if (live) go({ item: null });
			}
		);
		return () => {
			live = false;
		};
	});

	$effect(() => {
		const query = matchMedia('(max-width: 639px)');
		const update = () => (narrow = query.matches);
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	// A new filter starts the list again from its first page. A live change keeps the pages already loaded and only
	// replaces the first page, so the list does not blank out while someone has scrolled deep into it.
	let seenFilter = untrack(() => JSON.stringify([data.view, data.filters]));
	$effect(() => {
		const fresh = data.list?.items ?? [];
		const signature = JSON.stringify([data.view, data.filters]);
		// What the list holds now is read without making the effect depend on it, or writing it would run the effect again
		const held = untrack(() => listItems);
		if (signature === seenFilter && held.length > fresh.length && fresh.length > 0) {
			const oldest = fresh[fresh.length - 1].number;
			listItems = [...fresh, ...held.filter((r) => r.number < oldest)];
			return;
		}
		seenFilter = signature;
		generation++;
		listItems = fresh;
		cursor = data.list?.nextCursor ?? null;
	});
</script>

<svelte:head><title>{summary?.project.name ?? 'Project'}</title></svelte:head>

<PageFrame class="pb-12">
	<PageHeader title={summary?.project.name ?? ''}>
		{#snippet context()}
			<span class="font-mono">{key}</span>, {summary?.total ?? 0}
			{summary?.total === 1 ? 'item' : 'items'}
		{/snippet}
		{#snippet actions()}
			{#if canWrite}
				<Button variant="primary" onclick={() => (creating = true)} data-testid="new-item">
					<Plus size={16} /> New item
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if running.length}
		<section
			class="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 shadow-[var(--elev-1)]"
			aria-label="Running now"
			data-testid="running-now"
		>
			<span class="text-sm font-medium text-ink">Running now</span>
			{#each running as r (r.sessionId)}
				<a href={itemHref(r.itemRef)}>
					<RunningBadge tool={r.tool} title={r.title} phase={r.phase ?? undefined} />
				</a>
			{/each}
		</section>
	{/if}

	<!-- ONE TOOLBAR ROW. THE VIEW, THE SEARCH AND THE STATUS FILTERS IN A POPOVER (ADR-004) -->
	<div class="mb-6 flex flex-wrap items-center gap-3">
		<SegmentedControl
			label="View"
			value={data.view}
			options={VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
			onchange={(v) => go({ view: v === 'board' ? null : v })}
		/>
		<div class="min-w-56 flex-1 sm:max-w-96">
			<TextField
				label="Filter by title or reference"
				hideLabel
				placeholder="Filter by title or reference"
				type="search"
				bind:value={q}
				oninput={typed}
				data-testid="filter-q"
			/>
		</div>
		<Popover bind:open={filtersOpen} placement="bottom-start" role="dialog" label="Status filter">
			{#snippet trigger({ props, toggle })}
				<Button variant="secondary" onclick={toggle} data-testid="filters-button" {...props}>
					<Funnel size={16} /> Filters
					{#if data.filters.status.length}
						<span
							data-count
							class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-ink tabular-nums"
							>{data.filters.status.length}</span
						>
					{/if}
				</Button>
			{/snippet}
			<div class="w-64 p-2" role="group" aria-label="Status filter">
				{#each STATUSES as s (s)}
					<button
						type="button"
						role="checkbox"
						aria-checked={data.filters.status.includes(s)}
						onclick={() => toggleStatus(s)}
						class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised aria-checked:font-medium"
					>
						<span
							class="inline-flex size-4 items-center justify-center rounded border border-line"
							aria-hidden="true"
						>
							{#if data.filters.status.includes(s)}<Check
									size={12}
									strokeWidth={3}
									class="text-accent"
								/>{/if}
						</span>
						<span class="flex-1 text-left">{s.toLowerCase()}</span>
						{#if summary?.byStatus[s]}<span class="text-xs text-muted tabular-nums"
								>{summary.byStatus[s]}</span
							>{/if}
					</button>
				{/each}
				{#if data.filters.status.length}
					<button
						type="button"
						onclick={() => go({ status: null })}
						class="mt-1 min-h-10 w-full cursor-pointer rounded-md border-t border-line px-2.5 pt-1 text-left text-sm text-accent-text hover:underline"
						>Clear filters</button
					>
				{/if}
			</div>
		</Popover>
	</div>

	{#if (summary?.total ?? 0) === 0}
		<EmptyState
			kind="welcome"
			title="No items in this project yet"
			text="Create the first item here, or let a connected tool create it from a plan."
		>
			{#snippet action()}
				{#if canWrite}<Button variant="primary" onclick={() => (creating = true)}>New item</Button
					>{/if}
			{/snippet}
		</EmptyState>
	{:else if data.view === 'board'}
		<!-- A COLUMN WITH NOTHING IN IT SHRINKS, SO THE ROOM GOES TO THE CARDS -->
		<div
			class="grid grid-cols-1 gap-4 md:[grid-template-columns:var(--cols)] md:overflow-x-auto"
			style="--cols:{data.columns
				.map((c) => (c.total ? 'minmax(190px,1fr)' : 'minmax(120px,0.45fr)'))
				.join(' ')}"
			data-testid="board-columns"
		>
			{#each data.columns as col (col.status)}
				<section
					class="flex flex-col gap-3 rounded-xl bg-raised/60 p-3"
					aria-label={col.status.toLowerCase()}
				>
					<div role="heading" aria-level="2" class="flex items-center gap-2 px-1">
						<Badge tone={STATUS_TONE[col.status]}>{col.status.toLowerCase()}</Badge>
						<span class="text-sm text-muted tabular-nums">{col.total}</span>
					</div>
					{#each col.items as row (row.id)}
						<ItemLine
							{row}
							href={itemHref(row.ref)}
							running={runningOf(row.id)}
							compact
							onopen={peek}
						/>
					{:else}
						<p class="px-1 py-2 text-sm text-muted">Nothing {col.status.toLowerCase()}.</p>
					{/each}
					{#if col.total > col.items.length}
						<a
							class="min-h-9 px-1 text-sm text-accent-text hover:underline"
							href={`${base}?view=list&status=${encodeURIComponent(col.status)}`}
							>Show all {col.total}</a
						>
					{/if}
				</section>
			{/each}
		</div>
	{:else if data.view === 'areas'}
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2" data-testid="area-groups">
			{#each data.areas as a (a.stream + '/' + a.scope)}
				<section class="flex flex-col gap-3" aria-label={`${a.stream} ${a.scope}`}>
					<h2 class="flex items-center justify-between text-lg font-semibold">
						<span>{a.stream} <span class="text-muted">/</span> {a.scope}</span>
						<a
							class="text-sm font-normal text-accent-text hover:underline"
							href={`${base}?view=list&stream=${encodeURIComponent(a.stream)}&scope=${encodeURIComponent(a.scope)}`}
							>{a.total} items</a
						>
					</h2>
					{#each a.items as row (row.id)}
						<ItemLine
							{row}
							href={itemHref(row.ref)}
							running={runningOf(row.id)}
							compact
							onopen={peek}
						/>
					{/each}
				</section>
			{:else}
				<EmptyState
					kind="search"
					title="No items match this filter"
					text="Try a different word or clear the status filter."
				/>
			{/each}
		</div>
	{:else if data.list}
		{#if data.list.total === 0}
			<EmptyState
				kind="search"
				title="No items match"
				text="Try a different word or clear the status filter."
			/>
		{:else}
			<div class="mb-2 text-sm text-muted" data-testid="list-count">
				{data.list.total.toLocaleString('en')} items
			</div>
			<div class="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
				<VirtualList
					items={listItems}
					total={data.list.total}
					rowHeight={narrow ? 56 : 52}
					keyOf={(r) => r.id}
					label={`${data.list.total.toLocaleString('en')} items`}
					class="h-[70dvh]"
					onreach={reach}
				>
					{#snippet row(r)}
						<ItemLine row={r} href={itemHref(r.ref)} running={runningOf(r.id)} onopen={peek} />
					{/snippet}
					{#snippet placeholder()}
						<div class="px-4"><Skeleton variant="row" lines={1} /></div>
					{/snippet}
				</VirtualList>
			</div>
			{#if loadError}
				<ErrorState
					title="The next items did not load"
					message={loadError}
					onretry={() => {
						loadError = '';
						return reach(wanted);
					}}
				/>
			{/if}
		{/if}
	{/if}
</PageFrame>

<ResponsiveModal open={creating} onclose={() => (creating = false)} title="New item" {busy}>
	<form
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void createItem();
		}}
	>
		<TextField
			label="What is the item called"
			bind:value={newTitle}
			error={newError}
			hint="You can add phases and steps on the item page."
			data-testid="new-item-title"
			required
			minlength={3}
		/>
		<div class="flex justify-end gap-2">
			<Button onclick={() => (creating = false)} disabled={busy}>Cancel</Button>
			<Button type="submit" variant="primary" loading={busy} data-testid="new-item-submit"
				>Create item</Button
			>
		</div>
	</form>
</ResponsiveModal>

<ResponsiveModal
	open={peeked !== null}
	onclose={() => go({ item: null })}
	title={shown?.ref ?? 'Item'}
	variant="drawer"
>
	{#if shown}
		<div class="flex flex-col gap-6" data-testid="item-peek">
			<div class="flex items-start gap-4">
				<ProgressRing value={shown.percent} label={`${shown.ref} progress`} size={48} />
				<div class="min-w-0">
					<h3 class="text-lg font-semibold">{shown.title}</h3>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<Badge tone={STATUS_TONE[shown.status]} dot>{shown.status.toLowerCase()}</Badge>
						{#each runningOf(shown.id) as r (r.sessionId)}
							<RunningBadge tool={r.tool} title={r.title} phase={r.phase ?? undefined} />
						{/each}
					</div>
				</div>
			</div>
			<dl class="grid grid-cols-2 gap-4 text-sm">
				<div>
					<dt class="text-xs text-muted">Steps</dt>
					<dd class="font-medium tabular-nums">{shown.doneSteps} of {shown.totalSteps} done</dd>
				</div>
				<div>
					<dt class="text-xs text-muted">Manual checks open</dt>
					<dd class="font-medium tabular-nums">{shown.openManual}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted">Area</dt>
					<dd class="font-medium">{shown.stream} / {shown.scope}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted">Last activity</dt>
					<dd class="font-medium">{ago(shown.lastActivityAt)}</dd>
				</div>
			</dl>
			<div>
				<Button variant="primary" href={itemHref(shown.ref)} data-testid="peek-open"
					>Open the item</Button
				>
			</div>
		</div>
	{/if}
</ResponsiveModal>
