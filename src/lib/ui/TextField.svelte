<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component, Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';

	// -- REQUIRED PROPS -- //

	let {
		label,
		value = $bindable(''),
		hint,
		error,
		hideLabel = false,
		icon: Icon,
		labelEnd,
		large = false,
		type = 'text',
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
		/** An icon inside the field, on the left, that says what to type. */
		icon?: Component<{ size?: number; class?: string }>;
		/** Something at the right end of the label row, such as a link to reset a password. */
		labelEnd?: Snippet;
		/** The larger field is for the sign in and sign up pages. */
		large?: boolean;
		class?: string;
	} & Omit<HTMLInputAttributes, 'class' | 'value' | 'size'> = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const hintId = `${uid}-hint`;
	const errorId = `${uid}-error`;

	// -- STATES -- //

	let reveal = $state(false);

	// -- REACTIVE STATES -- //

	const isPassword = $derived(type === 'password');
</script>

<div class={cn('flex flex-col gap-1.5', extra)}>
	<!-- A hidden label row leaves the layout, so it does not push the field down by one gap -->
	<div class={cn('flex items-baseline justify-between gap-3', hideLabel && 'sr-only')}>
		<label for={uid} class="text-xs font-medium text-ink">{label}</label>
		{#if labelEnd}{@render labelEnd()}{/if}
	</div>
	<div class="group relative">
		{#if Icon}
			<Icon
				size={18}
				class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted transition-colors group-focus-within:text-accent-text"
			/>
		{/if}
		<input
			id={uid}
			bind:value
			class={cn(
				'w-full rounded-lg border bg-surface text-sm text-ink shadow-[var(--elev-1)] transition-[border-color,box-shadow] duration-150 placeholder:text-muted',
				'focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none',
				'disabled:cursor-not-allowed disabled:opacity-50',
				large ? 'h-11' : 'h-10 max-sm:h-11',
				Icon ? 'pl-10' : 'pl-3',
				isPassword ? 'pr-11' : 'pr-3',
				error ? 'border-danger focus-visible:ring-danger-soft' : 'border-line hover:border-muted'
			)}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? errorId : hint ? hintId : undefined}
			{...rest}
			type={isPassword && reveal ? 'text' : type}
		/>
		{#if isPassword}
			<button
				type="button"
				class="absolute top-1/2 right-1 inline-flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-sm:size-10"
				aria-label={reveal ? 'Hide what you typed' : 'Reveal what you typed'}
				aria-pressed={reveal}
				data-icon-only
				onclick={() => (reveal = !reveal)}
			>
				{#if reveal}<EyeOff size={18} />{:else}<Eye size={18} />{/if}
			</button>
		{/if}
	</div>
	{#if error}
		<p id={errorId} role="alert" class="text-xs text-danger">{error}</p>
	{:else if hint}
		<p id={hintId} class="text-xs text-muted">{hint}</p>
	{/if}
</div>
