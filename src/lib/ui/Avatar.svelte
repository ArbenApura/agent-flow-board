<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		name,
		src,
		size = 32,
		kind = 'person',
		class: extra
	}: {
		name: string;
		src?: string | null;
		size?: 24 | 32 | 40;
		/** An agent tool shows a square mark, a person a circle. */
		kind?: 'person' | 'agent';
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	const DIMS = { 24: 'size-6 text-[10px]', 32: 'size-8 text-xs', 40: 'size-10 text-sm' } as const;

	// -- REACTIVE STATES -- //

	const initials = $derived(
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((p) => p[0]?.toUpperCase() ?? '')
			.join('') || '?'
	);
	const dim = $derived(DIMS[size]);
</script>

{#if src}
	<img
		{src}
		alt=""
		class={cn(
			'shrink-0 object-cover',
			kind === 'agent' ? 'rounded-md' : 'rounded-full',
			dim,
			extra
		)}
	/>
{:else}
	<span
		class={cn(
			'inline-flex shrink-0 items-center justify-center bg-accent-soft font-semibold text-accent-text select-none',
			kind === 'agent' ? 'rounded-md' : 'rounded-full',
			dim,
			extra
		)}
		role="img"
		aria-label={name}
	>
		{initials}
	</span>
{/if}
