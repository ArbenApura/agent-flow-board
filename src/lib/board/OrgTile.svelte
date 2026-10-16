<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		name,
		slug,
		logo,
		size = 24
	}: {
		name: string;
		slug: string;
		logo?: string | null;
		size?: 20 | 24;
	} = $props();

	// -- CONSTANTS -- //

	// Four tints from the theme, so two organisations side by side rarely look alike. Whole class names, Tailwind builds only those
	const TINTS = [
		'border-accent/30 bg-accent/12 text-accent-text',
		'border-info/30 bg-info/12 text-info',
		'border-success/30 bg-success/12 text-success',
		'border-warning/30 bg-warning/12 text-warning'
	];

	// -- FUNCTIONS -- //

	/** A steady pick from the address, so an organisation keeps its colour everywhere. */
	function tintOf(value: string) {
		let h = 0;
		for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
		return TINTS[h % TINTS.length];
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
		src={logo}
		alt=""
		class={cn('shrink-0 rounded-md object-contain', size === 20 ? 'size-5' : 'size-6')}
	/>
{:else}
	<span
		class={cn(
			'inline-flex shrink-0 items-center justify-center rounded-md border font-semibold',
			size === 20 ? 'size-5 text-[9px]' : 'size-6 text-[10px]',
			tintOf(slug)
		)}
		aria-hidden="true">{initialsOf(name)}</span
	>
{/if}
