<script lang="ts">
	// -- REQUIRED PROPS -- //

	let { label }: { label: string } = $props();
</script>

<!-- THE HEADING OF A LIST IN A SIDEBAR. THE TEXT FADES OUT IN THE SLIM RAIL AND A THIN LINE FADES IN IN ITS PLACE, SO THE LIST STAYS SET APART -->
<div class="relative h-5 shrink-0">
	<p
		class="px-[11px] text-xs leading-5 font-medium tracking-wide whitespace-nowrap text-muted uppercase transition-opacity duration-150 motion-reduce:transition-none side-collapsed:opacity-0"
	>
		{label}
	</p>
	<span
		class="absolute inset-x-2 top-1/2 h-px bg-line opacity-0 transition-opacity duration-150 motion-reduce:transition-none side-collapsed:opacity-100"
		aria-hidden="true"
	></span>
</div>
