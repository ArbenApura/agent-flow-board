<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';
	// -- TYPES -- //
	import type { ItemTab, ItemTabCounts } from '#lib/board/item/itemTabs.js';
	// -- MODULES -- //
	import { scrollFade } from '#lib/actions/scrollFade.js';
	import { ITEM_TAB_LABEL, itemTabHref } from '#lib/board/item/itemTabs.js'; // -- DEP-COMPONENTS -- //
	import Activity from '@lucide/svelte/icons/activity';
	import FileText from '@lucide/svelte/icons/file-text';
	import Gavel from '@lucide/svelte/icons/gavel';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import MonitorCheck from '@lucide/svelte/icons/monitor-check';
	import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';
	import Paperclip from '@lucide/svelte/icons/paperclip';

	// -- REQUIRED PROPS -- //

	let {
		tabs,
		counts,
		active,
		pathname,
		icons = true
	}: {
		/** The tabs to draw, in order. */
		tabs: ItemTab[];
		counts: ItemTabCounts;
		/** The tab that is open. */
		active: ItemTab;
		/** The address of the item, so every tab links to a query on it. */
		pathname: string;
		/** The card under the top bar draws an icon on each tab. The top bar copy is text only, to fit beside the breadcrumb and Search. */
		icons?: boolean;
	} = $props();

	// -- CONSTANTS -- //

	const TAB_ICON: Record<
		ItemTab,
		Component<{ size?: number; class?: string; 'aria-hidden'?: 'true' }>
	> = {
		plan: ListChecks,
		decisions: Gavel,
		docs: FileText,
		mockups: PanelsTopLeft,
		checks: MonitorCheck,
		activity: Activity,
		files: Paperclip,
		discussion: MessagesSquare
	};

	// -- STATES -- //

	let tabRow = $state<HTMLElement>();

	// -- REACTIVE STATEMENTS -- //

	// The active tab slides to the middle of its row, with the row's own scroll so the page never moves. A row that is not shown
	// (display none, so no width) or that fits does nothing, and a resize of the row slides it again, so the copy that appears
	// when the window grows is centred too
	$effect(() => {
		void active;
		const row = tabRow;
		if (!row) return;
		const centre = () => {
			const current = row.querySelector<HTMLElement>('[aria-current="page"]');
			if (!current || row.clientWidth === 0 || row.scrollWidth <= row.clientWidth) return;
			const left =
				current.getBoundingClientRect().left -
				row.getBoundingClientRect().left +
				row.scrollLeft -
				(row.clientWidth - current.offsetWidth) / 2;
			row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
		};
		centre();
		const watch = new ResizeObserver(centre);
		watch.observe(row);
		return () => watch.disconnect();
	});
</script>

<!-- THE ROW SCROLLS SIDEWAYS WHEN IT DOES NOT FIT. A FADE OF THE SURFACE SHOWS AT THE EDGE WHERE IT CONTINUES -->
<div class="group/fade relative min-w-0">
	<div
		bind:this={tabRow}
		use:scrollFade
		class="[scrollbar-width:none]! overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden"
	>
		<ul class="flex min-w-max gap-1">
			{#each tabs as t (t)}
				{@const Icon = TAB_ICON[t]}
				<li>
					<a
						href={itemTabHref(pathname, t)}
						aria-current={active === t ? 'page' : undefined}
						data-testid={`tab-${t}`}
						class="group flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm whitespace-nowrap text-muted transition-colors hover:bg-raised/60 hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:font-medium aria-[current=page]:text-ink motion-reduce:transition-none max-sm:min-h-11"
					>
						{#if icons}
							<Icon
								size={16}
								class="shrink-0 group-aria-[current=page]:text-accent"
								aria-hidden="true"
							/>
						{/if}
						{ITEM_TAB_LABEL[t]}
						{#if (counts[t] ?? 0) > 0}<span
								data-count
								class="rounded-full bg-raised px-2 py-0.5 text-badge leading-none font-semibold text-muted tabular-nums group-aria-[current=page]:bg-surface group-aria-[current=page]:text-ink"
								>{counts[t]}</span
							>{/if}
					</a>
				</li>
			{/each}
		</ul>
	</div>
	<span
		class="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-lg bg-[linear-gradient(to_right,var(--surface),transparent)] opacity-0 transition-opacity group-data-[fade-start]/fade:opacity-100 motion-reduce:transition-none"
		aria-hidden="true"
	></span>
	<span
		class="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-lg bg-[linear-gradient(to_left,var(--surface),transparent)] opacity-0 transition-opacity group-data-[fade-end]/fade:opacity-100 motion-reduce:transition-none"
		aria-hidden="true"
	></span>
</div>
