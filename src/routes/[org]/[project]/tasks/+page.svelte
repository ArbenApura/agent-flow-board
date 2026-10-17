<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- TYPES -- //
	import type { TaskForm, TaskRow } from '#lib/board/tasks.js';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- ENVS -- //
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { createOptimistic } from '#lib/board/optimistic.svelte.js';
	import { parseMode, parseTool } from '#lib/shared/continue.js';
	import {
		NO_PRIORITY,
		TASK_STATES,
		TASK_STATUS_STYLE,
		TASK_VIEWS,
		TASK_VIEW_LABEL,
		asTaskState,
		capColumn,
		diffTask,
		filterTasks,
		formOf,
		groupByName,
		groupByStatus,
		isTaskState,
		parseTaskView,
		priorityKey,
		priorityOptions
	} from '#lib/board/tasks.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Funnel from '@lucide/svelte/icons/funnel';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Trash from '@lucide/svelte/icons/trash';
	// -- COMPONENTS -- //
	import Avatar from '#lib/ui/Avatar.svelte';
	import BoardColumn from '#lib/board/BoardColumn.svelte';
	import ContinueDialog from '#lib/board/ContinueDialog.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import StaleWriteDialog from '#lib/ui/StaleWriteDialog.svelte';
	import TaskCard from '#lib/board/TaskCard.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const STATUS_OPTIONS = TASK_STATES.map((s) => ({
		value: s,
		label: s.charAt(0) + s.slice(1).toLowerCase()
	}));
	const opt = createOptimistic();
	/** The Select needs a value for no one, and a person id is never this. */
	const NOBODY = 'none';
	const BODY_MAX = 20_000;

	// -- STATES -- //

	// The search box shows the filter the address holds, so a shared or reloaded link does not look unfiltered
	let q = $state(untrack(() => page.url.searchParams.get('q') ?? ''));
	/** The New task dialog: the person writes the request and their tool records the tasks. */
	let adding = $state(false);
	let filtersOpen = $state(false);
	/** The drawer keeps the last task it showed, so it never goes blank while it slides out. */
	let snapshot = $state<TaskRow | null>(null);
	let editing = $state(false);
	let saving = $state(false);
	let deleting = $state(false);
	let editError = $state('');
	/** The task as it was when Edit opened, with its version. A save is compared with this, never with live data. */
	let baseline = $state<{ version: number; form: TaskForm } | null>(null);
	let form = $state<TaskForm>({ title: '', body: '', groupName: '', priority: '', assigneeId: '' });
	/** When another person saved a newer version, the time they did, shown by the stale dialog. */
	let stale = $state<string | null>(null);
	/** The finished columns the person opened past their first cards. */
	let opened = $state<Record<string, boolean>>({});
	/** The board is a carousel: it moves one column at a time, and the arrows know when an end is reached. */
	let track = $state<HTMLElement>();
	let atStart = $state(true);
	let atEnd = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const canWrite = $derived(data.summary?.caps.includes('write') ?? false);
	const view = $derived(parseTaskView(page.url.searchParams.get('view')));
	const statusFilter = $derived(
		(page.url.searchParams.get('status') ?? '').split(',').filter(isTaskState)
	);
	const priorityFilter = $derived(
		(page.url.searchParams.get('priority') ?? '').split(',').filter(Boolean)
	);
	const qParam = $derived(page.url.searchParams.get('q') ?? '');
	/** The open task lives in the address, so a task can be shared by its link. */
	const openId = $derived(page.url.searchParams.get('task'));
	/** Every task with the status the person last asked for, so the board, the drawer and the list agree. */
	const rows = $derived<TaskRow[]>(
		data.tasks.map((t) => ({ ...t, status: opt.stateOf(t.id, t.status) }))
	);
	const shown = $derived(
		filterTasks(rows, { q: qParam, status: statusFilter, priority: priorityFilter })
	);
	const byStatus = $derived(groupByStatus(shown));
	const totals = $derived(groupByStatus(rows));
	const columns = $derived(
		statusFilter.length ? TASK_STATES.filter((s) => statusFilter.includes(s)) : TASK_STATES
	);
	const priorities = $derived(priorityOptions(rows));
	const filtering = $derived(
		!!qParam.trim() || statusFilter.length > 0 || priorityFilter.length > 0
	);
	const activeFilters = $derived(statusFilter.length + priorityFilter.length);
	/** The drawer reads the unfiltered rows, so a filter never closes it. */
	const current = $derived(rows.find((t) => t.id === openId) ?? null);
	const shownTask = $derived(current ?? snapshot);
	/** The full description arrives for the open task only, a moment after the drawer opens. */
	const fullBody = $derived(data.openTask && data.openTask.id === openId ? data.openTask : null);
	const changes = $derived(baseline ? diffTask(baseline.form, form) : {});
	const dirty = $derived(Object.keys(changes).length > 0);
	const assigneeOptions = $derived([
		{ value: NOBODY, label: 'Nobody' },
		...Object.entries(data.people).map(([value, label]) => ({ value, label }))
	]);

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

	function toggle(param: 'status' | 'priority', now: string[], value: string) {
		const next = now.includes(value) ? now.filter((x) => x !== value) : [...now, value];
		go({ [param]: next.join(',') || null });
	}

	function clearFilters() {
		q = '';
		go({ q: null, status: null, priority: null });
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

	const hrefFor = (ref: string) => `${base}/${ref}`;
	const nameOf = (id: string | null) => (id ? data.people[id] : undefined);

	/** Shows the new status at once. Only the newest ask for a task may clear or undo it, so a quick second drag never flickers. */
	async function setStatus(id: string, status: string) {
		const row = rows.find((t) => t.id === id);
		if (!row || row.status === status) return;
		const token = opt.start(id, status);
		try {
			await toast.promise(
				api(org, `/tasks/${id}`, { method: 'PATCH', body: { status }, key: newKey() }),
				{
					loading: 'Updating the task...',
					success: 'Task updated.',
					error: (e) => (e instanceof ApiError ? e.message : 'The task was not changed.')
				}
			);
			opt.settle(id, token);
		} catch {
			// The promise toast already shows the failure
			opt.fail(id, token);
			return;
		}
		await invalidate('afb:project');
	}

	const openTask = (id: string) => go({ task: id });

	/** Closing a drawer with unsaved edits asks first. */
	async function closeTask() {
		if (editing && dirty) {
			const ok = await askConfirm({
				title: 'Discard your changes?',
				body: 'The task was not saved. Closing it now throws your edits away.',
				confirmLabel: 'Discard',
				tone: 'danger'
			});
			if (!ok) return;
		}
		go({ task: null });
	}

	function startEdit() {
		if (!current || !fullBody) return;
		const f = formOf({ ...current, body: fullBody.body });
		baseline = { version: current.version, form: f };
		form = { ...f };
		editError = '';
		editing = true;
	}

	async function cancelEdit() {
		if (dirty) {
			const ok = await askConfirm({
				title: 'Discard your changes?',
				body: 'The task was not saved. Cancelling now throws your edits away.',
				confirmLabel: 'Discard',
				tone: 'danger'
			});
			if (!ok) return;
		}
		editing = false;
		baseline = null;
	}

	async function save() {
		if (!baseline || !current || saving || !dirty || form.title.trim().length < 3) return;
		saving = true;
		editError = '';
		try {
			await api(org, `/tasks/${current.id}`, {
				method: 'PATCH',
				// Only what changed, with the version the form started from
				body: { ...changes, expectVersion: baseline.version },
				key: newKey()
			});
			toast.success('Task saved.');
			editing = false;
			baseline = null;
			await invalidate('afb:project');
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION')
				stale = String((e.details as { changedAt?: string } | undefined)?.changedAt ?? '');
			else editError = e instanceof ApiError ? e.message : 'The task was not saved.';
		} finally {
			saving = false;
		}
	}

	async function removeTask() {
		const t = current;
		if (!t || deleting) return;
		const ok = await askConfirm({
			title: `Delete T-${t.number}?`,
			body: `${t.title} moves to the trash for 30 days. You can bring it back with Undo or from the trash.`,
			confirmLabel: 'Delete task',
			tone: 'danger'
		});
		if (!ok) return;
		deleting = true;
		// Undo outlives this page, so it keeps the organisation and the task it was made for
		const o = org;
		const id = t.id;
		const number = t.number;
		try {
			await toast.promise(
				api(o, `/tasks/${id}?expectVersion=${t.version}`, { method: 'DELETE', key: newKey() }),
				{
					loading: 'Deleting the task...',
					success: `T-${number} is in the trash for 30 days.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The task was not deleted.'),
					action: {
						label: 'Undo',
						run: async () => {
							try {
								await toast.promise(
									api(o, `/tasks/${id}/restore`, { method: 'POST', body: {}, key: newKey() }),
									{ loading: 'Restoring...', success: 'Restored.', error: 'It was not restored.' }
								);
								await invalidate('afb:project');
							} catch {
								// The promise toast already shows the failure
							}
						}
					}
				}
			);
			go({ task: null });
			await invalidate('afb:project');
		} catch (e) {
			// The promise toast already shows the failure. A stale version means the page is old, so it is refreshed and a
			// second try sends the new version.
			if (e instanceof ApiError && e.code === 'STALE_VERSION') await invalidate('afb:project');
		} finally {
			deleting = false;
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// New server data drops the held values it now shows
	$effect(() => {
		opt.confirm(Object.fromEntries(data.tasks.map((t) => [t.id, t.status])));
	});

	// The drawer remembers the last task it showed
	$effect(() => {
		if (current) snapshot = current;
	});

	// Another task, or none, ends Edit mode. The tracker keeps the effect from running on its own writes.
	let prevOpen: string | null = null;
	$effect(() => {
		const id = openId;
		if (id === prevOpen) return;
		prevOpen = id;
		untrack(() => {
			editing = false;
			baseline = null;
			editError = '';
		});
	});

	// A search typed just before leaving the page must not rewrite the next page's address
	$effect(() => () => clearTimeout(searchTimer));

	// The arrows follow the board's width and its columns, so they show only when the columns do not all fit
	$effect(() => {
		void columns;
		void view;
		const el = track;
		if (!el) return;
		measure();
		const watch = new ResizeObserver(measure);
		watch.observe(el);
		return () => watch.disconnect();
	});
</script>

<svelte:head><title>Tasks, {data.summary?.project.name ?? ''}</title></svelte:head>

{#snippet card(t: TaskRow, drag: boolean, withStatus: boolean)}
	<TaskCard
		task={t}
		refs={data.refs}
		assignee={nameOf(t.assigneeId)}
		{hrefFor}
		onopen={openTask}
		dragEnabled={drag && canWrite}
		showStatus={withStatus}
	/>
{/snippet}

{#snippet checkRow(label: string, on: boolean, n: number, dot: string | null, onclick: () => void)}
	<button
		type="button"
		role="checkbox"
		aria-checked={on}
		{onclick}
		class="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
	>
		<span
			class="inline-flex size-4 items-center justify-center rounded border border-line"
			aria-hidden="true"
		>
			{#if on}<Check size={12} strokeWidth={3} class="text-accent" />{/if}
		</span>
		{#if dot}<span class={cn('size-2 rounded-full', dot)} aria-hidden="true"></span>{/if}
		<span class="flex-1 text-left">{label}</span>
		<span class="text-xs text-muted tabular-nums">{n}</span>
	</button>
{/snippet}

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title="Tasks"
		context={`${data.tasks.length} ${data.tasks.length === 1 ? 'task' : 'tasks'}, small jobs outside any plan.`}
	>
		{#snippet actions()}
			{#if canWrite}
				<Button variant="primary" onclick={() => (adding = true)} data-testid="new-task">
					<Plus size={16} /> New task
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.tasks.length === 0}
		<EmptyState
			kind="tasks"
			title="No tasks yet"
			text="Tasks are small jobs outside any plan. Press New task and your tool writes it."
		/>
	{:else}
		<!-- ONE TOOLBAR CARD. THE SEARCH AND THE FILTERS, WITH THE VIEW SWITCH ON THE RIGHT, AS ON THE PROJECT BOARD -->
		<div class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
			<div class="min-w-56 flex-1 sm:max-w-80">
				<TextField
					label="Search tasks"
					icon={Search}
					hideLabel
					placeholder="Search tasks, notes and groups"
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
					{#each TASK_STATES as s (s)}
						{@render checkRow(
							s.charAt(0) + s.slice(1).toLowerCase(),
							statusFilter.includes(s),
							totals[s].length,
							TASK_STATUS_STYLE[s].dot,
							() => toggle('status', statusFilter, s)
						)}
					{/each}
					{#if priorities.length > 1}
						<p class="mt-1 border-t border-line px-2.5 pt-2 pb-1 text-xs font-medium text-muted">
							Only these priorities
						</p>
						{#each priorities as p (p.value)}
							{@render checkRow(p.label, priorityFilter.includes(p.value), p.n, null, () =>
								toggle('priority', priorityFilter, p.value)
							)}
						{/each}
					{/if}
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
					value={view}
					options={TASK_VIEWS.map((v) => ({ value: v, label: TASK_VIEW_LABEL[v] }))}
					onchange={(v) => go({ view: v === 'board' ? null : v })}
				/>
			</span>
		</div>

		{#if shown.length === 0}
			<EmptyState
				kind="search"
				title="No tasks match"
				text="Try a different word, or clear the filters."
			>
				{#snippet action()}
					<Button onclick={clearFilters}>Clear filters</Button>
				{/snippet}
			</EmptyState>
		{:else if view === 'board'}
			<!-- STATUS COLUMNS. DRAGGING A CARD TO ANOTHER COLUMN CHANGES ITS STATUS -->
			<div class="flex items-center justify-between gap-3">
				{#if canWrite}
					<p class="text-xs text-muted">
						Drag a card to another column to change its status. On a phone, open the task.
					</p>
				{/if}
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
				class="grid snap-x snap-mandatory [scrollbar-width:none]! auto-cols-[max(290px,calc((100%-42px)/4))] grid-flow-col items-start gap-3.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-smooth pb-1 max-md:auto-cols-auto max-md:grid-flow-row [&::-webkit-scrollbar]:hidden [&>*]:snap-start"
				data-testid="board-columns"
			>
				{#each columns as s (s)}
					{@const list = byStatus[s]}
					{@const visible = capColumn(list, s, !!opened[s])}
					<BoardColumn
						zone={`status:${s}`}
						title={s}
						count={visible.length}
						total={totals[s].length}
						dot={TASK_STATUS_STYLE[s].dot}
						top={TASK_STATUS_STYLE[s].top}
						empty={`Nothing ${s.toLowerCase()}.`}
						ondrop={canWrite
							? (id) => {
									// A card dropped into a capped column must not vanish past its cap
									opened[s] = true;
									void setStatus(id, s);
								}
							: undefined}
					>
						{#each visible as t (t.id)}
							{@render card(t, true, false)}
						{/each}
						{#if visible.length < list.length}
							<button
								type="button"
								onclick={() => (opened[s] = true)}
								class="min-h-11 cursor-pointer px-1 text-left text-sm text-accent-text hover:underline"
								>Show all {list.length}</button
							>
						{/if}
					</BoardColumn>
				{/each}
			</div>
		{:else if view === 'groups'}
			<!-- TASKS UNDER THEIR GROUP NAME. THE TASKS WITHOUT A GROUP COME LAST -->
			<div class="flex flex-col gap-6" data-testid="task-groups">
				{#each groupByName(shown) as g (g.name ?? '\u0000ungrouped')}
					<section class="flex flex-col gap-3" aria-label={g.name ?? 'Ungrouped'}>
						<h2 class="flex items-center gap-2 text-lg font-semibold text-ink">
							{g.name ?? 'Ungrouped'}
							<span
								class="rounded-full border border-line bg-surface px-2 text-badge font-semibold text-muted tabular-nums"
								>{g.tasks.length}</span
							>
						</h2>
						<div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
							{#each g.tasks as t (t.id)}
								{@render card(t, false, true)}
							{/each}
						</div>
					</section>
				{/each}
			</div>
		{:else}
			<ul
				class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
				data-testid="task-list"
			>
				{#each shown as t (t.id)}
					<li
						class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0"
						data-row
						data-testid="task"
					>
						<span class="w-12 shrink-0 font-mono text-xs text-muted">T-{t.number}</span>
						<button
							type="button"
							onclick={() => openTask(t.id)}
							data-testid="task-open"
							class={cn(
								'min-h-11 min-w-0 flex-1 cursor-pointer text-left text-sm hover:underline focus-visible:outline-2',
								t.status === 'DONE' || t.status === 'DROPPED' ? 'text-muted' : 'text-ink'
							)}><span class="line-clamp-2 [overflow-wrap:anywhere]">{t.title}</span></button
						>
						{#if t.priority?.trim()}
							<span class="rounded-md bg-raised px-1.5 text-badge font-semibold text-ink"
								>{t.priority.trim()}</span
							>
						{/if}
						{#if t.groupName}
							<span class="max-w-40 truncate text-xs text-muted max-md:hidden">{t.groupName}</span>
						{/if}
						{#each t.linkedItemIds.filter((id) => data.refs[id]) as id (id)}
							<a
								class="cursor-pointer font-mono text-xs text-accent-text hover:underline max-md:hidden"
								href={hrefFor(data.refs[id])}>{data.refs[id]}</a
							>
						{/each}
						{#if nameOf(t.assigneeId)}
							<Avatar name={nameOf(t.assigneeId) ?? ''} size={24} />
						{/if}
						<Select
							label={`Status of T-${t.number}`}
							value={asTaskState(t.status)}
							disabled={!canWrite}
							options={STATUS_OPTIONS}
							onchange={(v) => void setStatus(t.id, v)}
							class="w-40"
						/>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</PageFrame>

<ResponsiveModal
	open={openId !== null}
	onclose={() => void closeTask()}
	title={shownTask ? `T-${shownTask.number} ${shownTask.title}` : 'Task'}
	variant="drawer"
	size="lg"
	busy={saving || deleting}
>
	{#if openId !== null && !current}
		<!-- THE TASK WAS DELETED, OR MOVED OUT OF REACH, WHILE THE DRAWER WAS OPEN -->
		<p class="rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink">
			This task was deleted or you can no longer see it. Close this and pick another task.
		</p>
	{:else if shownTask}
		{@const t = shownTask}
		<div class="flex flex-col gap-4" data-testid="task-drawer">
			<Select
				label="Status"
				value={asTaskState(t.status)}
				disabled={!canWrite || editing}
				options={STATUS_OPTIONS}
				onchange={(v) => void setStatus(t.id, v)}
			/>
			{#if editing}
				<!-- EDIT MODE. THE FORM STARTED FROM THE BASELINE, SO A REFRESH NEVER REWRITES WHAT IS BEING TYPED -->
				<form
					id="task-edit"
					class="flex flex-col gap-4 text-sm"
					onsubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<TextField
						label="What is the task"
						bind:value={form.title}
						minlength={3}
						maxlength={200}
						required
						data-testid="edit-task-title"
					/>
					<TextArea
						label="What needs doing"
						bind:value={form.body}
						rows={8}
						maxlength={BODY_MAX}
						hint={`Markdown works, and the formatted text shows after you save. ${form.body.length} of ${BODY_MAX} characters.`}
						data-testid="edit-task-body"
					/>
					<TextField
						label="Which group is it in"
						bind:value={form.groupName}
						maxlength={120}
						placeholder="For example Billing"
					/>
					<TextField
						label="How urgent is it"
						bind:value={form.priority}
						maxlength={20}
						placeholder="For example P1"
					/>
					<Select
						label="Who is working on it"
						value={form.assigneeId || NOBODY}
						options={assigneeOptions}
						onchange={(v) => (form.assigneeId = v === NOBODY ? '' : v)}
					/>
					{#if editError}
						<p role="alert" class="text-xs text-danger">{editError}</p>
					{/if}
				</form>
			{:else}
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					{#if nameOf(t.assigneeId)}
						<dt class="text-muted">Assigned to</dt>
						<dd class="inline-flex items-center gap-2 text-ink">
							<Avatar name={nameOf(t.assigneeId) ?? ''} size={24} />{nameOf(t.assigneeId)}
						</dd>
					{/if}
					{#if t.groupName}
						<dt class="text-muted">Group</dt>
						<dd class="text-ink">{t.groupName}</dd>
					{/if}
					{#if priorityKey(t.priority) !== NO_PRIORITY}
						<dt class="text-muted">Priority</dt>
						<dd class="text-ink">{t.priority}</dd>
					{/if}
					{#if t.linkedItemIds.some((id) => data.refs[id])}
						<dt class="text-muted">Linked items</dt>
						<dd class="flex flex-wrap gap-2">
							{#each t.linkedItemIds.filter((id) => data.refs[id]) as id (id)}
								<a
									class="cursor-pointer font-mono text-xs text-accent-text hover:underline"
									href={hrefFor(data.refs[id])}>{data.refs[id]}</a
								>
							{/each}
						</dd>
					{/if}
				</dl>
				{#if fullBody?.html}
					<!-- THE BODY IS MARKDOWN, SANITISED ON THE SERVER AS UNTRUSTED TEXT -->
					<div
						class="md flex flex-col gap-2 border-t border-line pt-4 text-sm text-ink"
						data-testid="task-body"
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
						{@html fullBody.html}
					</div>
				{:else if !fullBody && t.body}
					<p class="text-sm text-muted">Loading the description...</p>
				{:else}
					<p class="text-sm text-muted">This task has no description.</p>
				{/if}
			{/if}
		</div>
	{/if}
	{#snippet footer()}
		{#if canWrite && shownTask && (current || openId === null)}
			{#if editing}
				<Button onclick={() => void cancelEdit()} disabled={saving}>Cancel</Button>
				<Button
					type="submit"
					form="task-edit"
					variant="primary"
					loading={saving}
					disabled={!dirty || form.title.trim().length < 3}
					data-testid="edit-task-save">Save changes</Button
				>
			{:else}
				<Button
					variant="danger"
					onclick={() => void removeTask()}
					loading={deleting}
					data-testid="task-delete"><Trash size={16} /> Delete</Button
				>
				<Button
					onclick={startEdit}
					disabled={!fullBody || (current ? opt.has(current.id) : false)}
					data-testid="task-edit"><Pencil size={16} /> Edit</Button
				>
			{/if}
		{/if}
	{/snippet}
</ResponsiveModal>

<StaleWriteDialog
	open={stale !== null}
	onclose={() => (stale = null)}
	changedBy="Someone"
	changedAt={stale ? new Date(stale).toLocaleString('en') : ''}
	onreload={async () => {
		stale = null;
		editing = false;
		baseline = null;
		await invalidate('afb:project');
	}}
	oncompare={async () => {
		// The draft stays. It is rebased onto the newer version, so the next save sends only the fields that were changed here.
		stale = null;
		await invalidate('afb:project');
		if (baseline && current) baseline = { ...baseline, version: current.version };
	}}
/>

<!-- NEW TASK: THE SAME HAND-OFF AS RESUME AND ASK, WITH A BOX FOR WHAT NEEDS DOING. THE TOOL RECORDS THE TASKS THROUGH /flow-task -->
<ContinueDialog
	open={adding}
	onclose={() => (adding = false)}
	item={null}
	create={{ kind: 'task', key }}
	tool={parseTool(data.continueTool)}
	mode={parseMode(data.continueMode)}
/>
