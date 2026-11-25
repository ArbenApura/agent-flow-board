<script lang="ts">
	// IMPORTED MODULES
	import { QA_STATUS_LABEL, QA_STATUS_TONE, qaStatusOf } from '#lib/board/qa/status.js';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';

	// -- REQUIRED PROPS -- //

	let {
		status,
		flaky = false
	}: {
		/** The derived status of a feature or a result. */
		status: string;
		/** Some case gave both works and broken at the same commit. */
		flaky?: boolean;
	} = $props();

	// -- REACTIVE STATES -- //

	const s = $derived(qaStatusOf(status));
</script>

<span class="inline-flex shrink-0 items-center gap-1.5">
	<Badge tone={QA_STATUS_TONE[s]} data-testid="qa-status">{QA_STATUS_LABEL[s]}</Badge>
	{#if flaky}<Badge tone="warning">Flaky</Badge>{/if}
</span>
