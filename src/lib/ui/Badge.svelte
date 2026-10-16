<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- TYPES -- //

	type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'running';

	// -- REQUIRED PROPS -- //

	let {
		children,
		tone = 'neutral',
		dot = false,
		class: extra
	}: { children: Snippet; tone?: Tone; dot?: boolean; class?: string } = $props();

	// -- CONSTANTS -- //

	const TONES: Record<Tone, string> = {
		neutral: 'bg-raised text-ink',
		accent: 'bg-accent-soft text-accent-text',
		running: 'bg-accent-soft text-accent-text',
		success: 'bg-success-soft text-success',
		warning: 'bg-warning-soft text-warning',
		danger: 'bg-danger-soft text-danger',
		info: 'bg-info-soft text-info'
	};
</script>

<span
	data-badge
	class={cn(
		'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-badge font-semibold',
		TONES[tone],
		extra
	)}
>
	{#if dot || tone === 'running'}
		<span
			class={cn(
				'size-[7px] rounded-full bg-current',
				tone === 'running' && 'motion-safe:animate-pulse'
			)}
			aria-hidden="true"
		></span>
	{/if}
	{@render children()}
</span>
