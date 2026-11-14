<script lang="ts">
	// IMPORTED TYPES
	import type { Palette } from '#lib/theme/palette.js';
	// IMPORTED MODULES
	import { paletteStyle } from '#lib/theme/palette.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		mode,
		palette = null,
		class: extra,
		...rest
	}: {
		mode: 'light' | 'dark';
		/** A generated palette. Without one the preview uses the default accent. Never a raw colour string. */
		palette?: Palette | null;
		class?: string;
		'data-testid'?: string;
	} = $props();
</script>

<!-- A SMALL DRAWING OF THE APP IN ONE MODE. IT CARRIES ITS OWN data-mode, SO THE TOKENS OF THAT MODE APPLY INSIDE IT WHATEVER MODE THE PAGE IS IN -->
<!-- THE ORGANISATION PALETTE IS A RUNTIME VALUE, SO IT IS SET INLINE AS THE ACCENT VARIABLES. THE REST OF THE DRAWING IS TOKEN CLASSES -->
<div
	data-mode={mode}
	style={palette ? paletteStyle(palette, mode) : undefined}
	class={cn(
		'pointer-events-none flex h-24 w-full overflow-hidden rounded-lg border border-line bg-bg text-ink',
		extra
	)}
	aria-hidden="true"
	{...rest}
>
	<!-- THE RAIL -->
	<div class="flex w-8 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-surface py-2">
		<span class="size-3.5 rounded-[4px] bg-accent-soft"></span>
		<span class="size-3.5 rounded-[4px] bg-raised"></span>
		<span class="size-3.5 rounded-[4px] bg-raised"></span>
	</div>
	<!-- THE PAGE -->
	<div class="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
		<div class="flex items-center justify-between">
			<span class="h-2 w-1/3 rounded-full bg-ink/70"></span>
			<span class="h-2 w-8 rounded-full bg-accent"></span>
		</div>
		<div
			class="flex flex-1 flex-col justify-center gap-1.5 rounded-md border border-line bg-surface p-1.5"
		>
			<span class="h-1.5 w-3/4 rounded-full bg-raised"></span>
			<span class="h-1.5 w-full overflow-hidden rounded-full bg-raised"
				><span class="block h-full w-2/3 rounded-full bg-accent"></span></span
			>
			<span class="h-1.5 w-8 rounded-full bg-accent-soft"></span>
		</div>
	</div>
</div>
