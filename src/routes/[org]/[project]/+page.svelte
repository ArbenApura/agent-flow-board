<script lang="ts">
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	import type { ApiItem, ItemRow, Running } from '#lib/board/rows.js';
	// IMPORTED ENVS
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { activityText } from '#lib/board/projects.js';
	import { slimItem } from '#lib/board/rows.js';
	import { parseMode, parseTool } from '#lib/shared/continue.js';
	import BoardColumn from '#lib/board/BoardColumn.svelte';
	import ContinueDialog from '#lib/board/ContinueDialog.svelte';
	import ItemLine from '#lib/board/ItemLine.svelte';
	import {
		BOARD_COLUMNS,
		LIST_COLS,
		STATUS_STYLE,
		VIEWS,
		type Status,
		type View
	} from '#lib/board/status.js';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import VirtualList from '#lib/ui/VirtualList.svelte';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Funnel from '@lucide/svelte/icons/funnel';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';

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
	/** The New plan dialog: the person writes the idea and their tool makes the plan. */
	let newOpen = $state(false);
	/** A phone gets taller rows, the same as the other lists. */
	let narrow = $state(false);
	/** The item the Continue with dialog is open for. */
	let continueRow = $state<ItemRow | null>(null);
	let continueOpen = $state(false);
	let filtersOpen = $state(false);
	/** The board is a carousel: it moves one column at a time, and the arrows know when an end is reached. */
	let track = $state<HTMLElement>();
	let atStart = $state(true);
	let atEnd = $state(false);
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

	function measure() {
		if (!track) return;
		atStart = track.scrollLeft <= 1;
		atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
	}

	/** Moves the board by one column. A card dragged over an arrow moves it too, so a far column can be reached. */
	function step(direction: 1 | -1) {
		const first = track?.firstElementChild as HTMLElement | null;
		if (!track || !first) return;
		track.scrollBy({ left: direction * (first.offsetWidth + 14), behavior: 'smooth' });
	}

	const itemHref = (ref: string) => `${base}/${ref}`;

	const openContinue = (row: ItemRow) => {
		continueRow = row;
		continueOpen = true;
	};
	/** Continue with is for a person who can write, and not on a finished item. */
	const continueFor = (row: ItemRow) =>
		canWrite && row.status !== 'COMPLETED' && row.status !== 'REMOVED' ? openContinue : undefined;
	const runningOf = (id: string) => running.filter((r) => r.itemId === id);

	// The streams of the project with how many items each holds, for the stream chips
	const streams = $derived(
		Object.entries(
			(summary?.areas ?? []).reduce<Record<string, number>>((acc, a) => {
				acc[a.stream] = (acc[a.stream] ?? 0) + a.n;
				return acc;
			}, {})
		)
	);
	const filtering = $derived(
		!!data.filters.q || data.filters.status.length > 0 || !!data.filters.stream
	);

	/** Statuses picked, plus one when a stream is picked. Shown on the button. */
	const activeFilters = $derived(data.filters.status.length + (data.filters.stream ? 1 : 0));
	const toggleStream = (s: string) => go({ stream: data.filters.stream === s ? null : s });
	const clearFilters = () => {
		q = '';
		go({ q: null, status: null, stream: null, scope: null });
	};

	/** A card dropped on another column asks the server to change the status. The server decides if the move is allowed. */
	async function moveTo(ref: string, status: Status) {
		const row = data.columns.flatMap((c) => c.items).find((r) => r.ref === ref);
		if (!row || row.status === status) return;
		try {
			await toast.promise(
				api(org, `/items/${ref}/status`, {
					body: { status, note: 'Moved on the board' },
					key: newKey()
				}),
				{
					id: 'item-move',
					loading: `Moving ${ref}...`,
					success: `${ref} is now ${status.toLowerCase()}.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The item was not moved.')
				}
			);
			await invalidate('afb:project');
		} catch {
			/* The toast already told the person why */
		}
	}

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
					cursor: String(cursor),
					sort: 'activity'
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

	// -- EFFECTS -- //

	// The arrows follow the board's width and its columns, so they show only when the columns do not all fit
	$effect(() => {
		void data.columns;
		const el = track;
		if (!el) return;
		measure();
		const watch = new ResizeObserver(measure);
		watch.observe(el);
		return () => watch.disconnect();
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
			const oldest = fresh[fresh.length - 1].lastActivityAt;
			const freshIds = new Set(fresh.map((r) => r.id));
			listItems = [
				...fresh,
				...held.filter((r) => r.lastActivityAt < oldest && !freshIds.has(r.id))
			];
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
				<Button variant="primary" onclick={() => (newOpen = true)} data-testid="new-item">
					<Plus size={16} /> New plan
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if running.length}
		<section
			class="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3"
			aria-label="Running now"
			data-testid="running-now"
		>
			<!-- HEADING WITH A LIVE DOT AND THE COUNT -->
			<span class="mr-1 inline-flex items-center gap-2 text-sm font-medium text-ink">
				<span class="relative flex size-2">
					<span
						class="absolute inline-flex size-full animate-ping rounded-full bg-[var(--info)] opacity-60 motion-reduce:animate-none"
					></span>
					<span class="relative inline-flex size-2 rounded-full bg-[var(--info)]"></span>
				</span>
				Running now
				<span class="font-mono text-xs text-muted">{running.length}</span>
			</span>
			<!-- ONE CHIP PER SESSION, SO THE REFERENCES AND BADGES NEVER RUN TOGETHER -->
			{#each running as r (r.sessionId)}
				<a
					href={itemHref(r.itemRef)}
					class="inline-flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-line bg-raised px-3 py-1.5 transition-colors hover:border-[var(--muted)] sm:min-h-0"
				>
					<span class="font-mono text-xs text-muted">{r.itemRef}</span>
					<RunningBadge
						tool={r.tool}
						title={r.title}
						phase={r.phase ?? undefined}
						staleMinutes={r.staleMinutes}
						mockupUnread={r.mockupUnread}
						reviewIdle={r.reviewIdle}
						waiting={r.waiting}
						age={`Started ${new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ${activityText(r.lastSeenAt)}.`}
					/>
					<!-- HOW OLD THE CLAIM IS, AS TEXT SO A PHONE CAN READ IT -->
					<span class="text-xs text-muted">{activityText(r.lastSeenAt)}</span>
				</a>
			{/each}
		</section>
	{/if}

	<!-- ONE TOOLBAR CARD. THE SEARCH, THE STATUS CHIPS AND THE STREAM CHIPS, WITH THE VIEW SWITCH ON THE RIGHT (ADR-004) -->
	<div
		class="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5"
	>
		<div class="min-w-56 flex-1 sm:max-w-80">
			<TextField
				label="Filter by title or reference"
				icon={Search}
				hideLabel
				placeholder="Filter by title or reference"
				type="search"
				bind:value={q}
				oninput={typed}
				data-testid="filter-q"
			/>
		</div>
		<!-- ONE FILTERS BUTTON. THE STATUSES AND STREAMS LIVE IN A SMALL LIST, SO THE TOOLBAR STAYS CALM -->
		<Popover bind:open={filtersOpen} placement="bottom-start" role="dialog" label="Filters">
			{#snippet trigger({ props, toggle })}
				<Button variant="secondary" onclick={toggle} data-testid="filters-button" {...props}>
					<Funnel size={16} /> Filters
					{#if activeFilters}
						<span
							data-count
							class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-badge font-semibold text-accent-ink tabular-nums"
							>{activeFilters}</span
						>
					{/if}
				</Button>
			{/snippet}
			<div class="w-64 p-2">
				<p class="px-2.5 pt-1 pb-1 text-xs font-medium text-muted">Show these statuses</p>
				{#each BOARD_COLUMNS as s (s)}
					<button
						type="button"
						role="checkbox"
						aria-checked={data.filters.status.includes(s)}
						onclick={() => toggleStatus(s)}
						class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
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
						<span class={'size-2 rounded-full ' + STATUS_STYLE[s].dot} aria-hidden="true"></span>
						<span class="flex-1 text-left">{s.charAt(0) + s.slice(1).toLowerCase()}</span>
						<span class="text-xs text-muted tabular-nums">{summary?.byStatus[s] ?? 0}</span>
					</button>
				{/each}
				{#if streams.length > 1}
					<p class="mt-1 border-t border-line px-2.5 pt-2 pb-1 text-xs font-medium text-muted">
						Only this stream
					</p>
					{#each streams as [name, n] (name)}
						<button
							type="button"
							role="checkbox"
							aria-checked={data.filters.stream === name}
							onclick={() => toggleStream(name)}
							class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
						>
							<span
								class="inline-flex size-4 items-center justify-center rounded border border-line"
								aria-hidden="true"
							>
								{#if data.filters.stream === name}<Check
										size={12}
										strokeWidth={3}
										class="text-accent"
									/>{/if}
							</span>
							<span class="flex-1 text-left">{name}</span>
							<span class="text-xs text-muted tabular-nums">{n}</span>
						</button>
					{/each}
				{/if}
				{#if filtering}
					<button
						type="button"
						onclick={clearFilters}
						class="mt-1 min-h-10 w-full cursor-pointer rounded-md border-t border-line px-2.5 pt-1 text-left text-sm text-accent-text hover:underline"
						>Clear filters</button
					>
				{/if}
			</div>
		</Popover>
		<span class="ml-auto flex flex-wrap items-center gap-3">
			<SegmentedControl
				label="View"
				value={data.view}
				options={VIEWS.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
				onchange={(v) => go({ view: v === 'board' ? null : v })}
			/>
		</span>
	</div>

	{#if (summary?.total ?? 0) === 0}
		<EmptyState
			kind="welcome"
			title="No items in this project yet"
			text="Start the first plan here and your connected tool writes it."
		>
			{#snippet action()}
				{#if canWrite}<Button variant="primary" onclick={() => (newOpen = true)}>New plan</Button
					>{/if}
			{/snippet}
		</EmptyState>
	{:else if data.view === 'board'}
		<!-- STATUS COLUMNS. DRAGGING A CARD TO ANOTHER COLUMN CHANGES ITS STATUS -->
		<div class="mb-3 flex items-center justify-between gap-3">
			<p class="text-xs text-muted">
				{canWrite ? 'Drag a card to another column to change its status.' : ''}
			</p>
			<!-- CAROUSEL ARROWS. ONLY WHEN THE COLUMNS DO NOT ALL FIT -->
			<div class={atStart && atEnd ? 'hidden' : 'flex gap-1 max-md:hidden'}>
				{#each [-1, 1] as dir (dir)}
					<button
						type="button"
						aria-label={dir === 1 ? 'Show the next column' : 'Show the previous column'}
						disabled={dir === 1 ? atEnd : atStart}
						onclick={() => step(dir === 1 ? 1 : -1)}
						ondragenter={() => step(dir === 1 ? 1 : -1)}
						class="inline-flex size-10 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface text-ink hover:border-muted disabled:cursor-not-allowed disabled:opacity-40"
					>
						{#if dir === 1}<ChevronRight size={20} />{:else}<ChevronLeft size={20} />{/if}
					</button>
				{/each}
			</div>
		</div>
		<!-- THE COLUMNS SNAP ONE AT A TIME. THE SCROLLBAR IS HIDDEN, THE ARROWS AND A SWIPE MOVE IT -->
		<div
			bind:this={track}
			onscroll={measure}
			class="grid snap-x snap-mandatory [scrollbar-width:none]! auto-cols-[max(290px,calc((100%-42px)/4))] grid-flow-col items-start gap-3.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-smooth pb-1 max-md:auto-cols-auto max-md:grid-flow-row min-[1640px]:auto-cols-[calc((100%-56px)/5)] [&::-webkit-scrollbar]:hidden [&>*]:snap-start"
			data-testid="board-columns"
		>
			{#each data.columns as col (col.status)}
				<BoardColumn
					zone={`status:${col.status}`}
					title={col.status}
					count={col.items.length}
					total={col.total}
					dot={STATUS_STYLE[col.status].dot}
					top={STATUS_STYLE[col.status].top}
					empty={`Nothing ${col.status.toLowerCase()}.`}
					ondrop={canWrite ? (ref) => void moveTo(ref, col.status) : undefined}
				>
					{#each col.items as row (row.id)}
						<ItemLine
							{row}
							href={itemHref(row.ref)}
							running={runningOf(row.id)}
							compact
							onContinue={continueFor(row)}
							dragEnabled={canWrite}
						/>
					{/each}
					{#if col.total > col.items.length}
						<a
							class="min-h-9 px-1 text-sm text-accent-text hover:underline"
							href={`${base}?view=list&status=${encodeURIComponent(col.status)}`}
							>Show all {col.total}</a
						>
					{/if}
				</BoardColumn>
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
							onContinue={continueFor(row)}
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
				{data.list.total.toLocaleString('en')}
				{data.list.total === 1 ? 'item' : 'items'}
			</div>
			<div class="overflow-hidden rounded-xl border border-line bg-surface">
				<!-- COLUMN HEADINGS, ON THE SAME WIDTHS AS THE ROWS -->
				<div
					class="flex items-center gap-4 border-b border-line bg-raised px-5 py-2 text-badge font-bold tracking-wider text-muted uppercase max-sm:px-4"
					aria-hidden="true"
				>
					<span class={LIST_COLS.ref}>Item</span>
					<span class="min-w-0 flex-1">Title</span>
					<span class={LIST_COLS.status}>Status</span>
					<span class={LIST_COLS.progress}>Progress</span>
					<span class={LIST_COLS.area}>Area</span>
					<span class={LIST_COLS.updated}>Updated</span>
				</div>
				<!-- THE LIST IS AS TALL AS ITS ROWS UP TO 70% OF THE SCREEN, A RUNTIME HEIGHT -->
				<div style="height:min({data.list.total * (narrow ? 80 : 72)}px, 70dvh);">
					<VirtualList
						items={listItems}
						total={data.list.total}
						rowHeight={narrow ? 80 : 72}
						keyOf={(r) => r.id}
						label={`${data.list.total.toLocaleString('en')} items`}
						class="h-full"
						onreach={reach}
					>
						{#snippet row(r)}
							<ItemLine row={r} href={itemHref(r.ref)} running={runningOf(r.id)} />
						{/snippet}
						{#snippet placeholder()}
							<div class="px-4"><Skeleton variant="row" lines={1} /></div>
						{/snippet}
					</VirtualList>
				</div>
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

<ContinueDialog
	open={continueOpen}
	onclose={() => (continueOpen = false)}
	item={continueRow
		? { ref: continueRow.ref, title: continueRow.title, href: itemHref(continueRow.ref) }
		: null}
	tool={parseTool(data.continueTool)}
	mode={parseMode(data.continueMode)}
/>

<!-- NEW PLAN: THE SAME HAND-OFF AS RESUME AND ASK, WITH AN IDEA BOX. THE TOOL MAKES THE PLAN THROUGH /flow -->
<ContinueDialog
	open={newOpen}
	onclose={() => (newOpen = false)}
	item={null}
	create={{ kind: 'plan', key }}
	tool={parseTool(data.continueTool)}
	mode={parseMode(data.continueMode)}
/>
