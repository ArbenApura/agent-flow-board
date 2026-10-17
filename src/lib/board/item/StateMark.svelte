<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Minus from '@lucide/svelte/icons/minus';

	// -- REQUIRED PROPS -- //

	let {
		state,
		label,
		disabled = false,
		saving = false,
		onclick,
		class: extra
	}: {
		/** open, done, waived or superseded. Anything else is drawn as open. */
		state: string;
		/** The accessible name, the step key and its text. */
		label: string;
		disabled?: boolean;
		/** A save is in flight: the box turns into a spinner and ignores clicks. */
		saving?: boolean;
		onclick?: () => void;
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	// A 44 px touch target around the 20 px box, without growing the row
	const BOX =
		'relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-[1.5px] before:absolute before:-inset-3 disabled:cursor-not-allowed';
	const LOOK: Record<string, string> = {
		open: 'border-muted bg-surface hover:border-ink disabled:hover:border-muted',
		done: 'border-success bg-success-soft text-success',
		waived: 'border-warning bg-warning-soft text-warning',
		superseded: 'border-muted bg-raised text-muted'
	};
</script>

<!-- THE STATE OF ONE STEP OR CHECK. THE STATUS COLOURS ARE FIXED TOKENS, NEVER THE ORG ACCENT -->
<button
	type="button"
	role="checkbox"
	aria-checked={state === 'done'}
	aria-label={label}
	aria-busy={saving}
	disabled={disabled || saving}
	{onclick}
	class={cn(
		BOX,
		saving ? 'border-transparent bg-transparent text-muted' : (LOOK[state] ?? LOOK.open),
		(saving || state !== 'open') && 'disabled:opacity-100',
		extra
	)}
>
	{#if saving}
		<LoaderCircle size={18} strokeWidth={2.5} class="animate-spin" aria-hidden="true" />
	{:else if state === 'done'}
		<Check size={14} strokeWidth={3} aria-hidden="true" />
	{:else if state === 'waived' || state === 'superseded'}
		<Minus size={14} strokeWidth={3} aria-hidden="true" />
	{/if}
</button>
