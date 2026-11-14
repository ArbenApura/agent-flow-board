<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	// IMPORTED MODULES
	import { ripple } from '#lib/actions/ripple.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	// -- TYPES -- //

	type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';
	// The danger tone turns the text of a quiet button red, for destructive actions
	type Tone = 'default' | 'danger';
	type Props = {
		children: Snippet;
		variant?: Variant;
		tone?: Tone;
		size?: 'md' | 'sm';
		/** Icon only buttons need an aria-label and are 44 by 44. */
		iconOnly?: boolean;
		loading?: boolean;
		href?: string;
		class?: string;
	} & Omit<HTMLButtonAttributes, 'class'> &
		Omit<HTMLAnchorAttributes, 'class' | 'type'>;

	// -- REQUIRED PROPS -- //

	let {
		children,
		variant = 'secondary',
		tone = 'default',
		size = 'md',
		iconOnly = false,
		loading = false,
		href,
		class: extra,
		disabled,
		type = 'button',
		...rest
	}: Props = $props();

	// -- CONSTANTS -- //

	const VARIANTS: Record<Variant, string> = {
		primary:
			'primary border-accent bg-accent text-accent-ink hover:brightness-95 focus-visible:outline-accent',
		// The quiet variants take their text colour from the tone (see QUIET below), so a danger tone never races a text-ink class
		secondary: 'border-line bg-surface hover:bg-raised',
		// A visible edge and a light tint on hover, so it reads as a button on both surfaces
		ghost: 'border-line bg-transparent hover:bg-ink/10',
		// A see-through tint of the ink token, so it reads on a plain or a tinted surface. Stays on while a menu it opened is showing.
		subtle:
			'border-transparent bg-transparent transition-colors hover:bg-ink/10 aria-expanded:bg-ink/10 motion-reduce:transition-none',
		danger: 'border-danger bg-danger text-surface hover:brightness-95'
	};

	const QUIET = new Set<Variant>(['secondary', 'ghost', 'subtle']);

	// -- REACTIVE STATES -- //

	const off = $derived(disabled || loading);
	const quietInk = $derived(
		QUIET.has(variant) ? (tone === 'danger' ? 'text-danger' : 'text-ink') : ''
	);
	const classes = $derived(
		cn(
			'press relative inline-flex cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg border text-sm font-medium whitespace-nowrap select-none',
			'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
			'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
			iconOnly
				? size === 'sm'
					? 'size-8 p-0 max-sm:size-11'
					: 'size-10 p-0 max-sm:size-11'
				: size === 'sm'
					? 'h-8 px-3 max-sm:h-11'
					: 'h-10 px-4 max-sm:h-11',
			VARIANTS[variant],
			quietInk,
			extra
		)
	);
</script>

{#if href && !off}
	<!-- The caller passes a link that is already resolved -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a
		{href}
		class={classes}
		data-variant={variant}
		data-icon-only={iconOnly ? '' : undefined}
		use:ripple
		{...rest as HTMLAnchorAttributes}
	>
		{@render children()}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
	<button
		{type}
		class={classes}
		disabled={off}
		aria-busy={loading || undefined}
		data-variant={variant}
		data-icon-only={iconOnly ? '' : undefined}
		use:ripple={{ disabled: off }}
		{...rest as HTMLButtonAttributes}
	>
		{#if loading}<LoaderCircle size={16} class="animate-spin" aria-hidden="true" />{/if}
		{@render children()}
	</button>
{/if}
