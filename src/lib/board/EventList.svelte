<script lang="ts">
	// IMPORTED DEP-MODULES
	import { onMount } from 'svelte';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { verbText } from '#lib/board/verbs.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
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

	// -- REQUIRED PROPS -- //

	let {
		events,
		org,
		canUndo,
		refs = {},
		onchanged,
		linkBase
	}: {
		events: Row[];
		org: string;
		canUndo: boolean;
		/** Item references by item id, so a project wide log can name the item. */
		refs?: Record<string, string>;
		onchanged: () => Promise<void>;
		/** The address an item reference links to, for example /acme/CKT. */
		linkBase?: string;
	} = $props();

	// -- STATES -- //

	let confirming = $state<Row | null>(null);
	let busy = $state(false);
	// Day headings depend on the viewer's own clock and time zone, so they are drawn only in the browser and the server markup agrees
	let mounted = $state(false);

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

{#if events.length === 0}
	<EmptyState
		kind="events"
		title="Nothing has happened here yet"
		text="Changes to this project show up here, newest first."
	/>
{:else}
	<!-- A TIMELINE. WHO DID IT AS AN AVATAR (A SQUARE MARK FOR AN AGENT TOOL), WHAT THEY DID, WHEN, AND THE UNDO ON THE RIGHT -->
	<ul
		class="rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)]"
		data-testid="event-list"
	>
		{#each events as e, i (e.id)}
			<!-- A DAY HEADING WHERE THE DAY CHANGES IN THE NEWEST FIRST ORDER. IT IS A PRESENTATION ROW SO THE LIST STAYS ONE LIST -->
			{#if mounted && (i === 0 || dayOf(events[i - 1].createdAt) !== dayOf(e.createdAt))}
				<li
					role="presentation"
					class="px-3 pt-3 pb-1 text-xs font-medium text-muted first:pt-1"
					data-testid="event-day"
				>
					{dayLabel(e.createdAt)}
				</li>
			{/if}
			<li
				class="relative flex items-start gap-4 rounded-lg px-3 py-3 hover:bg-raised/60"
				data-row
				data-testid="event"
				data-verb={e.verb}
			>
				<Avatar
					name={e.actorLabel ?? 'Someone'}
					size={32}
					kind={e.tool ? 'agent' : 'person'}
					class="mt-0.5"
				/>
				<div class="min-w-0 flex-1">
					<p class="text-sm">
						<span class="font-medium text-ink">{e.actorLabel ?? 'Someone'}</span>
						{#if e.tool && e.tool !== e.actorLabel}<span class="text-muted">
								via {e.tool}</span
							>{/if}
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
						{#if e.sessionId && linkBase}
							<a
								class="text-accent-text hover:underline max-sm:hidden"
								href={`${linkBase}/activity?session=${encodeURIComponent(e.sessionId)}`}
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
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onclick={() => undo(e)}
						data-testid="undo"
					>
						<Undo2 size={14} /> Undo
					</Button>
				{/if}
			</li>
		{/each}
	</ul>
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
