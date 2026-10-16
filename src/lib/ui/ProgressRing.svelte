<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		value,
		label,
		size = 36,
		class: extra
	}: {
		/** 0 to 100. */
		value: number;
		label: string;
		size?: 28 | 36 | 48;
		class?: string;
	} = $props();

	// -- REACTIVE STATES -- //

	const pct = $derived(Math.max(0, Math.min(100, Math.round(value))));
	const stroke = $derived(size === 48 ? 5 : 4);
	const r = $derived((size - stroke) / 2);
	const c = $derived(2 * Math.PI * r);
</script>

<!-- A RING FOR THE PERCENT OF AN ITEM. THE COLOUR IS A FIXED STATUS TOKEN, NEVER THE ORG ACCENT (ADR-005) -->
<span
	role="progressbar"
	aria-label={label}
	aria-valuemin="0"
	aria-valuemax="100"
	aria-valuenow={pct}
	class={cn('relative inline-flex shrink-0 items-center justify-center', extra)}
	style="width:{size}px;height:{size}px"
>
	<svg width={size} height={size} viewBox="0 0 {size} {size}" class="-rotate-90" aria-hidden="true">
		<circle
			cx={size / 2}
			cy={size / 2}
			{r}
			fill="none"
			stroke="var(--raised)"
			stroke-width={stroke}
		/>
		<circle
			cx={size / 2}
			cy={size / 2}
			{r}
			fill="none"
			stroke={pct === 100 ? 'var(--success)' : 'var(--info)'}
			stroke-width={stroke}
			stroke-linecap="round"
			stroke-dasharray={c}
			stroke-dashoffset={c - (c * pct) / 100}
		/>
	</svg>
	{#if size >= 36}
		<span
			data-count
			class="absolute text-[11px] leading-none font-semibold text-ink tabular-nums"
			aria-hidden="true">{pct}</span
		>
	{/if}
</span>
