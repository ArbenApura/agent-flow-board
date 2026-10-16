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
	import { STATUSES, STATUS_TONE, VIEWS, type View } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import VirtualList from '#lib/ui/VirtualList.svelte';
	// -- DEP-COMPONENTS -- //
	import Plus from 'phosphor-svelte/lib/Plus';

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
	function go(change: Record<string, string | null>) {
		const u = new URL(page.url.href);
		for (const [k, v] of Object.entries(change)) {
			if (v === null || v === '') u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		void goto(u, { reset: false, replace: true });
	}

	const typed = () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => go({ q: q.trim() || null }), 250);
	};

	function toggleStatus(s: string) {
		const now = data.filters.status as string[];
		const next = now.includes(s) ? now.filter((x) => x !== s) : [...now, s];
		go({ status: next.join(',') || null });
	}

	const itemHref = (ref: string) => `${base}/${ref}`;
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

	// -- EFFECTS -- //

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

<div class="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-6 max-sm:px-3.5">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8" data-testid="page-title">
				{summary?.project.name}
			</h1>
			<p class="text-sm leading-[22px] text-muted">
				<span class="font-mono">{key}</span>, {summary?.total ?? 0}
				{summary?.total === 1 ? 'item' : 'items'}
			</p>
		</div>
		{#if canWrite}
			<Button variant="primary" onclick={() => (creating = true)} data-testid="new-item">
				<Plus size={16} /> New item
			</Button>
		{/if}
	</div>

	{#if running.length}
		<section
			class="flex flex-wrap items-center gap-2"
			aria-label="Running now"
			data-testid="running-now"
		>
			<span class="text-xs font-semibold tracking-wide text-muted uppercase">Running now</span>
			{#each running as r (r.sessionId)}
				<a href={itemHref(r.itemRef)}>
					<RunningBadge tool={r.tool} title={r.title} phase={r.phase ?? undefined} />
				</a>
			{/each}
		</section>
	{/if}

	<div class="flex flex-wrap items-center gap-3">
		<SegmentedControl
			label="View"
			value={data.view}
			options={VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
			onchange={(v) => go({ view: v === 'board' ? null : v })}
		/>
		<div class="min-w-48 flex-1 sm:max-w-80">
			<TextField
				label="Filter by title or reference"
				type="search"
				bind:value={q}
				oninput={typed}
				data-testid="filter-q"
			/>
		</div>
	</div>
	<div class="flex flex-wrap gap-1.5" role="group" aria-label="Status filter">
		{#each STATUSES as s (s)}
			<button
				type="button"
				role="checkbox"
				aria-checked={data.filters.status.includes(s)}
				onclick={() => toggleStatus(s)}
				class="min-h-9 cursor-pointer rounded-full border border-line bg-surface px-3 text-xs font-medium text-muted hover:bg-raised aria-checked:border-accent aria-checked:bg-accent-soft aria-checked:text-accent-text max-sm:min-h-11"
			>
				{s.toLowerCase()}
				{#if summary?.byStatus[s]}<span class="tabular-nums">{summary.byStatus[s]}</span>{/if}
			</button>
		{/each}
	</div>

	{#if (summary?.total ?? 0) === 0}
		<EmptyState
			title="No items in this project yet"
			text="Create the first item here, or let a connected tool create it from a plan."
		>
			{#snippet action()}
				{#if canWrite}<Button variant="primary" onclick={() => (creating = true)}>New item</Button
					>{/if}
			{/snippet}
		</EmptyState>
	{:else if data.view === 'board'}
		<div class="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="board-columns">
			{#each data.columns as col (col.status)}
				<section class="flex flex-col gap-2" aria-label={col.status.toLowerCase()}>
					<div
						role="heading"
						aria-level="2"
						class="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase"
					>
						<Badge tone={STATUS_TONE[col.status]}>{col.status.toLowerCase()}</Badge>
						<span class="tabular-nums">{col.total}</span>
					</div>
					{#each col.items as row (row.id)}
						<ItemLine {row} href={itemHref(row.ref)} running={runningOf(row.id)} compact />
					{:else}
						<div class="rounded-lg border border-dashed border-line p-3 text-xs text-muted">
							Nothing {col.status.toLowerCase()}.
						</div>
					{/each}
					{#if col.total > col.items.length}
						<a
							class="min-h-9 text-xs text-accent-text hover:underline"
							href={`${base}?view=list&status=${encodeURIComponent(col.status)}`}
							>Show all {col.total}</a
						>
					{/if}
				</section>
			{/each}
		</div>
	{:else if data.view === 'areas'}
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="area-groups">
			{#each data.areas as a (a.stream + '/' + a.scope)}
				<section class="flex flex-col gap-2" aria-label={`${a.stream} ${a.scope}`}>
					<h2
						class="flex items-center justify-between text-base leading-6 font-semibold sm:text-lg sm:leading-[26px]"
					>
						<span>{a.stream} <span class="text-muted">/</span> {a.scope}</span>
						<a
							class="text-xs font-normal text-accent-text hover:underline"
							href={`${base}?view=list&stream=${encodeURIComponent(a.stream)}&scope=${encodeURIComponent(a.scope)}`}
							>{a.total} items</a
						>
					</h2>
					{#each a.items as row (row.id)}
						<ItemLine {row} href={itemHref(row.ref)} running={runningOf(row.id)} compact />
					{/each}
				</section>
			{:else}
				<p class="text-sm text-muted">No items match this filter.</p>
			{/each}
		</div>
	{:else if data.list}
		{#if data.list.total === 0}
			<EmptyState title="No items match" text="Try a different word or clear the status filter." />
		{:else}
			<div class="text-xs text-muted" data-testid="list-count">
				{data.list.total.toLocaleString('en')} items
			</div>
			<div class="overflow-hidden rounded-xl border border-line bg-surface">
				<VirtualList
					items={listItems}
					total={data.list.total}
					rowHeight={narrow ? 56 : 48}
					keyOf={(r) => r.id}
					label={`${data.list.total.toLocaleString('en')} items`}
					class="h-[70dvh]"
					onreach={reach}
				>
					{#snippet row(r)}
						<ItemLine row={r} href={itemHref(r.ref)} running={runningOf(r.id)} />
					{/snippet}
					{#snippet placeholder()}
						<div class="px-4 py-3"><Skeleton lines={2} /></div>
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
</div>

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
