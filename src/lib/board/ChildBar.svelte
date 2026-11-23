<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { KidRow } from '#lib/board/rows.js';
	// IMPORTED MODULES
	import { childSummary } from '#lib/board/family.js';
	import { STATUS_STYLE, type Status } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		kids,
		class: extra
	}: {
		/** The child plans in order, one segment each. */
		kids: Pick<KidRow, 'status' | 'title' | 'childNo'>[];
		class?: string;
	} = $props();
</script>

<!-- ONE SEGMENT FOR EACH CHILD PLAN, IN ORDER, COLOURED BY ITS STATUS TOKEN. A PLANNED ONE IS FAINT SO THE WORK DONE STANDS OUT -->
<div
	role="img"
	aria-label={childSummary(kids)}
	class={cn('flex h-1.5 w-full gap-0.5', extra)}
	data-testid="child-bar"
>
	{#each kids as k (k.childNo)}
		<span
			class={cn(
				'h-full min-w-0 flex-1 rounded-full',
				STATUS_STYLE[k.status as Status].rail,
				k.status === 'PLANNED' && 'opacity-40'
			)}
			title={`${k.childNo}. ${k.title}`}
		></span>
	{/each}
</div>
