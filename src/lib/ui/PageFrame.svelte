<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		children,
		testid = 'page-frame',
		tag = 'div',
		class: extra
	}: { children: Snippet; testid?: string; tag?: 'div' | 'main'; class?: string } = $props();
</script>

<!-- THE ONE CONTAINER (ADR-003). THE NAVIGATION AND EVERY PAGE SIT IN THE SAME 1920 PIXEL FRAME WITH THE SAME GUTTERS (WAS 1440, AFB-20261111-1344) -->
<svelte:element
	this={tag}
	data-testid={testid}
	class={cn('mx-auto w-full max-w-[1920px] px-8 max-sm:px-4', extra)}
>
	{@render children()}
</svelte:element>
