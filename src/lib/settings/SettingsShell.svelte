<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- ENVS -- //
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { createTabs } from '#lib/settings/tabs.svelte.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let { children }: { children: Snippet } = $props();

	// -- CONSTANTS -- //

	const tabs = createTabs();

	// -- REACTIVE STATES -- //

	const requested = $derived(page.url.searchParams.get('tab'));
	const known = $derived(!requested || tabs.items.some((t) => t.id === requested));
	const active = $derived((known ? requested : null) || tabs.items[0]?.id || '');

	// -- REACTIVE STATEMENTS -- //

	// A stale or hidden tab name in the address (a bookmark, a section this person cannot see) opens the first tab instead of an empty page
	$effect(() => {
		if (requested && tabs.items.length && !known)
			void goto(`?tab=${tabs.items[0].id}`, { replaceState: true });
	});
</script>

<!-- SIDE TABS ON A WIDE SCREEN, A ROW OF TABS ON A PHONE. THE NAVIGATION RENDERS AFTER THE SECTIONS SO IT KNOWS THEM ALL, AND CSS PUTS IT FIRST -->
<div class="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10">
	<div class="flex min-w-0 flex-col gap-4 md:order-2">
		{@render children()}
	</div>
	<nav aria-label="Settings sections" class="order-first min-w-0 md:order-1">
		<ul
			class="flex gap-1 overflow-x-auto max-md:border-b max-md:border-line md:sticky md:top-24 md:flex-col md:overflow-visible"
		>
			{#each tabs.items as t (t.id)}
				<li class="max-md:shrink-0">
					<a
						href={`?tab=${t.id}`}
						data-testid={`settings-tab-${t.id}`}
						data-sveltekit-noscroll
						aria-current={active === t.id ? 'page' : undefined}
						class={cn(
							'flex min-h-10 items-center rounded-lg px-3 text-sm whitespace-nowrap text-muted hover:bg-raised hover:text-ink max-md:rounded-none max-md:border-b-2 max-md:border-transparent max-md:px-4',
							active === t.id &&
								'bg-accent-soft font-medium text-accent-text hover:bg-accent-soft hover:text-accent-text max-md:border-accent max-md:bg-transparent max-md:text-ink'
						)}>{t.title}</a
					>
				</li>
			{/each}
		</ul>
	</nav>
</div>
