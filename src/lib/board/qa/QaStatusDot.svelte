<script lang="ts">
	// IMPORTED MODULES
	import { QA_STATUS_DOT, QA_STATUS_LABEL, qaStatusOf } from '#lib/board/qa/status.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		status,
		class: extra
	}: {
		/** The status of a feature or a result. The word is for screen readers only. */
		status: string;
		class?: string;
	} = $props();

	// -- REACTIVE STATES -- //

	const s = $derived(qaStatusOf(status));
</script>

<!-- A SMALL FILLED CIRCLE IN THE FIXED STATUS TOKEN, NEVER THE ACCENT -->
<span class={cn('inline-block size-2 shrink-0 rounded-full', QA_STATUS_DOT[s], extra)}>
	<span class="sr-only">{QA_STATUS_LABEL[s]}</span>
</span>
