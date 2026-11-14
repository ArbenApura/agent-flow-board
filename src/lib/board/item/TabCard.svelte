<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	// IMPORTED DEP-MODULES
	import { onMount, untrack } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';

	// -- REQUIRED PROPS -- //

	let {
		children,
		title,
		heading,
		meta,
		actions,
		collapsible = false,
		collapsed = $bindable(false),
		startCollapsed = false,
		storageKey,
		padded = false,
		stack = false,
		class: extra,
		...rest
	}: {
		children: Snippet;
		/** The plain title. Use `heading` instead when the title carries more than text. */
		title?: string;
		heading?: Snippet;
		/** Quiet extras after the title: a count, a ring, a badge. */
		meta?: Snippet;
		/** Buttons on the right of the header. */
		actions?: Snippet;
		collapsible?: boolean;
		collapsed?: boolean;
		/** What a card does when nothing is stored yet. It is read once per storage key and never changes because the data did. */
		startCollapsed?: boolean;
		/** Where the person's last choice is kept in this browser, for example `afb:collapse:acme:<item id>:phase-1`; the item id, not its reference, so a rename never splits the choice. */
		storageKey?: string;
		padded?: boolean;
		/** On a phone the header wraps: the title keeps its own width, the meta stays beside it and the actions take a full row under them. */
		stack?: boolean;
		class?: string;
	} & Omit<HTMLAttributes<HTMLDivElement>, 'class'> = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const bodyId = `${uid}-body`;

	// -- STATES -- //

	let seenKey = '';
	// Motion is off while the stored choice is restored on mount, so a card never visibly closes by itself when its tab opens
	let animate = $state(false);

	// -- REACTIVE STATEMENTS -- //

	// The first render is open so the server and the browser agree. Then the stored choice, or the default, is applied once per key.
	$effect(() => {
		const key = storageKey;
		if (!collapsible || !key || key === seenKey) return;
		untrack(() => {
			seenKey = key;
			animate = false;
			let stored: string | null = null;
			try {
				stored = localStorage.getItem(key);
			} catch {
				// Storage can be blocked, so the default is used
			}
			collapsed = stored === 'collapsed' ? true : stored === 'open' ? false : startCollapsed;
			settle();
		});
	});

	// -- FUNCTIONS -- //

	/** Turns motion on once the restored state has been painted, two frames later. */
	function settle() {
		requestAnimationFrame(() => requestAnimationFrame(() => (animate = true)));
	}

	function toggle() {
		collapsed = !collapsed;
		if (!storageKey) return;
		try {
			localStorage.setItem(storageKey, collapsed ? 'collapsed' : 'open');
		} catch {
			// The choice just is not kept
		}
	}

	// -- LIFECYCLES -- //

	onMount(settle);
</script>

<Card
	{...rest}
	{padded}
	headerClass={stack ? 'max-sm:flex-wrap' : undefined}
	class={cn(collapsible && collapsed && '[&>div:first-child]:border-transparent', extra)}
>
	{#snippet header()}
		<h2 class={cn('min-w-0 flex-1 text-lg leading-7 font-semibold', stack && 'max-sm:flex-none')}>
			{#if collapsible}
				<!-- THE WHOLE HEADER IS THE HIT AREA, THE BUTTON KEEPS THE HEADING AS ITS PARENT -->
				<button
					type="button"
					aria-expanded={!collapsed}
					aria-controls={bodyId}
					onclick={toggle}
					class="relative flex w-full cursor-pointer flex-wrap items-center gap-x-2 text-left before:absolute before:inset-x-0 before:-inset-y-3"
				>
					<ChevronDown
						size={16}
						class={cn(
							'shrink-0 text-muted motion-reduce:transition-none',
							animate && 'transition-transform',
							collapsed && '-rotate-90'
						)}
						aria-hidden="true"
					/>
					{#if heading}{@render heading()}{:else}{title}{/if}
				</button>
			{:else if heading}
				{@render heading()}
			{:else}
				{title}
			{/if}
		</h2>
		{#if meta}{@render meta()}{/if}
		{#if actions}<div
				class={cn(
					'ml-auto flex shrink-0 items-center gap-2',
					stack && 'max-sm:ml-0 max-sm:w-full max-sm:[&>*]:flex-1'
				)}
			>
				{@render actions()}
			</div>{/if}
	{/snippet}
	<!-- THE BODY OPENS AND CLOSES BY ANIMATING ITS GRID ROW BETWEEN 0 AND 1 FRACTION, SO THE HEIGHT NEEDS NO MEASURING. A CLOSED BODY IS INVISIBLE AND INERT, SO NOTHING IN IT TAKES FOCUS -->
	<div
		id={bodyId}
		inert={collapsible && collapsed}
		class={cn(
			'grid motion-reduce:transition-none',
			animate && 'transition-[grid-template-rows,visibility] duration-200 ease-out',
			collapsible && collapsed ? 'invisible grid-rows-[0fr]' : 'grid-rows-[1fr]'
		)}
	>
		<div class="min-h-0 overflow-hidden">
			{@render children()}
		</div>
	</div>
</Card>
