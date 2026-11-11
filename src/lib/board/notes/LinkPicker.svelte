<script lang="ts">
	// -- TYPES -- //
	import type { LinkKind, Target } from '#lib/board/notes/links.js';
	// -- DEP-MODULES -- //
	import { onMount } from 'svelte';
	// -- MODULES -- //
	import { api } from '#lib/board/api.js';
	import { LinkSearch } from '#lib/board/notes/editorMenu.js';
	import { KIND_NAME, offerTargets, searchTargets } from '#lib/board/notes/links.js';
	// -- DEP-COMPONENTS -- //
	import X from '@lucide/svelte/icons/x';
	// -- COMPONENTS -- //
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		org,
		project,
		label,
		onpick,
		onclose,
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
		onclose: () => void;
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

<!-- INLINE PICKER. A SEARCH BOX AND A SHORT LIST, SO IT ALSO WORKS INSIDE A DRAWER WITHOUT A SECOND DIALOG -->
<div
	class="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3 text-sm"
	data-testid="link-picker"
>
	<div class="flex items-end gap-2">
		<div class="min-w-0 flex-1">
			<TextField {label} bind:value={q} maxlength={100} oninput={typed} data-testid="link-search" />
		</div>
		<button
			type="button"
			aria-label="Close the search"
			onclick={onclose}
			class="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:size-11"
		>
			<X size={16} />
		</button>
	</div>
	{#if searching && !offered.length}
		<Skeleton lines={3} />
	{:else if failed}
		<p class="text-sm text-danger" role="alert">The search did not work. Try typing again.</p>
	{:else if !offered.length}
		<p class="text-sm text-muted">Nothing found. Try other words from the title.</p>
	{:else}
		<ul class="flex max-h-64 flex-col overflow-y-auto" aria-label="Results">
			{#each offered as t (`${t.kind}:${t.id}`)}
				<li>
					<button
						type="button"
						disabled={busyId !== null}
						onclick={() => void pick(t)}
						class="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
					>
						<span class="w-16 shrink-0 text-xs text-muted">{KIND_NAME[t.kind]}</span>
						<span class="min-w-0 flex-1 truncate">{t.title}</span>
						{#if t.ref}<span class="shrink-0 font-mono text-xs text-muted">{t.ref}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
</div>
