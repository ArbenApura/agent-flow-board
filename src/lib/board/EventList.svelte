<script lang="ts">
	// IMPORTED DEP-MODULES
	import { onMount } from 'svelte';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { verbText } from '#lib/board/verbs.js';
	import { cn } from '#lib/ui/cn.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Undo2 from '@lucide/svelte/icons/undo-2';

	// -- TYPES -- //

	type Row = {
		id: number;
		verb: string;
		actorLabel: string | null;
		tool: string | null;
		sessionId?: string | null;
		createdAt: Date | string;
		label: string;
		itemId: string | null;
	};

	/** One line of the list: a single change, or a folded run of changes made by one agent session. */
	type Block =
		| { kind: 'row'; row: Row; day: string }
		| { kind: 'group'; key: string; rows: Row[]; day: string; sessionId: string };

	// -- REQUIRED PROPS -- //

	let {
		events,
		org,
		canUndo,
		refs = {},
		onchanged,
		linkBase,
		onundosession
	}: {
		events: Row[];
		org: string;
		canUndo: boolean;
		/** Item references by item id, so a project wide log can name the item. */
		refs?: Record<string, string>;
		onchanged: () => Promise<void>;
		/** The address an item reference links to, for example /acme/CKT. */
		linkBase?: string;
		/** Undoes everything one agent session changed. Shown on a folded session group when the person may undo. */
		onundosession?: (sessionId: string) => void | Promise<void>;
	} = $props();

	// -- CONSTANTS -- //

	const FILTERS = [
		{ value: 'all', label: 'All' },
		{ value: 'person', label: 'People' },
		{ value: 'agent', label: 'Agents' },
		{ value: 'undoable', label: 'Undoable' }
	];

	// -- STATES -- //

	let confirming = $state<Row | null>(null);
	let busy = $state(false);
	// Day headings depend on the viewer's own clock and time zone, so they are drawn only in the browser and the server markup agrees
	let mounted = $state(false);
	let filter = $state('all');
	let query = $state('');
	// Session groups are open or closed by their own header; the first group opens, the others start folded
	let opened = $state<Record<string, boolean>>({});

	// -- REACTIVE STATES -- //

	const shown = $derived(
		events.filter(
			(e) =>
				(filter === 'all' ||
					(filter === 'person' && !e.tool) ||
					(filter === 'agent' && !!e.tool) ||
					(filter === 'undoable' && e.label === 'undoable')) &&
				(!query.trim() ||
					`${e.actorLabel ?? ''} ${e.tool ?? ''} ${e.verb} ${e.itemId ? (refs[e.itemId] ?? '') : ''}`
						.toLowerCase()
						.includes(query.trim().toLowerCase()))
		)
	);

	const counts = $derived({
		all: events.length,
		person: events.filter((e) => !e.tool).length,
		agent: events.filter((e) => !!e.tool).length,
		undoable: events.filter((e) => e.label === 'undoable').length
	});

	// Consecutive changes of one agent session fold into one group (two or more); everything else is a plain row
	const blocks = $derived.by<Block[]>(() => {
		const out: Block[] = [];
		for (const e of shown) {
			const day = dayOf(e.createdAt);
			const last = out[out.length - 1];
			if (
				e.sessionId &&
				e.tool &&
				last &&
				last.kind === 'row' &&
				last.row.sessionId === e.sessionId &&
				last.row.tool
			) {
				out[out.length - 1] = {
					kind: 'group',
					key: `s${last.row.id}`,
					rows: [last.row, e],
					day: last.day,
					sessionId: e.sessionId
				};
			} else if (
				e.sessionId &&
				e.tool &&
				last &&
				last.kind === 'group' &&
				last.sessionId === e.sessionId
			) {
				last.rows.push(e);
			} else {
				out.push({ kind: 'row', row: e, day });
			}
		}
		return out;
	});

	// -- FUNCTIONS -- //

	const dayOf = (value: Date | string) => new Date(value).toDateString();

	/** Today, Yesterday, or the weekday and date, in the viewer's own time zone. */
	function dayLabel(value: Date | string) {
		const day = new Date(value);
		const today = new Date();
		const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
		if (day.toDateString() === today.toDateString()) return 'Today';
		if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
		return day.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
	}

	const isOpen = (key: string, index: number) => opened[key] ?? index === 0;
	const toggleGroup = (key: string, index: number) =>
		(opened = { ...opened, [key]: !isOpen(key, index) });

	const WHY: Record<string, string> = {
		external: 'That change came from outside and cannot be undone here.',
		'already-undone': 'That change was already undone.',
		'not-found': 'That change no longer exists.',
		unsupported: 'That kind of change cannot be undone.'
	};

	/** The server refused the undo with a reason we can say in plain words. */
	class Refusal extends Error {}

	async function undo(row: Row, force = false) {
		busy = true;
		try {
			const r = await toast.promise(
				api<{ ok: boolean; reason?: string }>(org, `/events/${row.id}/undo`, {
					body: { force },
					key: newKey()
				}).then((r) => {
					// A conflict is not a failure: the person decides below whether to overwrite
					if (!r.ok && !(r.reason === 'conflict' && !force))
						throw new Refusal(WHY[r.reason ?? ''] ?? 'That could not be undone.');
					return r;
				}),
				{
					loading: 'Undoing...',
					// A conflict takes the loading toast away: the dialog below asks what to do
					success: (r) => (r.ok ? 'Undone.' : null),
					error: (e) =>
						e instanceof ApiError || e instanceof Refusal ? e.message : 'That could not be undone.'
				}
			);
			if (r.ok) {
				confirming = null;
				await onchanged();
			} else {
				// The thing changed again since, so the person decides whether to overwrite it
				confirming = row;
			}
		} catch {
			confirming = null;
			// The promise toast already shows the failure
		} finally {
			busy = false;
		}
	}

	// -- LIFECYCLES -- //

	onMount(() => {
		mounted = true;
	});
