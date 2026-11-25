<script lang="ts">
	// IMPORTED MODULES
	import { QA_STATUS_DOT, QA_STATUS_LABEL, qaStatusOf } from '#lib/board/qa/status.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		status,
		decorative = false,
		class: extra
	}: {
		/** The status of a feature or a result. */
		status: string;
		/** True when a visible label or pill sits beside the dot, so a screen reader hears the word once. */
		decorative?: boolean;
		/** The size and spacing. It replaces the default `size-2`, so `size-1.5` really is smaller. */
		class?: string;
	} = $props();

	// -- REACTIVE STATES -- //

	const s = $derived(qaStatusOf(status));
</script>

<!-- A SMALL FILLED CIRCLE IN THE FIXED STATUS TOKEN, NEVER THE ACCENT -->
<span
	class={cn('inline-block shrink-0 rounded-full', extra ?? 'size-2', QA_STATUS_DOT[s])}
	aria-hidden={decorative ? 'true' : undefined}
>
	{#if !decorative}<span class="sr-only">{QA_STATUS_LABEL[s]}</span>{/if}
</span>
