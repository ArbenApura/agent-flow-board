<script lang="ts">
	// THE READ ONLY PICTURE OF A SCREENSHOT WITH ITS NOTES DRAWN OVER IT (AFB-20261125-0442)
	// The Screens tab keeps its own stage, because there the notes are drawn and moved; everywhere else a picture is shown with this.

	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		image,
		alt,
		annotations = [],
		class: extra
	}: {
		image: string;
		/** What the picture shows, for a screen reader. */
		alt: string;
		/** Fractions of the picture, 0 to 1, as the Screens tab stores them. */
		annotations?: { kind: string; x: number; y: number; w: number | null; h: number | null }[];
		class?: string;
	} = $props();

	// -- STATES -- //

	let failed = $state(false);
</script>

{#if failed}
	<p class="text-sm text-muted">The picture could not be loaded.</p>
{:else}
	<!-- THE WRAPPER IS EXACTLY THE SIZE OF THE RENDERED PICTURE, SO THE NOTES STAY ON THEIR PLACE AT EVERY WIDTH -->
	<div class={cn('relative w-fit max-w-full leading-[0]', extra)} data-testid="screen-viewer">
		<img
			src={image}
			{alt}
			class="block h-auto max-w-full rounded-lg border border-line"
			loading="lazy"
			onerror={() => (failed = true)}
		/>
		<svg
			class="pointer-events-none absolute inset-0 size-full"
			viewBox="0 0 1 1"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			{#each annotations as n, i (i)}
				{#if n.kind === 'box'}
					<rect
						x={n.x}
						y={n.y}
						width={n.w ?? 0}
						height={n.h ?? 0}
						stroke-width="2"
						class="fill-transparent stroke-danger [vector-effect:non-scaling-stroke]"
					/>
				{:else if n.kind === 'arrow'}
					<line
						x1={n.x}
						y1={n.y}
						x2={n.x + (n.w ?? 0)}
						y2={n.y + (n.h ?? 0)}
						stroke-width="2"
						class="stroke-danger [vector-effect:non-scaling-stroke]"
					/>
				{/if}
			{/each}
		</svg>
		<!-- THE NUMBERED MARKER OF EACH NOTE. ITS PLACE IS A RUNTIME PERCENT OF THE PICTURE -->
		{#each annotations as n, i (i)}
			<span
				class="pointer-events-none absolute grid size-[26px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-danger bg-surface text-xs leading-none font-semibold text-danger tabular-nums"
				style="left: {n.x * 100}%; top: {n.y * 100}%;"
				aria-hidden="true">{i + 1}</span
			>
		{/each}
	</div>
{/if}
