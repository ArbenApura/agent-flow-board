<script lang="ts">
	// IMPORTED DEP-MODULES
	import { onDestroy } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';

	// -- REQUIRED PROPS -- //

	let {
		text,
		label = 'Copy',
		doneLabel = 'Copied',
		variant = 'button',
		size = 'md',
		disabled = false,
		ariaLabel,
		class: extra,
		...rest
	}: {
		/** What goes on the clipboard. A function is read at the moment of the click, for a text that is built on demand. */
		text: string | (() => string);
		label?: string;
		doneLabel?: string;
		/** A plain secondary button with a label, or a small icon-only control that sits inside a field or a row. */
		variant?: 'button' | 'icon';
		size?: 'md' | 'sm';
		disabled?: boolean;
		/** The name of an icon-only control for a screen reader. */
		ariaLabel?: string;
		class?: string;
		'data-testid'?: string;
	} = $props();

	// -- CONSTANTS -- //

	const SHOWN_MS = 2000;

	// -- STATES -- //

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// -- FUNCTIONS -- //

	async function copy() {
		const value = typeof text === 'function' ? text() : text;
		try {
			await navigator.clipboard.writeText(value);
			toast.success('Copied');
		} catch {
			toast.warning('Copy did not work here. Select the text and copy it by hand.');
			return;
		}
		// The button says Copied for two seconds, then goes back to Copy
		copied = true;
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), SHOWN_MS);
	}

	// -- LIFECYCLES -- //

	onDestroy(() => clearTimeout(timer));
</script>

{#if variant === 'icon'}
	<!-- A SMALL ICON ONLY COPY CONTROL FOR A NAME OR A COMMAND. 44 PX ON A PHONE -->
	<button
		type="button"
		{disabled}
		aria-label={copied ? doneLabel : (ariaLabel ?? label)}
		onclick={copy}
		class={cn(
			'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 max-sm:size-11',
			copied && 'text-success hover:text-success',
			extra
		)}
		{...rest}
	>
		{#if copied}<Check size={16} aria-hidden="true" />{:else}<Copy
				size={16}
				aria-hidden="true"
			/>{/if}
	</button>
{:else}
	<Button {size} {disabled} onclick={copy} class={extra} {...rest}>
		{#if copied}
			<span class="inline-flex items-center gap-2 text-success" aria-live="polite">
				<Check size={16} aria-hidden="true" />{doneLabel}
			</span>
		{:else}
			<span class="inline-flex items-center gap-2"
				><Copy size={16} aria-hidden="true" />{label}</span
			>
		{/if}
	</Button>
{/if}
