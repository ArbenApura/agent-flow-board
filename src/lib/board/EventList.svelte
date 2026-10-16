<script lang="ts">
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { verbText } from '#lib/board/verbs.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
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

	// -- FUNCTIONS -- //

	const WHY: Record<string, string> = {
		external: 'That change came from outside and cannot be undone here.',
		'already-undone': 'That change was already undone.',
		'not-found': 'That change no longer exists.',
		unsupported: 'That kind of change cannot be undone.'
	};

	async function undo(row: Row, force = false) {
		busy = true;
		try {
			const r = await api<{ ok: boolean; reason?: string }>(org, `/events/${row.id}/undo`, {
				body: { force },
				key: newKey()
			});
			if (r.ok) {
				toast.success('Undone.');
				confirming = null;
				await onchanged();
			} else if (r.reason === 'conflict' && !force) {
				// The thing changed again since, so the person decides whether to overwrite it
				confirming = row;
			} else {
				confirming = null;
				toast.error(WHY[r.reason ?? ''] ?? 'That could not be undone.');
			}
		} catch (e) {
			confirming = null;
			toast.error(e instanceof ApiError ? e.message : 'That could not be undone.');
		} finally {
			busy = false;
		}
	}
</script>

{#if events.length === 0}
	<EmptyState
		kind="inbox"
		title="Nothing has happened here yet"
		text="Changes to this project show up here, newest first."
	/>
{:else}
	<!-- A TIMELINE. WHO DID IT AS AN AVATAR (A SQUARE MARK FOR AN AGENT TOOL), WHAT THEY DID, WHEN, AND THE UNDO ON THE RIGHT -->
	<ul
		class="rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)]"
		data-testid="event-list"
	>
		{#each events as e (e.id)}
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
