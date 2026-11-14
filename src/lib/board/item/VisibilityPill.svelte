<script lang="ts">
	// IMPORTED TYPES
	import type { Component } from 'svelte';
	// IMPORTED MODULES
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Globe from '@lucide/svelte/icons/globe';
	import Lock from '@lucide/svelte/icons/lock';
	// IMPORTED COMPONENTS
	import Popover from '#lib/ui/Popover.svelte';

	// -- REQUIRED PROPS -- //

	let {
		visibility,
		canChange,
		onchange
	}: {
		visibility: 'public' | 'private';
		/** True only for the person who made the item. The server decides, the page never compares ids. */
		canChange: boolean;
		/** Saves the new value. A rejection puts the pill back. */
		onchange: (next: 'public' | 'private') => Promise<void>;
	} = $props();

	// -- TYPES -- //

	type Visibility = 'public' | 'private';

	// -- CONSTANTS -- //

	const PILL =
		'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-sans text-badge font-semibold';
	const TONE: Record<Visibility, string> = {
		private: 'bg-danger-soft text-danger',
		public: 'bg-ink/10 text-ink'
	};
	// A see-through tint hovers on the item header, which is tinted by the organisation colour, where a solid grey would clash
	const HOVER: Record<Visibility, string> = {
		private: 'hover:bg-danger/20',
		public: 'hover:bg-ink/15'
	};
	const OPTIONS: {
		value: Visibility;
		icon: Component<{ size?: number; class?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
		title: string;
		text: string;
	}[] = [
		{ value: 'private', icon: Lock, title: 'Private', text: 'Only you can see this item.' },
		{
			value: 'public',
			icon: Globe,
			title: 'Public',
			text: 'Everyone with access to this project can see it.'
		}
	];

	// -- STATES -- //

	let open = $state(false);
	/** The value the person picked, shown at once while the save runs. */
	let pending = $state<Visibility | null>(null);

	// -- REACTIVE STATES -- //

	const current = $derived(pending ?? visibility);
	const shown = $derived(OPTIONS.find((o) => o.value === current) ?? OPTIONS[0]);

	// -- FUNCTIONS -- //

	async function pick(next: Visibility) {
		open = false;
		if (next === current) return;
		// Showing an item to the whole project cannot be taken back for people who already saw it, so it asks first
		if (
			next === 'public' &&
			!(await askConfirm({
				title: 'Make this item public?',
				body: 'Everyone with access to this project will be able to see it. You can make it private again at any time.',
				confirmLabel: 'Make public'
			}))
		)
			return;
		pending = next;
		try {
			await onchange(next);
		} catch {
			// The caller shows the failure, and the pill goes back to the saved value
		} finally {
			pending = null;
		}
	}
</script>

{#if canChange}
	<Popover bind:open role="menu" label="Who can see this item" placement="bottom-start">
		{#snippet trigger({ props, toggle })}
			<button
				type="button"
				onclick={toggle}
				{...props}
				data-testid="visibility-pill"
				class={cn(
					PILL,
					TONE[current],
					HOVER[current],
					'relative cursor-pointer transition-colors before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[""] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none max-sm:before:-inset-y-3.5'
				)}
			>
				<shown.icon size={14} aria-hidden="true" />
				{shown.title}
				<ChevronDown size={12} aria-hidden="true" />
			</button>
		{/snippet}
		<div role="presentation" class="w-72 max-w-[calc(100vw-32px)]">
			{#each OPTIONS as o (o.value)}
				<button
					type="button"
					role="menuitemradio"
					aria-checked={o.value === current}
					onclick={() => pick(o.value)}
					class="flex min-h-11 w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
				>
					<o.icon size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
					<span class="flex min-w-0 flex-1 flex-col">
						<span class="font-medium text-ink">{o.title}</span>
						<span class="text-muted">{o.text}</span>
					</span>
					{#if o.value === current}
						<Check size={16} class="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
					{/if}
				</button>
			{/each}
		</div>
	</Popover>
{:else}
	<!-- EVERYONE ELSE SEES THE STATE ONLY. THE TITLE AND THE HIDDEN TEXT SAY WHY IT CANNOT BE CHANGED -->
	<span
		class={cn(PILL, TONE[current])}
		title="Only the person who created this item can change this."
		data-testid="visibility-pill"
	>
		<shown.icon size={14} aria-hidden="true" />
		{shown.title}
		<span class="sr-only">. Only the person who created this item can change this.</span>
	</span>
{/if}