</script>

{#snippet undoButton(row: Row)}
	<Button
		size="sm"
		variant="ghost"
		disabled={busy}
		onclick={() => undo(row)}
		data-testid="undo"
		data-act="undo"
		aria-label="Undo"
	>
		<Undo2 size={14} /> <span class="max-sm:sr-only">Undo</span>
	</Button>
{/snippet}

{#snippet changeRow(e: Row, nested: boolean)}
	<li
		class={cn(
			'group/row relative flex items-start gap-3 rounded-lg hover:bg-raised/60',
			nested ? 'px-2 py-2' : 'px-3 py-3 max-sm:px-2'
		)}
		data-row
		data-testid="event"
		data-verb={e.verb}
		data-actor={e.tool ? 'agent' : 'person'}
	>
		{#if !nested}
			<Avatar
				name={e.actorLabel ?? 'Someone'}
				size={32}
				kind={e.tool ? 'agent' : 'person'}
				class="mt-0.5"
			/>
		{/if}
		<div class="min-w-0 flex-1">
			<p class="text-sm">
				{#if !nested}<span class="font-medium text-ink">{e.actorLabel ?? 'Someone'}</span>
					{#if e.tool && e.tool !== e.actorLabel}<span class="text-muted">via {e.tool}</span>{/if}
				{/if}
				{verbText(e.verb)}
				{#if e.itemId && refs[e.itemId]}
					<a
						class="font-mono text-xs text-accent-text hover:underline"
						href={`${linkBase ?? ''}/${refs[e.itemId]}`}>{refs[e.itemId]}</a
					>
				{/if}
			</p>
			<p class="mt-0.5 flex items-center gap-3 text-xs text-muted">
				<span>{ago(e.createdAt)}</span>
				{#if e.sessionId && linkBase && !nested}
					<a
						class="text-accent-text hover:underline max-sm:hidden"
						href={`${linkBase}/settings?tab=activity&session=${encodeURIComponent(e.sessionId)}`}
						data-testid="session-link">This session</a
					>
				{/if}
			</p>
		</div>
		{#if e.label === 'undone'}
			<Badge>undone</Badge>
		{:else if e.label === 'external'}
			<Badge tone="info">external</Badge>
		{:else if e.label === 'undoable' && canUndo}
			{@render undoButton(e)}
		{/if}
	</li>
{/snippet}

{#if events.length === 0}
	<EmptyState
		kind="events"
		title="Nothing has happened here yet"
		text="Changes to this project show up here, newest first."
	/>
{:else}
	<!-- THE TOOLBAR: A SEARCH, THE WHO FILTER WITH COUNTS, AND A LINE SAYING HOW MANY ARE SHOWN -->
	<div class="flex flex-col gap-3">
		<div
			class="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:flex-nowrap max-sm:items-stretch"
		>
			<input
				type="search"
				aria-label="Search the changes"
				placeholder="Search who, what or a reference"
				autocomplete="off"
				bind:value={query}
				data-testid="activity-search"
				class="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-[var(--elev-1)] placeholder:text-muted hover:border-muted focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none max-sm:h-11 sm:basis-64"
			/>
			<SegmentedControl
				label="Who made the change"
				bind:value={filter}
				options={FILTERS.map((f) => ({
					...f,
					label: `${f.label} ${counts[f.value as keyof typeof counts]}`
				}))}
			/>
		</div>
		<p class="text-xs text-muted tabular-nums" data-shown>
			Showing {shown.length} of {events.length} changes, newest first
		</p>

		{#if shown.length === 0}
			<p
				class="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted"
				data-testid="event-nomatch"
			>
				No change matches that. Clear the search or pick All.
			</p>
		{:else}
			<!-- A TIMELINE. WHO DID IT AS AN AVATAR (A SQUARE MARK FOR AN AGENT TOOL), WHAT THEY DID, WHEN, AND THE UNDO ON THE RIGHT -->
			<ul
				class="relative rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)]"
				data-testid="event-list"
			>
				{#each blocks as b, i (b.kind === 'row' ? `r${b.row.id}` : b.key)}
					{#if mounted && (i === 0 || blocks[i - 1].day !== b.day)}
						<!-- A DAY HEADING WHERE THE DAY CHANGES. IT STICKS UNDER THE TOP BAR -->
						<li
							role="presentation"
							class="sticky top-[57px] z-20 -mx-2 flex items-center gap-2 bg-surface/90 px-5 pt-3 pb-2 backdrop-blur-md max-sm:px-3.5 md:top-[65px]"
							data-testid="event-day"
						>
							<span
								class="relative z-10 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-semibold text-ink"
								>{dayLabel(b.kind === 'row' ? b.row.createdAt : b.rows[0].createdAt)}</span
							>
							<span class="h-px flex-1 bg-line"></span>
						</li>
					{/if}
					{#if b.kind === 'row'}
						{@render changeRow(b.row, false)}
					{:else}
						{@const index = blocks.indexOf(b)}
						{@const open = isOpen(b.key, index)}
						<li class="relative" data-testid="session-group" data-group>
							<div
								class="relative ml-1 rounded-xl border border-line bg-[color-mix(in_oklab,var(--raised)_40%,var(--surface))]"
							>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 max-sm:px-2">
									<button
										type="button"
										aria-expanded={open}
										aria-label="Show the changes of this session"
										onclick={() => toggleGroup(b.key, index)}
										class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:basis-full"
									>
										<ChevronRight
											size={18}
											class={cn(
												'shrink-0 text-muted transition-transform duration-200 motion-reduce:transition-none',
												open && 'rotate-90'
											)}
											aria-hidden="true"
										/>
										<Avatar name={b.rows[0].actorLabel ?? 'Someone'} size={32} kind="agent" />
										<span class="min-w-0 flex-1">
											<span class="block text-sm"
												><span class="font-medium text-ink"
													>{b.rows[0].actorLabel ?? 'Someone'}</span
												><span class="text-muted"> via {b.rows[0].tool}</span> made {b.rows.length} changes</span
											>
											<span class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted"
												>{ago(b.rows[b.rows.length - 1].createdAt)} to {ago(
													b.rows[0].createdAt
												)}</span
											>
										</span>
									</button>
									<div class="flex items-center gap-2 max-sm:w-full">
										{#if linkBase}
											<a
												class="text-sm text-accent-text hover:underline max-sm:flex max-sm:min-h-11 max-sm:items-center"
												href={`${linkBase}/settings?tab=activity&session=${encodeURIComponent(b.sessionId)}`}
												data-testid="session-link">Only this session</a
											>
										{/if}
										{#if canUndo && onundosession && b.rows.some((r) => r.label === 'undoable')}
											<Button
												size="sm"
												variant="ghost"
												class="text-danger"
												onclick={() => onundosession(b.sessionId)}
												data-testid="undo-session"
											>
												<Undo2 size={14} /> Undo this session
											</Button>
										{/if}
									</div>
								</div>
								<!-- COLLAPSIBLE: THE CONTENT STAYS MOUNTED, THE ROW GOES 0FR TO 1FR, A CLOSED FOLD IS INERT -->
								<div
									class={cn(
										'grid transition-[grid-template-rows,opacity,visibility] duration-200 ease-out motion-reduce:transition-none',
										open
											? 'visible grid-rows-[1fr] opacity-100'
											: 'invisible grid-rows-[0fr] opacity-0'
									)}
									inert={!open}
								>
									<div class="min-h-0 overflow-hidden">
										<ul class="relative border-t border-line p-1.5">
											{#each b.rows as r (r.id)}{@render changeRow(r, true)}{/each}
										</ul>
									</div>
								</div>
							</div>
						</li>
					{/if}
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<ConfirmDialog
	open={confirming !== null}
	onclose={() => (confirming = null)}
	title="This changed again since"
	confirmLabel="Undo anyway"
	tone="danger"
	onconfirm={() => (confirming ? undo(confirming, true) : undefined)}
>
	Something newer touched the same thing. Undoing this change overwrites that newer change.
</ConfirmDialog>
