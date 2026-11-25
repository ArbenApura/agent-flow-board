<script lang="ts">
	// THE READ ONLY PICTURE OF A SCREENSHOT (AFB-20261125-0442, NOTES REMOVED IN AFB-20261125-0625)
	// The Screens tab has its own zoomable viewer in a modal; everywhere else a picture is shown with this.

	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		image,
		alt,
		class: extra
	}: {
		image: string;
		/** What the picture shows, for a screen reader. */
		alt: string;
		class?: string;
	} = $props();

	// -- STATES -- //

	let failed = $state(false);
</script>

{#if failed}
	<p class="text-sm text-muted">The picture could not be loaded.</p>
{:else}
	<div class={cn('w-fit max-w-full leading-[0]', extra)} data-testid="screen-viewer">
		<img
			src={image}
			{alt}
			class="block h-auto max-w-full rounded-lg border border-line"
			loading="lazy"
			onerror={() => (failed = true)}
		/>
	</div>
{/if}
