<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED MODULES
	import { ago } from '#lib/board/status.js';
	import { verbText } from '#lib/board/verbs.js';
	import { formatUtcDate, groupByDay } from '#lib/board/when.js';
	import Section from '#lib/settings/Section.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Collapse from '#lib/ui/Collapse.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Select from '#lib/ui/Select.svelte';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronsDown from '@lucide/svelte/icons/chevrons-down';
	import FolderKanban from '@lucide/svelte/icons/folder-kanban';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Play from '@lucide/svelte/icons/play';
	import Plug from '@lucide/svelte/icons/plug';
	import Plus from '@lucide/svelte/icons/plus';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import Settings from '@lucide/svelte/icons/settings';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	// -- TYPES -- //

	type AuditEvent = {
		id: number;
		verb: string;
		targetType: string;
		actorLabel: string | null;
		createdAt: string | Date;
		project: string;
	};
	type Kind = { icon: Component<{ size?: number; strokeWidth?: number }>; tone: string };
	type Row =
		| { kind: 'one'; key: string; i: number; e: AuditEvent }
		| {
				kind: 'fold';
				key: string;
				i: number;
				first: AuditEvent;
				items: AuditEvent[];
		  };

	// -- REQUIRED PROPS -- //

	let {
		events,
		projects,
		project,
		hasMore,
		loading = false,
		error = '',
		onfilter,
		onmore,
		onretry,
		group
	}: {
		/** Newest first, as loaded so far. */
		events: AuditEvent[];
		projects: { key: string }[];
		/** The chosen project key, or an empty string for every project. */
		project: string;
		hasMore: boolean;
		/** True while a project is being loaded, or the next page. */
		loading?: boolean;
		/** Why the last load failed, or an empty string. */
		error?: string;
		onfilter: (project: string) => void | Promise<void>;
		onmore: () => void | Promise<void>;
		onretry: () => void | Promise<void>;
		group?: string;
	} = $props();

	// -- CONSTANTS -- //

	// The smallest run of identical changes that folds into one row
	const FOLD_AT = 3;

	// -- STATES -- //

	let opened = $state<Record<string, boolean>>({});

	// -- REACTIVE STATES -- //

	const options = $derived([
		{ value: '', label: 'Every project' },
		...projects.map((p) => ({ value: p.key, label: p.key }))
	]);
	// Days with their rows: three or more identical changes in a row fold into one
	const days = $derived.by(() => {
		let i = 0;
		return groupByDay(events, (e) => e.createdAt).map((d) => {
			const rows: Row[] = [];
			for (let at = 0; at < d.items.length;) {
				let end = at + 1;
				while (end < d.items.length && same(d.items[at], d.items[end])) end++;
				if (end - at >= FOLD_AT) {
					const items = d.items.slice(at, end);
					rows.push({ kind: 'fold', key: `fold-${items[0].id}`, i: i++, first: items[0], items });
				} else {
					for (const e of d.items.slice(at, end))
						rows.push({ kind: 'one', key: `one-${e.id}`, i: i++, e });
				}
				at = end;
			}
			return { key: d.key, label: d.label, count: d.items.length, rows };
		});
	});

	// -- FUNCTIONS -- //

	const same = (a: AuditEvent, b: AuditEvent) =>
		a.actorLabel === b.actorLabel &&
		a.verb === b.verb &&
		a.project === b.project &&
		a.targetType === b.targetType;

	/** The picture and the tone of what kind of change it was. */
	function kindOf(verb: string): Kind {
		if (/\.(create|save|set)$/.test(verb) || verb === 'runner.create')
			return { icon: Plus, tone: 'text-success' };
		if (/\.(delete|cancel|failed|refused)$/.test(verb))
			return { icon: Trash2, tone: 'text-danger' };
		if (/\.restore$/.test(verb)) return { icon: RotateCcw, tone: 'text-muted' };
		if (verb.startsWith('comment.')) return { icon: MessageSquare, tone: 'text-muted' };
		if (verb.startsWith('attachment.')) return { icon: Paperclip, tone: 'text-muted' };
		if (verb.startsWith('publish.') || verb.startsWith('github.'))
			return { icon: GitBranch, tone: 'text-muted' };
		if (verb.startsWith('check') || verb.startsWith('ui_'))
			return { icon: Play, tone: 'text-muted' };
		if (verb.startsWith('runner.') || verb.startsWith('environment.'))
			return { icon: Plug, tone: 'text-muted' };
		if (verb.endsWith('.settings') || verb === 'project.update')
			return { icon: Settings, tone: 'text-muted' };
		return { icon: Pencil, tone: 'text-info' };
	}

	const hhmm = (v: string | Date) => new Date(v).toISOString().slice(11, 16);
	// UTC on both sides, so the page hydrates without a jump
	const exact = (v: string | Date) => `${formatUtcDate(v)}, ${hhmm(v)} UTC`;
	const toggle = (key: string) => (opened[key] = !opened[key]);
