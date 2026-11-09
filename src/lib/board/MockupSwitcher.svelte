<script lang="ts">
	// -- DEP-MODULES -- //
	import { MediaQuery } from 'svelte/reactivity';
	// -- MODULES -- //
	import { roundIndex, switchIsPicker } from '#lib/board/mockups.js';
	import Popover from '#lib/ui/Popover.svelte';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	// -- REQUIRED PROPS -- //

	let {
		items,
		current,
		hrefOf
	}: {
		/** The mockups of one plan, in the order the plan lists them. Every id is unique. */
		items: { id: string; title: string; currentVersion: number }[];
		/** The id of the mockup on show. */
		current: string;
		/** The address of one mockup of the list. Every control here is a link, so the address and the back button follow the choice. */
		hrefOf: (id: string) => string;
	} = $props();

	// -- CONSTANTS -- //

	/** Below the sm breakpoint of Tailwind. A phone always gets the picker: the titles are long and the row is narrow. */
	const phone = new MediaQuery('max-width: 639px');

	// -- STATES -- //

	let track = $state<HTMLElement>();
	let open = $state(false);
	let fadeLeft = $state(false);
	let fadeRight = $state(false);

	// -- REACTIVE STATES -- //

	const place = $derived(
		Math.max(
			0,
			items.findIndex((s) => s.id === current)
		)
	);
	const here = $derived(items[place]);
	const asPicker = $derived(switchIsPicker(items.length, phone.current));
	const previous = $derived(items[roundIndex(place, -1, items.length)]);
	const next = $derived(items[roundIndex(place, 1, items.length)]);

	// -- FUNCTIONS -- //

	// Edge fades show only on the side that has more chips to scroll to
	function measure() {
		const row = track;
		if (!row) return;
		fadeLeft = row.scrollLeft > 2;
		fadeRight = row.scrollLeft + row.clientWidth < row.scrollWidth - 2;
	}

	// -- REACTIVE STATEMENTS -- //

	// The current chip slides to the centre of its row on a change and on first load. The row scrolls itself, never the page
	$effect(() => {
		void current;
		void items.length;
		const row = track;
		const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!row || !active) return;
		const left =
			active.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - active.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});

	$effect(() => {
		const row = track;
		if (!row) return;
		measure();
		const watch = new ResizeObserver(measure);
		watch.observe(row);
		return () => watch.disconnect();
	});
</script>

<!-- THE SWITCH BETWEEN THE MOCKUPS OF A PLAN: ONE ROW, THE SAME WIDTH AS THE CARDS AROUND IT. A RAISED TRACK OF CHIPS UP TO FIVE MOCKUPS, ONE PICKER FROM SIX AND ON A PHONE, AND THE SAME PREVIOUS AND NEXT PAIR IN BOTH -->
<nav
	aria-label="Mockups of this plan"
	class="flex items-center gap-3 max-sm:gap-2"
	data-testid="mockup-siblings"
