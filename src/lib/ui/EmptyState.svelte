<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component, Snippet } from 'svelte';
	// -- DEP-COMPONENTS -- //
	import Tray from 'phosphor-svelte/lib/Tray';

	// -- REQUIRED PROPS -- //

	let {
		title,
		text,
		icon: Icon = Tray,
		action
	}: {
		title: string;
		/** One short sentence saying what this view is for and what to do first. */
		text: string;
		icon?: Component<{ size?: number; class?: string }>;
		/** The first action to take, usually one primary button. */
		action?: Snippet;
	} = $props();
</script>

<div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
	<Icon size={24} class="text-muted" />
	<h2 class="text-base leading-6 font-semibold text-ink sm:text-lg sm:leading-[26px]">{title}</h2>
	<p class="max-w-[48ch] text-sm leading-[22px] text-muted">{text}</p>
	{#if action}<div class="mt-2">{@render action()}</div>{/if}
</div>
