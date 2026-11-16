<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { listTrash } from '#lib/server/ops/history.js';
	// IMPORTED ENVS
	import { invalidate } from '$app/navigation';
	// IMPORTED MODULES
	import { ApiError, api } from '#lib/board/api.js';
	import { cn } from '#lib/ui/cn.js';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import Select from '#lib/ui/Select.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ArrowDownUp from '@lucide/svelte/icons/arrow-up-down';
	import ClipboardList from '@lucide/svelte/icons/clipboard-list';
	import Clock from '@lucide/svelte/icons/clock';
	import FileIcon from '@lucide/svelte/icons/paperclip';
	import LayoutPanel from '@lucide/svelte/icons/panels-top-left';
	import NotebookText from '@lucide/svelte/icons/notebook-text';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Search from '@lucide/svelte/icons/search';
	import SquareCheck from '@lucide/svelte/icons/square-check-big';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	// -- REQUIRED PROPS -- //

	let {
		org,
		projectKey,
		trash,
		denied
	}: {
		org: string;
		projectKey: string;
		trash: Awaited<ReturnType<typeof listTrash>> | null;
		denied: { needed: string; role: string } | null;
	} = $props();

	// -- CONSTANTS -- //

	/** The same thirty days the server keeps a removed thing for. */
	const TRASH_DAYS = 30;
	const RING = 100.53;

	type Kind = 'item' | 'task' | 'mock' | 'note' | 'file';
	type Row = {
		key: string;
		kind: Kind;
		ref: string | null;
		title: string;
		daysLeft: number;
		restore: () => Promise<void>;
	};

	const KINDS: { k: 'all' | Kind; label: string; icon: typeof Trash2 }[] = [
		{ k: 'all', label: 'All', icon: Trash2 },
		{ k: 'item', label: 'Items', icon: ClipboardList },
		{ k: 'task', label: 'Tasks', icon: SquareCheck },
		{ k: 'mock', label: 'Mockups', icon: LayoutPanel },
		{ k: 'note', label: 'Notes', icon: NotebookText },
		{ k: 'file', label: 'Files', icon: FileIcon }
	];

	// -- STATES -- //

	let kind = $state<'all' | Kind>('all');
	let query = $state('');
	let sort = $state<'removed' | 'expiring'>('removed');
	/** How many removed things show first, and how many more each Show more adds. */
	const PAGE = 9;
	let limit = $state(8);
	let picked = $state<Record<string, boolean>>({});
	let busy = $state(false);

	// -- REACTIVE STATES -- //

	// One list for every kind of removed thing, so the tiles, the search and the sort work on the same rows
	const rows = $derived.by<Row[]>(() => {
		if (!trash) return [];
		const restoreApi = (path: string, loading: string, ok: string, failed: string) => async () => {
			try {
				await toast.promise(api(org, path, { method: 'POST', body: {} }), {
					loading,
					success: ok,
					error: (e) => (e instanceof ApiError ? e.message : failed)
				});
			} catch {
				// The promise toast already shows the failure
				throw new Error('not restored');
			}
		};
		return [
			...trash.items.map<Row>((i) => ({
				key: `item:${i.ref}`,
				kind: 'item',
				ref: i.ref,
				title: i.title,
				daysLeft: i.daysLeft,
				restore: restoreApi(
					`/items/${i.ref}/restore`,
					`Restoring ${i.ref}...`,
					`${i.ref} is back.`,
					'The item was not restored.'
				)
			})),
			...trash.tasks.map<Row>((t) => ({
				key: `task:${t.id}`,
				kind: 'task',
				ref: `T-${t.number}`,
				title: t.title,
				daysLeft: t.daysLeft,
				restore: restoreApi(
					`/tasks/${t.id}/restore`,
					`Restoring T-${t.number}...`,
					`T-${t.number} is back.`,
					'The task was not restored.'
				)
			})),
			...trash.mockups.map<Row>((m) => ({
				key: `mock:${m.id}`,
				kind: 'mock',
				ref: null,
				title: m.title,
				daysLeft: m.daysLeft,
				restore: restoreApi(
					`/mockups/${m.id}/restore-from-trash`,
					`Restoring ${m.title}...`,
					`${m.title} is back. Its public link stays off.`,
					'The mockup was not restored.'
				)
			})),
			...trash.notes.map<Row>((n) => ({
				key: `note:${n.id}`,
				kind: 'note',
				ref: n.ref,
				title: n.title,
				daysLeft: n.daysLeft,
				restore: restoreApi(
					`/projects/${projectKey}/notes/${n.ref}/restore`,
					`Restoring ${n.title}...`,
					`${n.title} is back.`,
					'The note was not restored.'
				)
			})),
			...trash.noteFolders.map<Row>((f) => ({
				key: `folder:${f.id}`,
				kind: 'note',
				ref: null,
				title: `${f.name} (folder)`,
				daysLeft: f.daysLeft,
				restore: restoreApi(
					`/projects/${projectKey}/note-folders/${f.id}/restore`,
					`Restoring ${f.name}...`,
					`${f.name} is back with its notes.`,
					'The folder was not restored.'
				)
			})),
			...trash.attachments.map<Row>((a) => ({
				key: `file:${a.id}`,
				kind: 'file',
				ref: null,
				title: a.filename,
				daysLeft: a.daysLeft,
				restore: restoreApi(
					`/attachments/${a.id}/restore`,
					`Restoring ${a.filename}...`,
					`${a.filename} is back.`,
					'The file was not restored.'
				)
			}))
		];
	});

	const counts = $derived(
		Object.fromEntries(
			KINDS.map((x) => [
				x.k,
				x.k === 'all' ? rows.length : rows.filter((r) => r.kind === x.k).length
			])
		)
	);
	const expiring = $derived(rows.filter((r) => r.daysLeft <= 5).length);
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = rows.filter(
			(r) =>
				(kind === 'all' || r.kind === kind) &&
				(!q || r.title.toLowerCase().includes(q) || (r.ref ?? '').toLowerCase().includes(q))
		);
		return sort === 'expiring'
			? [...list].sort((a, b) => a.daysLeft - b.daysLeft)
			: [...list].sort((a, b) => b.daysLeft - a.daysLeft);
	});
	const visible = $derived(shown.slice(0, limit));
	const chosen = $derived(shown.filter((r) => picked[r.key]));
	const allShown = $derived(shown.length > 0 && chosen.length === shown.length);
	const empty = $derived(rows.length === 0);

	// -- FUNCTIONS -- //

	/** The tone of the days left ring: the warning token at five days or fewer, the danger token at two or fewer. */
	const tone = (days: number) =>
		days <= 2 ? 'text-danger' : days <= 5 ? 'text-warning' : 'text-info';
	const stroke = (days: number) =>
		days <= 2 ? 'var(--danger)' : days <= 5 ? 'var(--warning)' : 'var(--info)';
	const removedAgo = (days: number) => {
		const n = Math.max(0, TRASH_DAYS - days);
		return n === 0 ? 'Removed today' : `Removed ${n} ${n === 1 ? 'day' : 'days'} ago`;
	};

	function togglePick(key: string) {
		picked = { ...picked, [key]: !picked[key] };
	}

	function togglePickAll() {
		const next = { ...picked };
		for (const r of shown) next[r.key] = !allShown;
		picked = next;
	}

	async function restoreOne(r: Row) {
		try {
			await r.restore();
		} catch {
			return;
		}
		picked = { ...picked, [r.key]: false };
		await invalidate('afb:project');
	}

	async function restoreChosen() {
		if (!chosen.length || busy) return;
		busy = true;
		let done = 0;
		for (const r of chosen) {
			try {
				await r.restore();
				done += 1;
			} catch {
				// Each failure already shows its own toast; the rest carry on
			}
		}
		busy = false;
		picked = {};
		if (done) await invalidate('afb:project');
	}
