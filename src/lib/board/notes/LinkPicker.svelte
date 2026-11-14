<script lang="ts">
	// IMPORTED TYPES
	import type { LinkKind, Target } from '#lib/board/notes/links.js';
	// IMPORTED DEP-MODULES
	import { onMount } from 'svelte';
	// IMPORTED MODULES
	import { api } from '#lib/board/api.js';
	import { LinkSearch } from '#lib/board/notes/editorMenu.js';
	import { KIND_NAME, offerTargets, searchTargets } from '#lib/board/notes/links.js';
	// IMPORTED DEP-COMPONENTS
	import Search from '@lucide/svelte/icons/search';
	// IMPORTED COMPONENTS
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		org,
		project,
		label,
		onpick,
		kinds,
		selfId,
		linked = []
	}: {
		org: string;
		project: string;
		/** The question over the search box. */
		label: string;
		/** Links the chosen one. Returns a plain message when it could not, and nothing when it did. */
		onpick: (target: Target) => Promise<string | null | void>;
		/** The kinds worth offering. All four when left out. */
		kinds?: LinkKind[];
		/** The note this picker belongs to, which is never offered to itself. */
		selfId?: string;
		/** What is linked already, so it is not offered again. */
		linked?: { kind: LinkKind; id: string }[];
	} = $props();

	// -- STATES -- //

	let q = $state('');
	let results = $state.raw<Target[]>([]);
	let searching = $state(true);
	let failed = $state(false);
	let error = $state('');
	let busyId = $state<string | null>(null);

	// -- REACTIVE STATES -- //

	const offered = $derived(offerTargets(results, { kinds, selfId, linked }));

	// -- FUNCTIONS -- //

	const search = new LinkSearch(
		(text) => searchTargets(api, org, project, text),
		(result) => {
			if ('error' in result) {
				results = [];
				failed = true;
			} else {
				results = result.targets;
				failed = false;
			}
			searching = false;
		}
	);

	function typed() {
		searching = true;
		search.ask(q);
	}

	async function pick(t: Target) {
		if (busyId) return;
		busyId = t.id;
		error = '';
		try {
			const refused = await onpick(t);
			if (refused) error = refused;
		} finally {
			busyId = null;
		}
	}

	// -- LIFECYCLES -- //

	// The newest of each kind show before anything is typed
	onMount(() => {
		search.ask('', true);
		return () => search.cancel();
	});
</script>

<!-- THE BODY OF THE ADD LINK DIALOG (LinkDialog.svelte). A SEARCH FIELD AND A SHORT LIST. THE DIALOG HAS THE CLOSE BUTTON AND CANCEL -->
<div class="flex flex-col gap-3 text-sm" data-testid="link-picker">
	<TextField
		{label}
		icon={Search}
		bind:value={q}
		maxlength={100}
		oninput={typed}
		class="text-sm"
		data-testid="link-search"
		data-autofocus
	/>
	{#if searching && !offered.length}
		<Skeleton lines={3} />
	{:else if failed}
		<p class="text-sm text-danger" role="alert">The search did not work. Try typing again.</p>
	{:else if !offered.length}
		<p class="text-sm text-muted">Nothing found. Try other words from the title.</p>
	{:else}
		<!-- THE ROWS RUN 10 PX PAST THE DIALOG'S PADDING AND PAD THEIR TEXT BACK, SO THE HOVER TINT HAS AN EVEN MARGIN -->
		<ul class="-mx-2.5 flex max-h-72 flex-col overflow-y-auto" aria-label="Results">
			{#each offered as t (`${t.kind}:${t.id}`)}
				<li>
					<button
						type="button"
						disabled={busyId !== null}
						onclick={() => void pick(t)}
						title={t.ref ? `${t.title}, ${t.ref}` : t.title}
						class="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left text-ink hover:bg-raised focus-visible:bg-raised focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
					>
						<span class="w-14 shrink-0 text-xs text-muted">{KIND_NAME[t.kind]}</span>
						<span class="min-w-0 flex-1 truncate">{t.title}</span>
						{#if t.ref}<span class="shrink-0 font-mono text-xs text-muted">{t.ref}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
</div>
