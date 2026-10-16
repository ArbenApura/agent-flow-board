<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- DEP-COMPONENTS -- //
	import Illustration from '#lib/ui/Illustration.svelte';

	// -- REQUIRED PROPS -- //

	let {
		title,
		text,
		kind = 'items',
		action
	}: {
		title: string;
		/** One short sentence saying what this view is for and what to do first. */
		text: string;
		kind?: 'items' | 'search' | 'inbox' | 'error' | 'welcome';
		/** The first action to take, usually one primary button. */
		action?: Snippet;
	} = $props();
</script>

<div class="flex flex-col items-center gap-2 px-4 py-12 text-center">
	<Illustration {kind} class="mb-2" />
	<h2 class="text-lg font-semibold text-ink">{title}</h2>
	<p class="max-w-[48ch] text-sm text-muted">{text}</p>
	{#if action}<div class="mt-2">{@render action()}</div>{/if}
</div>
