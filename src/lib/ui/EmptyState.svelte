<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED TYPES
	import type { IllustrationKind } from '#lib/ui/Illustration.svelte';
	// IMPORTED COMPONENTS
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
		/** Picks the scene, so each empty screen shows a picture about its own subject. */
		kind?: IllustrationKind;
		/** The first action to take, usually one primary button. */
		action?: Snippet;
	} = $props();
</script>

<div class="flex flex-col items-center gap-2 px-4 py-12 text-center">
	<!-- THE PICTURE CARRIES ITS OWN DOTTED GROUND AND HATCHED SHADOWS, SO THE EMPTY STATE IS NOT A BARE GREY BOX -->
	<div class="mb-2 p-2">
		<Illustration {kind} class="h-auto w-56" />
	</div>
	<h2 class="text-lg font-semibold text-ink">{title}</h2>
	<p class="max-w-[48ch] text-sm text-muted">{text}</p>
	{#if action}<div class="mt-2">{@render action()}</div>{/if}
</div>
