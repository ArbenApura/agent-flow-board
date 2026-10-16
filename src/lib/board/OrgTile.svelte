<script lang="ts">
	// -- TYPES -- //
	import type { OrgPalette } from '#lib/server/db/schema/core.js';
	// -- MODULES -- //
	import { tileStyle } from '#lib/theme/css.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		name,
		logo,
		palette,
		size = 24
	}: {
		name: string;
		logo?: string | null;
		/** The accent of this organisation. Without one the tile uses the page accent. */
		palette?: OrgPalette | null;
		size?: 20 | 24 | 40;
	} = $props();

	// -- CONSTANTS -- //

	// Whole class names, Tailwind builds only those. 40 is for the header of a settings page, the same box as an Avatar of 40
	const DIMS = {
		20: { box: 'size-5', text: 'text-[9px]', radius: 'rounded-md' },
		24: { box: 'size-6', text: 'text-[10px]', radius: 'rounded-md' },
		40: { box: 'size-10', text: 'text-sm', radius: 'rounded-lg' }
	} as const;

	// The tile picks the light or dark value of the organisation accent, and falls back to the page accent when it has no palette
	const TINT =
		'border-[color-mix(in_oklab,var(--tile-accent)_30%,transparent)] bg-(--tile-accent-soft) text-(--tile-accent-text) [--tile-accent-soft:var(--tile-accent-soft-light,var(--accent-soft))] [--tile-accent-text:var(--tile-accent-text-light,var(--accent-text))] [--tile-accent:var(--tile-accent-light,var(--accent))] in-data-[mode=dark]:[--tile-accent-soft:var(--tile-accent-soft-dark,var(--accent-soft))] in-data-[mode=dark]:[--tile-accent-text:var(--tile-accent-text-dark,var(--accent-text))] in-data-[mode=dark]:[--tile-accent:var(--tile-accent-dark,var(--accent))]';

	// -- FUNCTIONS -- //

	/** Two capital letters: the first letters of the first two words, or the first two letters of a single word. */
	function initialsOf(value: string) {
		const words = value.trim().split(/\s+/).filter(Boolean);
		if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
		return (words[0] ?? '?').slice(0, 2).toUpperCase();
	}
</script>

<!-- THE MARK OF AN ORGANISATION. ITS LOGO WHEN IT HAS ONE, OTHERWISE TWO CAPITAL LETTERS ON A TINT THAT STAYS THE SAME EVERYWHERE -->
{#if logo}
	<img src={logo} alt="" class={cn('shrink-0 object-contain', DIMS[size].box, DIMS[size].radius)} />
{:else}
	<span
		class={cn(
			'inline-flex shrink-0 items-center justify-center border font-semibold',
			DIMS[size].box,
			DIMS[size].text,
			DIMS[size].radius,
			TINT
		)}
		style={tileStyle(palette) || undefined}
		aria-hidden="true">{initialsOf(name)}</span
	>
{/if}
