<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';

	// -- REQUIRED PROPS -- //

	let { children }: { children: Snippet } = $props();
</script>

<!-- A CRISP CARD FOR THE SIGN IN PAGES. A SOLID SURFACE, A CLEAR 1PX EDGE, A HAIRLINE OF LIGHT ON TOP AND ONE TIGHT SHADOW -->
<div
	class="relative overflow-hidden rounded-xl border border-line bg-surface shadow-[inset_0_1px_0_0_rgb(255_255_255/0.05),0_1px_2px_rgb(0_0_0/0.25),0_14px_30px_-14px_rgb(0_0_0/0.45)]"
>
	{@render children()}
</div>
