<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED MODULES
	import { createTabs } from '#lib/settings/tabs.svelte.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let { children }: { children: Snippet } = $props();

	// -- CONSTANTS -- //

	const tabs = createTabs();

	// -- STATES -- //

	let tabRow = $state<HTMLElement>();

	// -- REACTIVE STATES -- //

	const requested = $derived(page.url.searchParams.get('tab'));
	const known = $derived(!requested || tabs.items.some((t) => t.id === requested));
	const active = $derived((known ? requested : null) || tabs.items[0]?.id || '');
	// A heading is drawn where the group changes, and only for a tab that is really there, so a person who cannot see a section never sees an empty heading
	const entries = $derived(
		tabs.items.map((t, i) => ({
			tab: t,
			heading: t.group && t.group !== tabs.items[i - 1]?.group ? t.group : null,
			divider: i > 0 && t.group !== tabs.items[i - 1]?.group
		}))
	);

	// -- REACTIVE STATEMENTS -- //

	// A stale or hidden tab name in the address (a bookmark, a section this person cannot see) opens the first tab instead of an empty page
	$effect(() => {
		if (requested && tabs.items.length && !known)
			void goto(`?tab=${tabs.items[0].id}`, { replaceState: true });
	});

	// On a phone the active tab slides to the middle of its row, with the row's own scroll so the page never moves
	$effect(() => {
		void active;
		const row = tabRow;
		const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!row || !current || row.scrollWidth <= row.clientWidth) return;
		const left =
			current.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - current.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});
</script>

<!-- SIDE TABS ON A WIDE SCREEN, A ROW OF TABS ON A PHONE. THE NAVIGATION RENDERS AFTER THE SECTIONS SO IT KNOWS THEM ALL, AND CSS PUTS IT FIRST -->
<div class="grid gap-6 md:grid-cols-[240px_minmax(0,1fr)] md:gap-10">
	<div class="flex min-w-0 flex-col gap-4 md:order-2">
		{@render children()}
	</div>
	<nav aria-label="Settings sections" class="order-first min-w-0 md:order-1">
		<ul
			bind:this={tabRow}
			class="flex [scrollbar-width:none]! gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain max-md:border-b max-md:border-line md:sticky md:top-24 md:flex-col md:overflow-visible [&::-webkit-scrollbar]:hidden"
		>
			{#each entries as e (e.tab.id)}
				{#if e.divider}
					<li aria-hidden="true" class="my-2 w-px shrink-0 bg-line md:hidden"></li>
				{/if}
				{#if e.heading}
					<li
						role="presentation"
						class="px-3 pt-4 pb-1 text-xs font-medium text-muted first:pt-0 max-md:hidden"
					>
						{e.heading}
					</li>
				{/if}
				<li class="max-md:shrink-0">
					<a
						href={`?tab=${e.tab.id}`}
						data-testid={`settings-tab-${e.tab.id}`}
						data-sveltekit-noscroll
						aria-current={active === e.tab.id ? 'page' : undefined}
						class={cn(
							'relative flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-muted hover:bg-line/60 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-md:min-h-11 max-md:rounded-none max-md:border-b-2 max-md:border-transparent max-md:px-4 max-md:focus-visible:-outline-offset-2 md:whitespace-normal',
							active === e.tab.id &&
								'bg-accent-soft font-medium text-accent-text before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent hover:bg-accent-soft hover:text-accent-text max-md:border-accent max-md:bg-transparent max-md:text-ink max-md:before:hidden'
						)}
					>
						{#if e.tab.icon}
							{@const Icon = e.tab.icon}
							<span
								aria-hidden="true"
								class={cn(
									'inline-flex shrink-0',
									active === e.tab.id ? 'text-accent' : 'text-muted'
								)}><Icon size={16} /></span
							>
						{/if}
						{e.tab.title}
					</a>
				</li>
			{/each}
		</ul>
	</nav>
</div>
