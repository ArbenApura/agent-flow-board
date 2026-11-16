<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Info from '@lucide/svelte/icons/info';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	// -- TYPES -- //

	type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'running';

	// -- REQUIRED PROPS -- //

	let {
		children,
		tone = 'neutral',
		icon = false,
		class: extra,
		'data-testid': testid
	}: {
		children: Snippet;
		tone?: Tone;
		icon?: boolean;
		class?: string;
		'data-testid'?: string;
	} = $props();

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
	data-testid={testid}
	class={cn(
		'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-badge font-semibold',
		TONES[tone],
		extra
	)}
>
	<!-- STATUS ICON -->
	<!-- A small glyph that says what the status means, in place of a bare dot -->
	{#if tone === 'running'}
		<LoaderCircle size={13} class="shrink-0 motion-safe:animate-spin" aria-hidden="true" />
	{:else if icon && tone === 'success'}
		<CircleCheck size={13} class="shrink-0" aria-hidden="true" />
	{:else if icon && tone === 'warning'}
		<TriangleAlert size={13} class="shrink-0" aria-hidden="true" />
	{:else if icon && tone === 'danger'}
		<CircleX size={13} class="shrink-0" aria-hidden="true" />
	{:else if icon && (tone === 'info' || tone === 'accent')}
		<Info size={13} class="shrink-0" aria-hidden="true" />
	{/if}
	{@render children()}
</span>
