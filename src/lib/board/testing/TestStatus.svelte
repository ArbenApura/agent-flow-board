<script lang="ts">
	// IMPORTED TYPES
	import type { Status } from './status';
	// IMPORTED CONSTANTS
	import { STATUS_DOT, STATUS_LABEL, STATUS_TEXT } from './status';

	// -- REQUIRED PROPS -- //

	let {
		status,
		severity = null
	}: {
		status: Status;
		/** Shown under a fail, as one quiet line. */
		severity?: string | null;
	} = $props();
</script>

<!-- ONE STATUS LOOK EVERYWHERE: A DOT AND A WORD, MUTED WHEN NOTHING NEEDS A PERSON (AFB-20261127-0438) -->
<span class="inline-flex flex-col">
	<span class={['inline-flex items-center gap-1.5 text-sm whitespace-nowrap', STATUS_TEXT[status]]}>
		<span class={['size-2 shrink-0 rounded-full', STATUS_DOT[status]]} aria-hidden="true"></span>
		{STATUS_LABEL[status]}
	</span>
	{#if severity && status === 'fail'}
		<span class="pl-3.5 text-xs text-muted">{severity}</span>
	{/if}
</span>
