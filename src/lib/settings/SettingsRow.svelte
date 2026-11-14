<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		children,
		lead,
		trail,
		class: extra,
		...rest
	}: {
		/** The two lines of the row: a name, and a quiet line under it. */
		children: Snippet;
		/** A picture before the text: an avatar, an organisation tile, a device icon. */
		lead?: Snippet;
		/** What sits at the right: a badge, a select, a button. */
		trail?: Snippet;
		class?: string;
		'data-testid'?: string;
	} = $props();
</script>

<!-- ONE ROW OF A SETTINGS LIST. THE LIST ITSELF IS THE <ul> THAT HOLDS IT. LONG TEXT WRAPS OR TRUNCATES IN THE TEXT COLUMN, SO A ROW STAYS A TWO LINE ROW -->
<li
	data-item
	data-row
	class={cn(
		'flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 max-sm:min-h-14',
		extra
	)}
	{...rest}
>
	{#if lead}<span class="inline-flex shrink-0 items-center">{@render lead()}</span>{/if}
	<!-- THE TEXT KEEPS AT LEAST 10rem, SO ON A PHONE A WIDE TRAIL WRAPS UNDER THE TEXT INSTEAD OF SQUEEZING IT TO NOTHING -->
	<div class="min-w-40 flex-1 text-sm">{@render children()}</div>
	{#if trail}<div class="flex shrink-0 flex-wrap items-center gap-2">{@render trail()}</div>{/if}
</li>