>
	{#if asPicker && here}
		<div class="max-w-[640px] min-w-0 flex-1">
			<Popover bind:open matchWidth label="Mockups of this plan" anchorClass="flex w-full min-w-0">
				{#snippet trigger({ props, toggle })}
					<button
						type="button"
						{...props}
						onclick={toggle}
						aria-label="Mockups of this plan"
						data-testid="mockup-picker"
						class={cn(
							'flex h-14 w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border bg-surface py-1.5 pr-3.5 pl-4 text-left text-[15px] font-medium shadow-[var(--elev-1)] transition-[border-color] duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-sm:pr-3 max-sm:pl-3.5',
							open ? 'border-accent' : 'border-line'
						)}
					>
						<span
							class="min-w-0 flex-1 truncate text-ink max-sm:line-clamp-2 max-sm:leading-5 max-sm:whitespace-normal"
							>{here.title}</span
						>
						<span class="shrink-0 font-mono text-xs text-muted">v{here.currentVersion}</span>
						<ChevronDown size={16} class="shrink-0 text-muted" aria-hidden="true" />
					</button>
				{/snippet}
				{#snippet children({ close })}
					{#each items as m (m.id)}
						{@const on = m.id === current}
						<a
							href={hrefOf(m.id)}
							data-sveltekit-noscroll
							aria-current={on ? 'page' : undefined}
							onclick={close}
							class={cn(
								'flex min-h-12 cursor-pointer items-center gap-3 rounded-md py-1.5 pr-3 pl-3 text-[15px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-sm:min-h-14',
								on ? 'bg-accent-soft font-semibold text-accent-text' : 'text-ink hover:bg-raised'
							)}
						>
							<span
								class="min-w-0 flex-1 truncate max-sm:line-clamp-2 max-sm:leading-5 max-sm:whitespace-normal"
								>{m.title}</span
							>
							<span class={cn('shrink-0 font-mono text-xs', on ? 'text-accent-text' : 'text-muted')}
								>v{m.currentVersion}</span
							>
							{#if on}<Check size={16} class="shrink-0" aria-hidden="true" />{/if}
						</a>
					{/each}
				{/snippet}
			</Popover>
		</div>
	{:else}
		<div
			bind:this={track}
			onscroll={measure}
			class={cn(
				'flex h-14 min-w-0 flex-1 [scrollbar-width:none]! gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-lg border border-line bg-raised p-1 [&::-webkit-scrollbar]:hidden',
				// THE FADE IS A MASK, WHICH READS ONLY THE ALPHA OF THE TOKEN, SO IT CANNOT CARRY A COLOUR. TWO EDGE STOPS, ONE OR BOTH
				fadeLeft &&
					fadeRight &&
					'[mask-image:linear-gradient(to_right,transparent_0,var(--ink)_28px,var(--ink)_calc(100%_-_28px),transparent_100%)]',
				fadeLeft &&
					!fadeRight &&
					'[mask-image:linear-gradient(to_right,transparent_0,var(--ink)_28px)]',
				!fadeLeft &&
					fadeRight &&
					'[mask-image:linear-gradient(to_left,transparent_0,var(--ink)_28px)]'
			)}
		>
			{#each items as m (m.id)}
				{@const on = m.id === current}
				<a
					href={hrefOf(m.id)}
					data-sveltekit-noscroll
					aria-current={on ? 'page' : undefined}
					class={cn(
						'flex h-full max-w-[420px] shrink-0 cursor-pointer items-center gap-3 rounded-md px-4 text-[15px] font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
						on
							? 'bg-surface text-ink shadow-[0_0_0_1px_var(--line),var(--elev-1)]'
							: 'text-muted hover:bg-surface/55 hover:text-ink'
					)}
				>
					<span class="min-w-0 truncate">{m.title}</span>
					<span class={cn('shrink-0 font-mono text-xs', on ? 'text-accent-text' : 'text-muted')}
						>v{m.currentVersion}</span
					>
				</a>
			{/each}
		</div>
	{/if}

	<!-- PREVIOUS AND NEXT: ONE JOINED PAIR, THE HEIGHT OF THE TRACK. BOTH GO ROUND AT THE ENDS -->
	<div class="flex shrink-0 items-center gap-3">
		<span class="text-[13px] leading-5 text-muted tabular-nums max-lg:hidden"
			>Mockup {place + 1} of {items.length}</span
		>
		<div
			class="inline-flex h-14 overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--elev-1)]"
		>
			<a
				href={hrefOf(previous.id)}
				data-sveltekit-noscroll
				aria-label="Previous mockup of this plan"
				class="grid w-12 cursor-pointer place-items-center text-ink hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
				><ChevronLeft size={20} aria-hidden="true" /></a
			>
			<a
				href={hrefOf(next.id)}
				data-sveltekit-noscroll
				aria-label="Next mockup of this plan"
				class="grid w-12 cursor-pointer place-items-center border-l border-line text-ink hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
				><ChevronRight size={20} aria-hidden="true" /></a
			>
		</div>
	</div>
</nav>
