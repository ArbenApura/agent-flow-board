<script lang="ts">
	// IMPORTED TYPES
	import type { QaStatus } from '#lib/board/qa/status.js';
	// IMPORTED MODULES
	import { QA_STATUSES, QA_STATUS_LABEL, QA_STATUS_RAIL } from '#lib/board/qa/status.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		counts,
		label,
		class: extra
	}: {
		/** How many of each status. A status with none draws no segment. */
		counts: Partial<Record<QaStatus, number>>;
		/** Names the bar for screen readers, such as "13 features by status". */
		label: string;
		/** The height and width, such as `h-2 w-full` or `h-1.5 w-16`. */
		class?: string;
	} = $props();

	// -- REACTIVE STATES -- //

	const segments = $derived(QA_STATUSES.filter((s) => (counts[s] ?? 0) > 0));
	const summary = $derived(
		segments.map((s) => `${counts[s]} ${QA_STATUS_LABEL[s].toLowerCase()}`).join(', ')
	);
</script>

<!-- ONE SEGMENT PER STATUS IN A FIXED STATUS TOKEN, 2 PX GAPS. IT DRAWS ONCE, OFF UNDER REDUCED MOTION -->
<span
	role="img"
	aria-label={`${label}: ${summary || 'nothing yet'}`}
	title={summary}
	class={cn('flex gap-0.5 overflow-hidden rounded-full bg-raised', extra ?? 'h-1.5 w-full')}
>
	{#each segments as s (s)}
		<!-- THE SEGMENT WIDTH IS A RUNTIME RATIO OF THE COUNTS -->
		<span
			class={cn('fill-in h-full min-w-1', s === 'not_tested' ? 'bg-muted/40' : QA_STATUS_RAIL[s])}
			style="flex: {counts[s]}"
		></span>
	{/each}
</span>
