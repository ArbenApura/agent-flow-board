<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		values,
		labels,
		label,
		class: extra
	}: {
		/** One number per step, oldest first. */
		values: number[];
		/** One label per value, for the text alternative table. */
		labels?: string[];
		/** What the line shows, read by a screen reader with the numbers. */
		label: string;
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	const W = 240;
	const H = 48;
	const PAD = 4;

	// -- REACTIVE STATES -- //

	const max = $derived(Math.max(1, ...values));
	const points = $derived(
		values.map((v, i) => {
			const x = values.length < 2 ? W / 2 : PAD + (i * (W - PAD * 2)) / (values.length - 1);
			const y = H - PAD - (v / max) * (H - PAD * 2);
			return [x, y] as const;
		})
	);
	const line = $derived(points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
	const area = $derived(
		points.length
			? `${PAD},${H - PAD} ${line} ${points[points.length - 1][0].toFixed(1)},${H - PAD}`
			: ''
	);
	const summary = $derived(
		`${label}: ${values.map((v, i) => `${labels?.[i] ?? i + 1} ${v}`).join(', ')}.`
	);
</script>

<!-- A SPARKLINE BUILT BY HAND AS INLINE SVG. THE NUMBERS ARE IN THE TITLE FOR A SCREEN READER -->
<svg
	viewBox={`0 0 ${W} ${H}`}
	class={cn('h-12 w-full text-accent', extra)}
	role="img"
	aria-label={summary}
	data-testid="sparkline"
>
	<polygon points={area} fill="currentColor" opacity="0.12" />
	<polyline
		points={line}
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linejoin="round"
		stroke-linecap="round"
	/>
	{#if points.length}
		<circle
			cx={points[points.length - 1][0]}
			cy={points[points.length - 1][1]}
			r="3"
			fill="currentColor"
		/>
	{/if}
</svg>
