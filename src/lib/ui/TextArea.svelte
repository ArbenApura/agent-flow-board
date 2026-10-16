<script lang="ts">
	// -- DEP-TYPES -- //
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		label,
		value = $bindable(''),
		hint,
		error,
		rows = 4,
		class: extra,
		...rest
	}: {
		label: string;
		value?: string;
		hint?: string;
		error?: string;
		class?: string;
	} & Omit<HTMLTextareaAttributes, 'class' | 'value'> = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const hintId = `${uid}-hint`;
	const errorId = `${uid}-error`;
</script>

<div class={cn('flex flex-col gap-1', extra)}>
	<label for={uid} class="text-xs leading-4 font-medium text-muted">{label}</label>
	<textarea
		id={uid}
		bind:value
		{rows}
		class={cn(
			'w-full rounded-lg border bg-bg px-3 py-2.5 text-sm leading-5 text-ink placeholder:text-muted',
			'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
			'disabled:cursor-not-allowed disabled:opacity-50',
			error ? 'border-danger' : 'border-line'
		)}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? errorId : hint ? hintId : undefined}
		{...rest}></textarea>
	{#if error}
		<p id={errorId} role="alert" class="text-xs leading-4 text-danger">{error}</p>
	{:else if hint}
		<p id={hintId} class="text-xs leading-4 text-muted">{hint}</p>
	{/if}
</div>
