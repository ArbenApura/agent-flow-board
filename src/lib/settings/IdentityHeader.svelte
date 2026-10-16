<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';

	// -- REQUIRED PROPS -- //

	let {
		lead,
		title,
		subtitle,
		children
	}: {
		/** The face of whose settings these are: an avatar or an organisation tile, at most 40 px. */
		lead: Snippet;
		title: string;
		/** One quiet line: an email, or an address. */
		subtitle?: string;
		/** Small badges after the name: a role, a count. */
		children?: Snippet;
	} = $props();
</script>

<!-- WHOSE SETTINGS THESE ARE, AT THE TOP OF THE FIRST SECTION. A PICTURE, A NAME, ONE QUIET LINE AND A FEW BADGES -->
<div class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-raised/50 p-3">
	<span class="inline-flex shrink-0">{@render lead()}</span>
	<div class="min-w-0 flex-1">
		<div class="truncate text-sm font-semibold text-ink">{title}</div>
		{#if subtitle}<div class="truncate text-xs text-muted">{subtitle}</div>{/if}
	</div>
	{#if children}<div class="flex flex-wrap items-center gap-2">{@render children()}</div>{/if}
</div>
