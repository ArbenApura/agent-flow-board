<script lang="ts">
	// IMPORTED MODULES
	import Mark from '#lib/ui/Mark.svelte';

	// -- OPTIONAL PROPS -- //

	let { size = 32, class: extra }: { size?: number; class?: string } = $props();
</script>

<!-- THE LOGO LOCKUP: THE MARK, THEN THE NAME SET AT THE FONT'S LARGEST OPTICAL SIZE. THE MIDDLE WORD CARRIES AN ACCENT GRADIENT AND A HAND DRAWN WAVE. ON LOAD THE MARK AND THE WAVE DRAW THEMSELVES, THEN THE WAVE BREATHES (app.css, UNDER NO REDUCED MOTION) -->
<span class="logo-live inline-flex items-center gap-3 {extra ?? ''}">
	<Mark {size} />
	<span
		class="logo-word inline-flex items-baseline gap-[0.3em] font-display leading-none tracking-[-0.035em] whitespace-nowrap [font-variation-settings:'opsz'_96]"
	>
		<span class="font-semibold text-ink">Agent</span>
		<span class="relative font-bold">
			<span
				class="logo-flow bg-gradient-to-r from-accent to-accent-text bg-clip-text tracking-[-0.045em] text-transparent"
				>Flow</span
			>
			<svg
				viewBox="0 0 60 12"
				fill="none"
				preserveAspectRatio="none"
				aria-hidden="true"
				class="logo-wave absolute inset-x-0 -bottom-[0.36em] h-[0.36em] w-full overflow-visible"
			>
				<path
					pathLength="1"
					d="M2 6q7.5-5 15 0t15 0t15 0t11 0"
					stroke="var(--accent)"
					stroke-width="2.4"
					stroke-linecap="round"
				/>
			</svg>
		</span>
		<span class="font-semibold text-ink">Board</span>
	</span>
</span>
