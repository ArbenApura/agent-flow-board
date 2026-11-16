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
	import Collapse from '#lib/ui/Collapse.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import Bot from '@lucide/svelte/icons/bot';
	import Calendar from '@lucide/svelte/icons/calendar';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Trash2 from '@lucide/svelte/icons/trash-2';
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

	type Kind = 'create' | 'update' | 'status' | 'delete' | 'restore' | 'comment' | 'file' | 'git';

	// -- REQUIRED PROPS -- //

	let {
		events,
		org,
		canUndo,
		refs = {},
		onchanged,
		linkBase,
		onundosession,
		scoped = false
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
		/** True when the list is already narrowed to one agent session, so the date range stays off. */
		scoped?: boolean;
	} = $props();

	// -- CONSTANTS -- //

	const FILTERS = [
		{ value: 'all', label: 'All' },
		{ value: 'person', label: 'People' },
		{ value: 'agent', label: 'Agents' },
		{ value: 'undoable', label: 'Undoable' }
	];

	const RANGES = [
		{ value: '24h', label: 'Last 24 hours', ms: 24 * 3600_000 },
		{ value: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
		{ value: '30d', label: 'Last 30 days', ms: 30 * 24 * 3600_000 },
		{ value: 'all', label: 'All time', ms: Infinity }
	];
	/** How many changes show first, and how many more each Load older changes adds. */
	const PAGE = 25;

	/** The mark each kind of change gets: its icon and its tone token. */
	const KINDS: Record<Kind, { icon: typeof Plus; tone: string }> = {
		create: { icon: Plus, tone: 'text-success' },
		update: { icon: Pencil, tone: 'text-muted' },
		status: { icon: CircleDot, tone: 'text-warning' },
		delete: { icon: Trash2, tone: 'text-danger' },
		restore: { icon: ArchiveRestore, tone: 'text-success' },
		comment: { icon: MessageSquare, tone: 'text-info' },
		file: { icon: Paperclip, tone: 'text-muted' },
		git: { icon: GitBranch, tone: 'text-muted' }
	};

	// -- STATES -- //

	let limit = $state(PAGE);
	// The date range starts at the last 7 days, or at everything when the list is already one session
	// svelte-ignore state_referenced_locally
	let range = $state(scoped ? 'all' : '7d');
	let confirming = $state<Row | null>(null);
	let busy = $state(false);
	// Day headings depend on the viewer's own clock and time zone, so they are drawn only in the browser and the server markup agrees
	let mounted = $state(false);
	let filter = $state('all');
	let query = $state('');
	// Session groups are open or closed by their own header; the first group opens, the others start folded
	let opened = $state<Record<string, boolean>>({});

	// -- REACTIVE STATES -- //

	// The changes inside the date range; the counts, the filters and the day headings all read from these
	const inRange = $derived.by(() => {
		const ms = RANGES.find((r) => r.value === range)?.ms ?? Infinity;
		if (!Number.isFinite(ms)) return events;
		const from = Date.now() - ms;
		return events.filter((e) => new Date(e.createdAt).getTime() >= from);
	});

	const shown = $derived(
		inRange.filter(
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
		all: inRange.length,
		person: inRange.filter((e) => !e.tool).length,
		agent: inRange.filter((e) => !!e.tool).length,
		undoable: inRange.filter((e) => e.label === 'undoable').length
	});

	const visible = $derived(shown.slice(0, limit));

	// How many changes each day holds, for the count beside the day heading
	const dayCounts = $derived.by(() => {
		const m: Record<string, number> = {};
		for (const e of visible) m[dayOf(e.createdAt)] = (m[dayOf(e.createdAt)] ?? 0) + 1;
		return m;
	});

	// Consecutive changes of one agent session fold into one group (two or more); everything else is a plain row
	const blocks = $derived.by<Block[]>(() => {
		const out: Block[] = [];
		for (const e of visible) {
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
		// The day before the month, as in Fri 13 Nov
		return day
			.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
			.replace(',', '');
	}

	/** Which mark a verb gets: plus for a create, a dot for a status, a bin for a delete and so on. */
	function kindOf(verb: string): Kind {
		if (verb === 'item.status') return 'status';
		if (/.delete$/.test(verb) || verb === 'item.delete') return 'delete';
		if (/.restore$/.test(verb)) return 'restore';
		if (/.create$/.test(verb))
			return verb.startsWith('comment')
				? 'comment'
				: verb.startsWith('attachment')
					? 'file'
					: 'create';
		if (verb.startsWith('comment')) return 'comment';
		if (verb.startsWith('attachment')) return 'file';
		if (verb.startsWith('github') || verb.startsWith('publish')) return 'git';
		return 'update';
	}

	const exact = (value: Date | string) =>
		new Date(value).toLocaleString('en', {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});
	const clock = (value: Date | string) =>
		new Date(value).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
	const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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
		class="text-muted! hover:text-ink! max-md:border-line! max-sm:w-11 max-sm:px-0 md:group-hover/row:border-line! md:focus-visible:border-line!"
	>
		<Undo2 size={14} /> <span class="max-sm:sr-only">Undo</span>
	</Button>
{/snippet}

{#snippet itemChip(e: Row)}
	{#if e.itemId && refs[e.itemId]}
		<a
			class="inline-block rounded-md border border-line bg-raised px-1.5 py-px font-mono text-xs whitespace-nowrap text-accent-text hover:underline"
			href={`${linkBase ?? ''}/${refs[e.itemId]}`}>{refs[e.itemId]}</a
		>
	{/if}
{/snippet}

{#snippet changeRow(e: Row, nested: boolean, i: number)}
	{@const kind = KINDS[kindOf(e.verb)]}
	<li
		class={cn(
			'row-in group/row relative flex items-start gap-3 rounded-lg hover:bg-raised/60 max-sm:gap-2.5',
			nested ? 'px-2 py-2' : 'px-3 py-3 max-sm:px-2'
		)}
		data-row
		data-testid="event"
		data-verb={e.verb}
		data-actor={e.tool ? 'agent' : 'person'}
		data-undoable={e.label === 'undoable'}
		style="--i: {i};"
	>
		<!-- THE ROW STAGGER INDEX IS A RUNTIME NUMBER -->
		{#if nested}
			<!-- A NODE OF THE COMPACT RAIL IN A SESSION GROUP: THE KIND ICON ALONE -->
			<span
				class={cn(
					'relative z-10 mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface ring-4 ring-surface',
					kind.tone
				)}
			>
				<kind.icon size={12} aria-hidden="true" />
			</span>
		{:else}
			<!-- THE AVATAR, ROUND FOR A PERSON AND SQUARE FOR AN AGENT TOOL, WITH A SMALL KIND BADGE AT ITS LOWER RIGHT -->
			<span
				class={cn(
					'relative z-10 mt-0.5 shrink-0 ring-4 ring-surface',
					e.tool ? 'rounded-md' : 'rounded-full'
				)}
			>
				<Avatar name={e.actorLabel ?? 'Someone'} size={32} kind={e.tool ? 'agent' : 'person'} />
				<span
					class={cn(
						'absolute -right-1 -bottom-1 inline-flex size-4 items-center justify-center rounded-full border border-line bg-surface',
						kind.tone
					)}
				>
					<kind.icon size={10} aria-hidden="true" />
				</span>
			</span>
		{/if}
		<div class="min-w-0 flex-1">
			<p class="text-sm">
				{#if nested}
					<span class="font-medium text-ink">{capital(verbText(e.verb))}</span>
				{:else}
					<span class="font-medium text-ink">{e.actorLabel ?? 'Someone'}</span>
					{#if e.tool && e.tool !== e.actorLabel}<span class="text-muted">via {e.tool}</span>{/if}
					{verbText(e.verb)}
				{/if}
				{@render itemChip(e)}
			</p>
			<p class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
				<time title={exact(e.createdAt)}>{ago(e.createdAt)}</time>
				{#if e.sessionId && linkBase && !nested}
					<a
						class="text-accent-text hover:underline max-sm:hidden"
						href={`${linkBase}/settings?tab=activity&session=${encodeURIComponent(e.sessionId)}`}
						data-testid="session-link">This session</a
					>
				{/if}
			</p>
		</div>
		<div class="flex shrink-0 items-center">
			{#if e.label === 'undone'}
				<Badge>undone</Badge>
			{:else if e.label === 'external'}
				<Badge tone="info">external</Badge>
			{:else if e.label === 'undoable' && canUndo}
				{@render undoButton(e)}
			{/if}
		</div>
	</li>
{/snippet}

{#if events.length === 0}
	<EmptyState
		kind="events"
		title="Nothing has happened here yet"
		text="Changes to this project show up here, newest first."
	/>
{:else}
	<!-- THE TOOLBAR: A SEARCH, THE WHO FILTER WITH COUNTS, AND THE DATE RANGE -->
	<div class="flex flex-col gap-3">
		<div
			class="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:flex-nowrap max-sm:items-stretch"
			data-ref="activity-toolbar"
		>
			<div class="group relative min-w-0 flex-1 sm:basis-64">
				<Search
					size={16}
					aria-hidden="true"
					class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted group-focus-within:text-accent-text"
				/>
				<input
					type="search"
					aria-label="Search the changes"
					placeholder="Search who, what or a reference"
					autocomplete="off"
					bind:value={query}
					data-testid="activity-search"
					class="h-10 w-full rounded-lg border border-line bg-surface pr-3 pl-10 text-sm text-ink shadow-[var(--elev-1)] placeholder:text-muted hover:border-muted focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none max-sm:h-11"
				/>
			</div>
			<div class="flex min-w-0 items-center gap-2 max-sm:flex-col max-sm:items-stretch">
				<SegmentedControl
					label="Who made the change"
					bind:value={filter}
					options={FILTERS.map((f) => ({
						...f,
						label: `${f.label} ${counts[f.value as keyof typeof counts]}`
					}))}
				/>
				{#if !scoped}
					<Select
						label="Date range"
						icon={Calendar}
						options={RANGES.map(({ value, label }) => ({ value, label }))}
						bind:value={range}
						class="sm:w-48"
					/>
				{/if}
			</div>
		</div>

		{#if shown.length === 0}
			<p
				class="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted"
				data-testid="event-nomatch"
			>
				No change matches that. Clear the search, pick All or widen the date range.
			</p>
		{:else}
			<!-- A TIMELINE. WHO DID IT AS AN AVATAR (A SQUARE MARK FOR AN AGENT TOOL), WHAT THEY DID, WHEN, AND THE UNDO ON THE RIGHT -->
			<ul
				class="relative rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)]"
				data-ref="activity-timeline"
				data-testid="event-list"
			>
				<!-- THE RAIL BEHIND THE AVATARS DRAWS DOWN ONCE -->
				<span
					class="grow-in pointer-events-none absolute top-14 bottom-6 left-[36px] w-px bg-line max-sm:left-[32px]"
					aria-hidden="true"
				></span>
				{#each blocks as b, i (b.kind === 'row' ? `r${b.row.id}` : b.key)}
					{#if mounted && (i === 0 || blocks[i - 1].day !== b.day)}
						<!-- A DAY HEADING WHERE THE DAY CHANGES, WITH ITS COUNT. IT STICKS UNDER THE TOP BAR -->
						{@const n = dayCounts[b.day] ?? 0}
						<li
							role="presentation"
							class="sticky top-[57px] z-20 -mx-2 flex items-center gap-2 bg-surface/90 px-5 pt-3 pb-2 backdrop-blur-md max-sm:px-3.5 md:top-[65px]"
							data-testid="event-day"
						>
							<span
								class="relative z-10 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-semibold text-ink"
								>{dayLabel(b.kind === 'row' ? b.row.createdAt : b.rows[0].createdAt)}</span
							>
							<span class="text-xs text-muted tabular-nums"
								>{n} {n === 1 ? 'change' : 'changes'}</span
							>
							<span class="h-px flex-1 bg-line"></span>
						</li>
					{/if}
					{#if b.kind === 'row'}
						{@render changeRow(b.row, false, i)}
					{:else}
						{@const open = isOpen(b.key, i)}
						{@const first = b.rows[0]}
						{@const last = b.rows[b.rows.length - 1]}
						{@const planId = b.rows.every((r) => r.itemId === first.itemId) ? first.itemId : null}
						<li
							class="row-in relative"
							data-ref="session-group"
							data-testid="session-group"
							data-group
							style="--i: {i};"
						>
							<!-- THE ROW STAGGER INDEX IS A RUNTIME NUMBER -->
							<div
								class="relative ml-1 rounded-xl border border-line bg-[color-mix(in_oklab,var(--raised)_40%,var(--surface))]"
							>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 max-sm:px-2">
									<button
										type="button"
										aria-expanded={open}
										aria-controls={`fold-${b.key}`}
										aria-label="Show the changes of this session"
										onclick={() => toggleGroup(b.key, i)}
										class="relative z-10 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:basis-full"
									>
										<ChevronRight
											size={18}
											class={cn(
												'shrink-0 text-muted transition-transform duration-200 motion-reduce:transition-none',
												open && 'rotate-90'
											)}
											aria-hidden="true"
										/>
										<span class="relative shrink-0 rounded-md ring-4 ring-surface">
											<Avatar name={first.actorLabel ?? 'Someone'} size={32} kind="agent" />
											<span
												class="absolute -right-1 -bottom-1 inline-flex size-4 items-center justify-center rounded-full border border-line bg-surface text-accent-text"
											>
												<Bot size={10} aria-hidden="true" />
											</span>
										</span>
										<span class="min-w-0 flex-1">
											<span class="block text-sm"
												><span class="font-medium text-ink">{first.actorLabel ?? 'Someone'}</span
												><span class="text-muted"> via {first.tool}</span> made {b.rows.length} changes</span
											>
											<span
												class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted"
											>
												<time title={`${exact(last.createdAt)} to ${exact(first.createdAt)}`}
													>{clock(last.createdAt)} to {clock(first.createdAt)}</time
												>
												{#if planId && refs[planId]}
													<span aria-hidden="true">·</span>
													<!-- A LINK INSIDE THE TOGGLE BUTTON IS NOT ALLOWED, SO THE PLAN REFERENCE SHOWS AS A CHIP -->
													<span
														class="inline-block rounded-md border border-line bg-raised px-1.5 py-px font-mono text-xs whitespace-nowrap text-accent-text"
														>{refs[planId]}</span
													>
												{/if}
											</span>
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
								<Collapse {open} id={`fold-${b.key}`}>
									<ul class="relative border-t border-line p-1.5">
										<!-- THE COMPACT RAIL OF KIND ICONS BEHIND THE NODES -->
										<span
											class="pointer-events-none absolute top-5 bottom-5 left-[22px] w-px bg-line"
											aria-hidden="true"
										></span>
										{#each b.rows as r, j (r.id)}{@render changeRow(r, true, j)}{/each}
									</ul>
								</Collapse>
							</div>
						</li>
					{/if}
				{/each}
			</ul>

			<!-- THE FOOT: LOAD OLDER CHANGES AND HOW MANY ARE SHOWN -->
			<div class="flex flex-col items-center gap-2 pt-1">
				{#if visible.length < shown.length}
					<Button variant="secondary" onclick={() => (limit += PAGE)} data-testid="load-older">
						Load older changes
					</Button>
				{/if}
				<p class="text-xs text-muted tabular-nums" data-shown>
					Showing {visible.length} of {shown.length} changes
				</p>
			</div>
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
