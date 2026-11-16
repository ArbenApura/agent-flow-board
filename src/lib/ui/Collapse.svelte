<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		open,
		children,
		id,
		class: extra
	}: {
		/** True shows the content. The trigger keeps its own aria-expanded and points at this id with aria-controls. */
		open: boolean;
		children: Snippet;
		id?: string;
		class?: string;
	} = $props();
</script>

<!-- ONE FOLD FOR EVERY COLLAPSIBLE. THE ROW HEIGHT GOES 0FR TO 1FR, THE CONTENT STAYS MOUNTED, A CLOSED FOLD IS INERT AND HIDDEN ONCE THE FADE ENDS -->
<div
	{id}
	inert={!open}
	class={cn(
		'grid transition-[grid-template-rows,opacity,visibility] duration-200 ease-[cubic-bezier(0,0,0.2,1)] motion-reduce:transition-none',
		open ? 'visible grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0',
		extra
	)}
>
	<!-- THE INNER BOX MUST BE ABLE TO SHRINK TO NOTHING, SO IT HAS NO MIN HEIGHT AND CLIPS ITS CONTENT -->
	<div class="min-h-0 overflow-hidden">
		{@render children()}
	</div>
</div>
