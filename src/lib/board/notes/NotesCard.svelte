<script lang="ts">
	// IMPORTED TYPES
	import type { LinkedNote, Target } from '#lib/board/notes/links.js';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { ApiError, api } from '#lib/board/api.js';
	import { addLink, fetchLinkedNotes, noteHref, targetName } from '#lib/board/notes/links.js';
	import { ago } from '#lib/board/status.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Plus from '@lucide/svelte/icons/plus';
	// IMPORTED COMPONENTS
	import LinkDialog from '#lib/board/notes/LinkDialog.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';

	// -- REQUIRED PROPS -- //

	let {
		org,
		project,
		target,
		role,
		canWrite
	}: {
		org: string;
		project: string;
		/** The plan, task or mockup the card belongs to. A plan and a task have a reference, a mockup is named by its id. */
		target: { kind: 'item' | 'task' | 'mockup'; id: string; ref: string | null };
		/** The person's role in the project. A guest sees no card. */
		role: string | null | undefined;
		canWrite: boolean;
	} = $props();

	// -- STATES -- //

	let notes = $state.raw<LinkedNote[] | null>(null);
	let failed = $state(false);
	let adding = $state(false);
	let turn = 0;
	let prevId = '';

	// -- REACTIVE STATES -- //

	const base = $derived(`/${org}/${project}`);
	const linked = $derived((notes ?? []).map((n) => ({ kind: 'note' as const, id: n.id })));

	// -- REACTIVE STATEMENTS -- //

	// Another plan, task or mockup starts again from the skeleton
	$effect(() => {
		const id = `${target.kind}:${target.id}`;
		// A guest, or a role not known yet, sends no request. The effect runs again when the role arrives
		if (!role || role === 'guest') return;
		untrack(() => {
			if (id !== prevId) {
				notes = null;
				adding = false;
			}
			prevId = id;
			void load();
		});
	});

	// -- FUNCTIONS -- //

	async function load() {
		const mine = ++turn;
		try {
			const got = await fetchLinkedNotes(api, org, project, {
				kind: target.kind,
				name: targetName(target)
			});
			if (mine !== turn) return;
			notes = got;
			failed = false;
		} catch {
			if (mine === turn) failed = true;
		}
	}

	/** The picked note gets the link, the same panel link its own page shows. */
	async function link(picked: Target): Promise<string | null> {
		try {
			await addLink(api, org, project, picked.ref ?? picked.id, {
				kind: target.kind,
				id: target.id,
				ref: target.ref,
				title: ''
			});
			await load();
			toast.success(`${picked.title} is linked.`);
			adding = false;
			return null;
		} catch (e) {
			return e instanceof ApiError ? e.message : 'The note could not be linked. Try again.';
		}
	}
</script>

{#if role !== 'guest'}
	<!-- NOTES THAT LINK HERE. SAME CARD AND HEADING AS THE CARDS NEXT TO IT -->
	<Card data-testid="notes-card">
		{#snippet header()}
			<h2 class="min-w-0 flex-1 text-lg leading-6 font-semibold">Notes</h2>
			{#if canWrite && notes}
				<Button size="sm" onclick={() => (adding = true)} data-testid="link-a-note">
					<Plus size={16} /> Link a note
				</Button>
			{/if}
		{/snippet}
		<div class="flex flex-col gap-3 text-sm">
			{#if failed && !notes}
				<ErrorState message="The notes did not load." onretry={load} />
			{:else if !notes}
				<div data-testid="notes-loading"><Skeleton lines={2} /></div>
			{:else if !notes.length}
				<p class="text-muted" data-testid="notes-empty">No notes linked yet</p>
			{:else}
				<ul class="flex flex-col">
					{#each notes as n (n.id)}
						<li>
							<a
								href={noteHref(base, n)}
								class="flex min-h-11 cursor-pointer items-center gap-2 text-ink hover:underline"
							>
								<span class="min-w-0 flex-1 truncate">{n.title}</span>
								<span class="shrink-0 font-mono text-xs text-muted">{n.ref}</span>
								<span class="shrink-0 text-xs text-muted max-sm:hidden">{ago(n.updatedAt)}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Card>

	<!-- LINK A NOTE, IN THE SAME DIALOG AS ADD LINK, FOR NOTES ONLY (AFB-20261111-1344). MOUNTED WITH open, NEVER INSIDE AN {#if} -->
	<LinkDialog
		open={adding}
		onclose={() => (adding = false)}
		title="Link a note"
		{org}
		{project}
		label="Which note should be linked here?"
		kinds={['note']}
		{linked}
		onpick={link}
	/>
{/if}
