<script lang="ts">
	// IMPORTED TYPES
	import type { Status } from './status';
	// IMPORTED CONSTANTS
	import { STATUS_FILL, STATUS_LABEL } from './status';

	// -- REQUIRED PROPS -- //

	let {
		history,
		large = false
	}: {
		/** The last runs, oldest first, with the case version each ran. */
		history: { runNo: number; status: Status; version: number }[];
		large?: boolean;
	} = $props();

	// -- REACTIVE STATES -- //

	// Ten slots always, the empty ones first, so every row's strip lines up
	const slots = $derived([
		...Array.from({ length: Math.max(0, 10 - history.length) }, () => null),
		...history.slice(-10)
	]);
</script>

<!-- THE LAST TEN RUNS, OLDEST FIRST: ONE SQUARE EACH IN ITS STATUS COLOUR, A THIN DIVIDER WHERE A NEW VERSION OF THE CASE STARTS -->
<span class="flex items-center gap-0.5" role="img" aria-label="Last 10 results, oldest first">
	{#each slots as h, i (i)}
		{@const prev = i > 0 ? slots[i - 1] : null}
		{#if h && prev && h.version !== prev.version}
			<span
				class="mx-0.5 h-3.5 w-px bg-muted/60"
				title={`Version ${h.version} starts here`}
				aria-hidden="true"
			></span>
		{/if}
		<span
			class={[
				'shrink-0 rounded-[2px]',
				large ? 'size-3' : 'size-2',
				h ? STATUS_FILL[h.status] : 'bg-line'
			]}
			title={h ? `Run ${h.runNo}: ${STATUS_LABEL[h.status]}` : 'No run'}
		></span>
	{/each}
</span>
