<script lang="ts">
	// IMPORTED TYPES
	import type { NoteLink, NoteLinks, Target } from '#lib/board/notes/links.js';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { ApiError, api } from '#lib/board/api.js';
	import {
		addLink,
		canRemove,
		fetchLinks,
		groupLinks,
		linkHref,
		noteHref,
		removeLink,
		staysInText
	} from '#lib/board/notes/links.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
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
		note,
		version,
		role,
		canWrite
	}: {
		org: string;
		project: string;
		note: { id: string; ref: string };
		/** The saved version of the note. A new one means the text may link to something else, so the panel reads again. */
		version: number;
		/** The person's role in the project. A guest sees no panel. */
		role: string | null | undefined;
		canWrite: boolean;
	} = $props();

	// -- STATES -- //

	let loaded = $state.raw<NoteLinks | null>(null);
	let failed = $state(false);
	let adding = $state(false);
	let removing = $state<string | null>(null);
	let turn = 0;
	let prevRef = '';

	// -- REACTIVE STATES -- //

	const base = $derived(`/${org}/${project}`);
	const groups = $derived(groupLinks(loaded?.links ?? []));
	const linked = $derived((loaded?.links ?? []).map((l) => ({ kind: l.kind, id: l.id })));

	// -- REACTIVE STATEMENTS -- //

	// Another note starts again from the skeleton, a new version of the same note reads quietly
	$effect(() => {
		const ref = note.ref;
		void version;
		// A guest, or a role not known yet, sends no request. The effect runs again when the role arrives
		if (!role || role === 'guest') return;
		untrack(() => {
			if (ref !== prevRef) {
				loaded = null;
				adding = false;
			}
			prevRef = ref;
			void load();
		});
	});

	// -- FUNCTIONS -- //

	async function load() {
		const mine = ++turn;
		try {
			const got = await fetchLinks(api, org, project, note.ref);
			if (mine !== turn) return;
			loaded = got;
			failed = false;
		} catch {
			if (mine === turn) failed = true;
		}
	}

	async function add(target: Target): Promise<string | null> {
		try {
			await addLink(api, org, project, note.ref, target);
			await load();
			toast.success(`Linked to ${target.title}.`);
			return null;
		} catch (e) {
			return e instanceof ApiError ? e.message : 'The link could not be added. Try again.';
		}
	}

	async function remove(link: NoteLink) {
		if (removing) return;
		removing = `${link.kind}:${link.id}`;
		try {
			await removeLink(api, org, project, note.ref, link);
			await load();
			if (staysInText(link))
				toast.info('The link stays while the text of the note still names it.');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The link could not be removed. Try again.');
		} finally {
			removing = null;
		}
	}
</script>

{#if role !== 'guest'}
	<!-- THE LINKS PANEL. SAME CARD AND HEADING AS THE CARDS OF THE PLAN AND MOCKUP PAGES -->
	<Card data-testid="note-links">
		{#snippet header()}
			<h2 class="min-w-0 flex-1 text-lg leading-6 font-semibold">Links</h2>
			{#if canWrite && loaded}
				<Button size="sm" onclick={() => (adding = true)} data-testid="add-link">
					<Plus size={16} /> Add link
				</Button>
			{/if}
		{/snippet}
		<div class="flex flex-col gap-4 text-sm">
			{#if failed && !loaded}
				<ErrorState message="The links did not load." onretry={load} />
			{:else if !loaded}
				<div data-testid="links-loading"><Skeleton lines={3} /></div>
			{:else}
				{#if !groups.length}
					<p class="text-muted" data-testid="links-empty">No links yet</p>
				{/if}
				{#each groups as g (g.kind)}
					<section aria-label={g.label} class="flex flex-col gap-1">
						<h3 class="text-xs font-medium text-muted">{g.label}</h3>
						<ul class="flex flex-col">
							{#each g.links as l (`${l.kind}:${l.id}`)}
								<!-- A COMPACT ROW FOR THE SIDE COLUMN: THE TITLE ON TWO LINES, THEN THE REFERENCE AND WHERE THE LINK COMES FROM (AFB-20261111-0805) -->
								<li class="flex min-h-11 items-start gap-2">
									<a
										href={linkHref(base, l)}
										class="flex min-w-0 flex-1 cursor-pointer flex-col py-1.5 text-ink hover:underline"
									>
										<span class="line-clamp-2">{l.title}</span>
										{#if l.ref || !canRemove(l)}
											<span class="text-xs text-muted">
												{#if l.ref}<span class="font-mono">{l.ref}</span
													>{/if}{#if l.ref && !canRemove(l)}
													·
												{/if}{#if !canRemove(l)}In the text{/if}
											</span>
										{/if}
									</a>
									{#if canWrite && canRemove(l)}
										<button
											type="button"
											aria-label={`Remove the link to ${l.title}`}
											disabled={removing !== null}
											onclick={() => void remove(l)}
											class="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 max-md:size-11"
										>
											<X size={16} />
										</button>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/each}
				{#if loaded.mentionedBy.length}
					<section aria-label="Mentioned by" class="flex flex-col gap-1" data-testid="mentioned-by">
						<h3 class="text-xs font-medium text-muted">Mentioned by</h3>
						<ul class="flex flex-col">
							{#each loaded.mentionedBy as m (m.id)}
								<li class="flex min-h-11 items-start">
									<a
										href={noteHref(base, m)}
										class="flex min-w-0 cursor-pointer flex-col py-1.5 text-ink hover:underline"
									>
										<span class="line-clamp-2">{m.title}</span>
										<span class="font-mono text-xs text-muted">{m.ref}</span>
									</a>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/if}
		</div>
	</Card>

	<!-- ADD A LINK, IN A DIALOG (AFB-20261111-1344). MOUNTED WITH open, NEVER INSIDE AN {#if} -->
	<LinkDialog
		open={adding}
		onclose={() => (adding = false)}
		title="Add a link"
		{org}
		{project}
		label="Which plan, task, mockup or note should it link to?"
		selfId={note.id}
		{linked}
		onpick={add}
	/>
{/if}
