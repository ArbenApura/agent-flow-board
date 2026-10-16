<script lang="ts">
	// -- DEP-TYPES -- //
	import type { HTMLInputAttributes } from 'svelte/elements';
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		label,
		value = $bindable(''),
		hint,
		error,
		hideLabel = false,
		class: extra,
		...rest
	}: {
		/** A plain question or name a person understands without help. */
		label: string;
		value?: string;
		hint?: string;
		error?: string;
		/** Keeps the label for screen readers and shows the placeholder only, for a search box in a toolbar. */
		hideLabel?: boolean;
		class?: string;
	} & Omit<HTMLInputAttributes, 'class' | 'value'> = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const hintId = `${uid}-hint`;
	const errorId = `${uid}-error`;
</script>

<div class={cn('flex flex-col gap-1.5', extra)}>
	<label for={uid} class={cn('text-xs font-medium text-ink', hideLabel && 'sr-only')}>{label}</label
	>
	<input
		id={uid}
		bind:value
		class={cn(
			'h-10 w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-muted max-sm:h-11',
			'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
			'disabled:cursor-not-allowed disabled:opacity-50',
			error ? 'border-danger' : 'border-line hover:border-muted'
		)}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? errorId : hint ? hintId : undefined}
		{...rest}
	/>
	{#if error}
		<p id={errorId} role="alert" class="text-xs text-danger">{error}</p>
	{:else if hint}
		<p id={hintId} class="text-xs text-muted">{hint}</p>
	{/if}
</div>
