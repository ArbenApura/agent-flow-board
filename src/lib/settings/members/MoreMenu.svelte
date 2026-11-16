<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED DEP-COMPONENTS
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	// IMPORTED COMPONENTS
	import Popover from '#lib/ui/Popover.svelte';

	// -- REQUIRED PROPS -- //

	let {
		label,
		heading,
		items
	}: {
		/** Names the button for screen readers: More for Marcus Veld. */
		label: string;
		/** A quiet line at the top of the menu saying who it is about. */
		heading: string;
		/** The menu items. Call `close` before acting. */
		items: Snippet<[{ close: () => void }]>;
	} = $props();

	// -- STATES -- //

	let open = $state(false);
</script>

<!-- THE MORE BUTTON OF A ROW AND ITS MENU. THE LAST COLUMN OF EVERY PEOPLE TABLE -->
<Popover bind:open placement="bottom-end" role="menu" {label} offset={6} class="w-[272px]">
	{#snippet trigger({ props, toggle })}
		<button
			type="button"
			onclick={toggle}
			aria-label={label}
			{...props}
			class="inline-flex size-10 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent text-ink transition-colors hover:bg-ink/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-expanded:bg-ink/10 max-sm:size-11"
		>
			<Ellipsis size={18} />
		</button>
	{/snippet}
	{#snippet children({ close })}
		<div class="truncate px-3 pt-2 pb-1.5 text-xs font-medium text-muted">{heading}</div>
		{@render items({ close })}
	{/snippet}
</Popover>