</script>

<!-- THE TRASH SECTION: WHAT WAS REMOVED, WHAT LEAVES SOON, AND RESTORE. THE PERMISSION PANEL STAYS FOR A VIEWER -->
{#if denied}
	<PermissionDenied needed={denied.needed} current={denied.role} what="the trash" />
{:else if empty}
	<div
		class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
		data-testid="trash-empty"
	>
		<EmptyState
			kind="trash"
			title="The trash is empty"
			text="Items and files you remove stay here for 30 days, so you can bring them back."
		>
			{#snippet action()}
				<Button href={`/${org}/${projectKey}`}>Go to the registry</Button>
			{/snippet}
		</EmptyState>
	</div>
{:else}
	<div class="flex flex-col gap-3" data-testid="trash-list-wrap">
		<!-- KIND TILES: THEY ARE ALSO THE FILTER -->
		<div
			role="group"
			aria-label="What is in the trash"
			class="-mx-1 flex min-w-0 [scrollbar-width:none]! gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain px-1 py-1.5 xl:overflow-visible [&::-webkit-scrollbar]:hidden"
			data-testid="trash-kinds"
		>
			{#each KINDS as x (x.k)}
				{@const on = kind === x.k}
				<button
					type="button"
					aria-pressed={on}
					onclick={() => (kind = x.k)}
					class={cn(
						'flex min-h-[68px] min-w-[124px] shrink-0 cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-2.5 text-left shadow-[var(--elev-1)] transition-[border-color,background-color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:min-h-14 xl:min-w-0 xl:flex-1',
						on
							? 'border-accent bg-accent-soft ring-4 ring-accent-soft'
							: 'border-line bg-surface hover:bg-raised/60'
					)}
				>
					<span
						class={cn(
							'inline-flex size-9 shrink-0 items-center justify-center rounded-lg border',
							on ? 'border-accent/35 bg-accent text-accent-ink' : 'border-line bg-raised text-muted'
						)}
						aria-hidden="true"><x.icon size={18} /></span
					>
					<span class="flex min-w-0 flex-col leading-tight">
						<span
							class={cn(
								'text-xl font-semibold tracking-tight tabular-nums',
								on ? 'text-accent-text' : 'text-ink'
							)}>{counts[x.k]}</span
						>
						<span class={cn('truncate text-xs', on ? 'text-accent-text' : 'text-muted')}
							>{x.label}</span
						>
					</span>
				</button>
			{/each}
		</div>

		{#if expiring > 0}
			<div
				class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
				role="status"
				data-testid="trash-expiring"
			>
				<Clock size={16} class="shrink-0" />
				<span class="min-w-0 flex-1 basis-56"
					><strong class="font-semibold">{expiring} {expiring === 1 ? 'thing' : 'things'}</strong>
					{expiring === 1 ? 'leaves' : 'leave'}
					the trash within 5 days.</span
				>
				<button
					type="button"
					class="cursor-pointer font-medium underline-offset-2 hover:underline max-sm:flex max-sm:min-h-11 max-sm:items-center"
					onclick={() => (sort = 'expiring')}>Show them first</button
				>
			</div>
		{/if}

		<div
			class="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:flex-nowrap max-sm:items-stretch"
		>
			<div class="group relative min-w-0 flex-1 sm:basis-64">
				<Search
					size={16}
					aria-hidden="true"
					class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted group-focus-within:text-accent-text"
				/>
				<input
					type="search"
					aria-label="Search the trash"
					placeholder="Search a title or a reference"
					autocomplete="off"
					bind:value={query}
					data-testid="trash-search"
					class="h-10 w-full rounded-lg border border-line bg-surface pr-3 pl-10 text-sm text-ink shadow-[var(--elev-1)] placeholder:text-muted hover:border-muted focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none max-sm:h-11"
				/>
			</div>
			<div data-testid="trash-sort" class="max-sm:w-full">
				<Select
					label="Sort"
					icon={ArrowDownUp}
					options={[
						{ value: 'removed', label: 'Removed newest' },
						{ value: 'expiring', label: 'Leaving soonest' }
					]}
					value={sort}
					onchange={(v) => (sort = v === 'expiring' ? 'expiring' : 'removed')}
					class="sm:w-56"
				/>
			</div>
		</div>

		<div class="flex min-h-11 items-center gap-3 px-3 text-xs text-muted max-sm:px-2">
			<label class="flex min-h-11 cursor-pointer items-center">
				<input
					type="checkbox"
					checked={allShown}
					onchange={togglePickAll}
					aria-label="Select everything shown"
					class="size-5 cursor-pointer rounded-[5px] border-[1.5px] border-muted bg-surface accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
				/>
			</label>
			<span class="tabular-nums" data-shown-count
				>Showing {shown.length} of {rows.length} things, {sort === 'expiring'
					? 'leaving soonest first'
					: 'removed newest first'}</span
			>
		</div>

		{#if shown.length === 0}
			<p class="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
				Nothing in the trash matches that.
			</p>
		{:else}
			<ul class="flex flex-col gap-2" data-testid="trash-items">
				{#each visible as r, i (r.key)}
					{@const on = Boolean(picked[r.key])}
					<!-- THE ROW STAGGER INDEX IS A RUNTIME NUMBER -->
					<li
						style="--i: {i};"
						class={cn(
							'row-in flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-surface px-3 py-2 shadow-[var(--elev-1)] transition-colors max-sm:px-2',
							on ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-raised/40'
						)}
						data-testid="trash-row"
						data-kind={r.kind}
					>
						<input
							type="checkbox"
							checked={on}
							onchange={() => togglePick(r.key)}
							aria-label={`Select ${r.title}`}
							class="size-5 shrink-0 cursor-pointer rounded-[5px] border-[1.5px] border-muted bg-surface accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
						/>
						<span
							class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-muted"
							aria-hidden="true"
						>
							{#if r.kind === 'item'}<ClipboardList
									size={18}
								/>{:else if r.kind === 'task'}<SquareCheck
									size={18}
								/>{:else if r.kind === 'mock'}<LayoutPanel
									size={18}
								/>{:else if r.kind === 'note'}<NotebookText size={18} />{:else}<FileIcon
									size={18}
								/>{/if}
						</span>
						<div class="min-w-0 flex-1 max-xl:basis-[calc(100%-120px)]">
							<p
								class="flex min-w-0 items-center gap-2 text-sm max-xl:flex-col max-xl:items-start max-xl:gap-0.5"
							>
								{#if r.ref}<span
										class="shrink-0 rounded-md border border-line bg-raised px-1.5 py-px font-mono text-xs text-muted"
										>{r.ref}</span
									>{/if}
								<span
									class="truncate font-medium text-ink max-xl:max-w-full max-xl:[overflow-wrap:anywhere] max-xl:whitespace-normal"
									>{r.title}</span
								>
							</p>
							<p class="mt-0.5 truncate text-xs text-muted">{removedAgo(r.daysLeft)}</p>
						</div>
						<div class="flex items-center gap-3 max-xl:w-full max-xl:justify-between max-xl:pb-1">
							<span class="flex items-center gap-2">
								<span
									role="img"
									aria-label={`${r.daysLeft} ${r.daysLeft === 1 ? 'day' : 'days'} left`}
									class="relative inline-flex size-9 shrink-0 items-center justify-center"
								>
									<svg
										width="36"
										height="36"
										viewBox="0 0 36 36"
										class="-rotate-90"
										aria-hidden="true"
									>
										<circle
											cx="18"
											cy="18"
											r="16"
											fill="none"
											stroke="var(--raised)"
											stroke-width="4"
										/>
										<circle
											cx="18"
											cy="18"
											r="16"
											fill="none"
											stroke={stroke(r.daysLeft)}
											stroke-width="4"
											stroke-linecap="round"
											stroke-dasharray={RING}
											stroke-dashoffset={RING * (1 - Math.min(TRASH_DAYS, r.daysLeft) / TRASH_DAYS)}
											class="ring-draw"
										/>
									</svg>
									<span
										class={cn(
											'absolute text-[11px] leading-none font-semibold tabular-nums',
											tone(r.daysLeft),
											'text-ink'
										)}
										aria-hidden="true">{r.daysLeft}</span
									>
								</span>
								<span
									class={cn(
										'text-xs whitespace-nowrap tabular-nums',
										r.daysLeft <= 5 ? tone(r.daysLeft) : 'text-muted'
									)}>{r.daysLeft === 1 ? 'day left' : 'days left'}</span
								>
							</span>
							<Button size="sm" onclick={() => restoreOne(r)} data-testid="restore">
								<RotateCcw size={14} /> Restore
							</Button>
						</div>
					</li>
				{/each}
			</ul>
			<!-- THE FOOT: SHOW MORE AND HOW MANY ARE SHOWN -->
			<div class="flex flex-col items-center gap-2 pt-1">
				{#if visible.length < shown.length}
					<Button variant="secondary" onclick={() => (limit += PAGE)} data-testid="trash-more">
						Show {Math.min(PAGE, shown.length - visible.length)} more
					</Button>
				{/if}
				<p class="text-xs text-muted tabular-nums">Showing {visible.length} of {shown.length}</p>
			</div>
		{/if}

		{#if chosen.length}
			<div
				class="enter sticky bottom-4 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 shadow-[var(--elev-2)] max-sm:px-3"
				role="region"
				aria-label="Selected things"
				data-testid="bulk-bar"
			>
				<p class="min-w-0 flex-1 basis-40 text-sm">
					<span class="font-semibold text-ink tabular-nums">{chosen.length}</span>
					<span class="text-ink">selected</span><span class="text-muted"> of {rows.length}</span>
				</p>
				<div class="flex items-center gap-2 max-sm:w-full">
					<Button variant="ghost" onclick={() => (picked = {})} class="max-sm:flex-1">Clear</Button>
					<Button
						variant="primary"
						onclick={restoreChosen}
						loading={busy}
						data-testid="restore-selected"
						class="max-sm:flex-1">Restore {chosen.length}</Button
					>
				</div>
			</div>
		{/if}
	</div>
{/if}
