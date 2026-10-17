<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		value,
		label,
		fill = 'bg-accent',
		class: extra
	}: {
		/** 0 to 100. */
		value: number;
		label: string;
		/** A background class for the filled part. Defaults to the accent. */
		fill?: string;
		class?: string;
	} = $props();

	// -- REACTIVE STATES -- //

	const pct = $derived(Math.max(0, Math.min(100, Math.round(value))));
</script>

<!-- A THIN TRACK WITH THE DONE PART FILLED, FOR THE PERCENT OF AN ITEM -->
<div
	role="progressbar"
	aria-label={label}
	aria-valuemin="0"
	aria-valuemax="100"
	aria-valuenow={pct}
	class={cn('h-1.5 w-full overflow-hidden rounded-full bg-raised', extra)}
>
	<!-- DYNAMIC RUNTIME WIDTH -->
	<div class={cn('h-full rounded-full', fill)} style="width:{pct}%"></div>
</div>
