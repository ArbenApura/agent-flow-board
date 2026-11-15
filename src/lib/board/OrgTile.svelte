<script lang="ts">
	// IMPORTED TYPES
	import type { OrgPalette } from '#lib/server/db/schema/core.js';
	// IMPORTED MODULES
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
		size?: 20 | 24 | 40 | 96;
	} = $props();

	// -- CONSTANTS -- //

	// Whole class names, Tailwind builds only those. 40 is for the header of a settings page, the same box as an Avatar of 40
	const DIMS = {
		20: { box: 'size-5 min-h-5 max-h-5 min-w-5 max-w-5', text: 'text-[9px]', radius: 'rounded-md' },
		24: {
			box: 'size-6 min-h-6 max-h-6 min-w-6 max-w-6',
			text: 'text-[10px]',
			radius: 'rounded-md'
		},
		40: {
			box: 'size-10 min-h-10 max-h-10 min-w-10 max-w-10',
			text: 'text-sm',
			radius: 'rounded-lg'
		},
		// 96 is the logo in the picture area on a tablet or a phone
		96: {
			box: 'size-24 min-h-24 max-h-24 min-w-24 max-w-24',
			text: 'text-3xl',
			radius: 'rounded-2xl'
		}
	} as const;

	// The tile picks the light or dark value of the organisation accent, and falls back to the page accent when it has no palette
	const TINT =
		'border-[color-mix(in_oklab,var(--tile-accent)_30%,transparent)] bg-(--tile-accent-soft) text-(--tile-accent-text) [--tile-accent-soft:var(--tile-accent-soft-light,var(--accent-soft))] [--tile-accent-text:var(--tile-accent-text-light,var(--accent-text))] [--tile-accent:var(--tile-accent-light,var(--accent))] in-data-[mode=dark]:[--tile-accent-soft:var(--tile-accent-soft-dark,var(--accent-soft))] in-data-[mode=dark]:[--tile-accent-text:var(--tile-accent-text-dark,var(--accent-text))] in-data-[mode=dark]:[--tile-accent:var(--tile-accent-dark,var(--accent))]';

	// -- STATES -- //

	let imgEl = $state<HTMLImageElement>();
	// The measured tone of the logo, remembered with the address it was measured for so a new logo is never judged by the old one
	let measured = $state<{ src: string; tone: 'light' | 'dark' | null } | null>(null);

	// -- REACTIVE STATES -- //

	// A near white logo is inverted on the light page and a near black logo on the dark page, so it never vanishes into the background
	const invertClass = $derived(
		measured && measured.src === logo
			? measured.tone === 'light'
				? 'in-data-[mode=light]:invert'
				: measured.tone === 'dark'
					? 'in-data-[mode=dark]:invert'
					: ''
			: ''
	);

	// -- REACTIVE STATEMENTS -- //

	// Server rendered images can finish loading before the page wakes up, so the load event is missed: measure those here
	$effect(() => {
		void logo;
		if (imgEl?.complete && imgEl.naturalWidth > 0) measureLogo(imgEl);
	});

	// -- FUNCTIONS -- //

	/**
	 * Looks at the pixels of the logo once. Only a logo with a transparent background and a single flat colour (low saturation) that is
	 * almost white or almost black is flagged. A logo with its own background, or any colour, is left exactly as uploaded.
	 */
	function measureLogo(img: HTMLImageElement) {
		if (!logo) return;
		let tone: 'light' | 'dark' | null = null;
		try {
			const SIDE = 32;
			const canvas = document.createElement('canvas');
			canvas.width = SIDE;
			canvas.height = SIDE;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (ctx) {
				ctx.drawImage(img, 0, 0, SIDE, SIDE);
				const { data } = ctx.getImageData(0, 0, SIDE, SIDE);
				let clear = 0;
				let solid = 0;
				let lum = 0;
				let sat = 0;
				for (let i = 0; i < data.length; i += 4) {
					const a = data[i + 3];
					if (a < 16) clear++;
					else if (a >= 128) {
						solid++;
						lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
						sat +=
							Math.max(data[i], data[i + 1], data[i + 2]) -
							Math.min(data[i], data[i + 1], data[i + 2]);
					}
				}
				if (solid > 0 && clear / (SIDE * SIDE) >= 0.1 && sat / solid < 40) {
					const mean = lum / solid;
					if (mean > 205) tone = 'light';
					else if (mean < 50) tone = 'dark';
				}
			}
		} catch {
			// A logo from another origin taints the canvas and cannot be read: leave it as uploaded
			tone = null;
		}
		measured = { src: logo, tone };
	}

	/** Two capital letters: the first letters of the first two words, or the first two letters of a single word. */
	function initialsOf(value: string) {
		const words = value.trim().split(/\s+/).filter(Boolean);
		if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
		return (words[0] ?? '?').slice(0, 2).toUpperCase();
	}
</script>

<!-- THE MARK OF AN ORGANISATION. ITS LOGO WHEN IT HAS ONE, OTHERWISE TWO CAPITAL LETTERS ON A TINT THAT STAYS THE SAME EVERYWHERE -->
{#if logo}
	<img
		bind:this={imgEl}
		src={logo}
		alt=""
		onload={() => imgEl && measureLogo(imgEl)}
		class={cn('shrink-0 object-contain', DIMS[size].box, DIMS[size].radius, invertClass)}
	/>
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
