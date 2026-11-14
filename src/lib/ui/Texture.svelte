<script lang="ts">
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		kinds = ['aurora', 'grid', 'paper'],
		contained = false
	}: {
		/** Which layers to draw. The platform default is all three, very quiet. */
		kinds?: ('aurora' | 'grid' | 'paper')[];
		/** Fills its parent instead of the window, for the gallery samples. */
		contained?: boolean;
	} = $props();
</script>

<!-- THE PAGE BACKGROUND. AN AURORA OF SOFT ACCENT GLOWS, A FAINT GRID AND A PAPER GRAIN. DECORATIVE ONLY, SO IT IS HIDDEN FROM SCREEN READERS -->
<div aria-hidden="true" data-testid="texture">
	{#each kinds as k (k)}
		<div class={cn('tex', `tex-${k}`, contained && 'tex-contained')}></div>
	{/each}
</div>