</script>

<Section
	id="audit"
	icon={ScrollText}
	{group}
	title="Audit log"
	text="Everything that changed in this organisation, newest first."
>
	<!-- THE TOOLBAR: THE PROJECT CHOICE AND HOW MANY CHANGES ARE SHOWN -->
	<div
		class="flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:flex-col max-sm:flex-nowrap max-sm:items-stretch"
	>
		<Select
			label="Project"
			value={project}
			{options}
			icon={FolderKanban}
			prefix="Project"
			onchange={(v) => onfilter(v)}
			class="w-full sm:w-60"
		/>
		<p class="text-xs text-muted tabular-nums sm:ml-auto" role="status">
			Showing {events.length}
			{events.length === 1 ? 'change' : 'changes'}{project ? ` in ${project}` : ''}, newest first
		</p>
	</div>

	{#if error}
		<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
			<ErrorState title="The audit log did not load" message={error} onretry={() => onretry()} />
		</div>
	{:else if loading && events.length === 0}
		<!-- LOADING SKELETON IN THE SHAPE OF THE TIMELINE -->
		<div
			role="status"
			aria-busy="true"
			aria-label="Loading"
			class="rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)]"
		>
			<div class="flex items-center gap-2 px-3 pt-3 pb-2">
				<span class="h-6 w-16 rounded-full bg-raised motion-safe:animate-pulse"></span>
				<span class="h-px flex-1 bg-line"></span>
			</div>
			{#each ['w-80', 'w-64', 'w-72', 'w-56'] as w (w)}
				<div class="flex items-start gap-3 px-3 py-3">
					<span class="size-6 shrink-0 rounded-full bg-raised motion-safe:animate-pulse"></span>
					<div class="flex min-w-0 flex-1 flex-col gap-2 pt-1">
						<span class={cn('h-4 max-w-full rounded-md bg-raised motion-safe:animate-pulse', w)}
						></span>
						<span class="h-3 w-24 max-w-full rounded-md bg-raised motion-safe:animate-pulse"></span>
					</div>
				</div>
			{/each}
		</div>
	{:else if events.length === 0}
		{#if project}
			<p class="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted">
				Nothing has happened in that project yet.
			</p>
		{:else}
			<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
				<EmptyState
					kind="items"
					title="Nothing has happened here yet"
					text="Changes in this organisation show up here, newest first."
				/>
			</div>
		{/if}
	{:else}
		<!-- A TIMELINE: A RAIL THAT DRAWS ONCE, STICKY DAY HEADINGS AND A NODE PER CHANGE -->
		<div class="relative rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)]">
			<span
				class="grow-in pointer-events-none absolute top-14 bottom-6 left-[32px] w-px bg-line max-sm:left-[28px]"
				aria-hidden="true"
			></span>
			<ul class="stagger" data-testid="audit-list">
				{#each days as day (day.key)}
					<li
						role="presentation"
						class="sticky top-[57px] z-20 -mx-2 flex items-center gap-2 bg-surface/90 px-5 pt-3 pb-2 backdrop-blur-md max-sm:px-3.5 md:top-[65px]"
						data-testid="event-day"
					>
						<span
							class="relative z-10 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-badge font-semibold text-ink"
							>{day.label}</span
						>
						<span class="text-xs text-muted tabular-nums"
							>{day.count} {day.count === 1 ? 'change' : 'changes'}</span
						>
						<span class="h-px flex-1 bg-line"></span>
					</li>
					{#each day.rows as row (row.key)}
						{#if row.kind === 'one'}
							{@const k = kindOf(row.e.verb)}
							<li
								class="relative flex items-start gap-3 rounded-lg px-3 py-3 hover:bg-raised/60 max-sm:gap-2.5 max-sm:px-2"
								style="--i:{row.i}"
								data-item
								data-row
								data-testid="audit-event"
							>
								<span
									class={cn(
										'relative z-10 mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface ring-4 ring-surface',
										k.tone
									)}><k.icon size={12} strokeWidth={2.5} /></span
								>
								<div class="min-w-0 flex-1">
									<p class="text-sm">
										<span class="font-medium text-ink">{row.e.actorLabel ?? 'Someone'}</span>
										{verbText(row.e.verb)}
									</p>
									<p
										class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted"
									>
										<span
											class="rounded-md border border-line bg-raised px-1.5 py-px font-mono text-xs text-muted"
											>{row.e.project}</span
										>
										<time class="tabular-nums" title={exact(row.e.createdAt)}
											>{hhmm(row.e.createdAt)}</time
										>
									</p>
								</div>
								<time
									class="shrink-0 pt-0.5 text-xs text-muted tabular-nums"
									title={exact(row.e.createdAt)}>{ago(row.e.createdAt)}</time
								>
							</li>
						{:else}
							{@const k = kindOf(row.first.verb)}
							{@const body = `audit-fold-${row.first.id}`}
							{@const open = !!opened[row.key]}
							<li class="relative" style="--i:{row.i}" data-item data-testid="audit-group">
								<!-- AN OPAQUE TINT SO THE RAIL BEHIND THE LIST DOES NOT SHOW THROUGH THE CARD -->
								<div
									class="relative ml-1 rounded-xl border border-line bg-[color-mix(in_oklab,var(--raised)_40%,var(--surface))]"
								>
									<!-- THE HEADER OF A FOLDED ROW OPENS EACH TIME IT HAPPENED -->
									<button
										type="button"
										aria-expanded={open}
										aria-controls={body}
										aria-label="Show every time this happened"
										onclick={() => toggle(row.key)}
										class="flex min-h-11 w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:px-2"
									>
										<ChevronRight
											size={18}
											class={cn(
												'shrink-0 text-muted transition-transform duration-200 motion-reduce:transition-none',
												open && 'rotate-90'
											)}
										/>
										<span
											class={cn(
												'relative z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface',
												k.tone
											)}><k.icon size={12} strokeWidth={2.5} /></span
										>
										<span class="min-w-0 flex-1 basis-48">
											<span class="block text-sm">
												<span class="font-medium text-ink">{row.first.actorLabel ?? 'Someone'}</span
												>
												{verbText(row.first.verb)}
												<span
													data-badge
													class="inline-flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-0.5 text-badge font-semibold text-ink tabular-nums"
													>×{row.items.length}</span
												>
											</span>
											<span class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
												<span
													class="rounded-md border border-line bg-raised px-1.5 py-px font-mono text-xs text-muted"
													>{row.first.project}</span
												>
												<span class="tabular-nums"
													>{hhmm(row.items[row.items.length - 1].createdAt)} to {hhmm(
														row.first.createdAt
													)}</span
												>
											</span>
										</span>
										<span class="shrink-0 text-xs text-muted tabular-nums"
											>{ago(row.first.createdAt)}</span
										>
									</button>
									<Collapse {open} id={body}>
										<ul class="border-t border-line p-1.5">
											{#each row.items as e (e.id)}
												<li
													class="flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 text-xs text-muted max-sm:px-2"
													data-row
													data-testid="audit-event"
												>
													<span class="size-1.5 shrink-0 rounded-full bg-line" aria-hidden="true"
													></span>
													<time class="tabular-nums" title={exact(e.createdAt)}
														>{hhmm(e.createdAt)}</time
													>
													<span class="min-w-0 flex-1 truncate text-ink">{verbText(e.verb)}</span>
													<span class="tabular-nums">{ago(e.createdAt)}</span>
												</li>
											{/each}
										</ul>
									</Collapse>
								</div>
							</li>
						{/if}
					{/each}
				{/each}
			</ul>
		</div>
		{#if hasMore}
			<div class="flex flex-col items-center gap-2 pt-1">
				<Button {loading} onclick={() => onmore()} data-testid="audit-more">
					<ChevronsDown size={16} />Show more
				</Button>
			</div>
		{/if}
	{/if}
</Section>
