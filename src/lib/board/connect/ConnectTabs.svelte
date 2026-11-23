<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED TYPES
	import type { ConnectTabKey } from '#lib/connect/hrefs.js';
	// IMPORTED MODULES
	import { connectHref } from '#lib/connect/hrefs.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Activity from '@lucide/svelte/icons/activity';
	import Plug from '@lucide/svelte/icons/plug';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Terminal from '@lucide/svelte/icons/terminal';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';

	// -- TYPES -- //

	type PillTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
	type TabStatus = { text: string; tone: PillTone; mono?: boolean };

	// -- REQUIRED PROPS -- //

	let {
		tab,
		org,
		status
	}: {
		tab: ConnectTabKey;
		/** The organisation slug kept in every link, or null when the person has none yet. */
		org: string | null;
		/** How each section stands right now, as the short pill on its card. */
		status: Record<ConnectTabKey, TabStatus>;
	} = $props();

	// -- CONSTANTS -- //

	const TABS: {
		key: ConnectTabKey;
		label: string;
		sub: string;
		icon: Component<{ size?: number }>;
	}[] = [
		{ key: 'tools', label: 'Tools and tokens', sub: 'Apps and tokens', icon: Plug },
		{ key: 'skills', label: 'Skills', sub: 'Install the flow skills', icon: Sparkles },
		{ key: 'editor', label: 'Editor status', sub: 'Item in your editor', icon: Activity },
		{ key: 'bridge', label: 'Bridge', sub: 'Install and commands', icon: Terminal }
	];

	// -- STATES -- //

	let row = $state<HTMLElement>();

	// -- REACTIVE STATEMENTS -- //

	// The active tab slides to the centre of the row on a tab change and on first load, with the row's own scroll
	$effect(() => {
		void tab;
		const el = row;
		const current = el?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!el || !current) return;
		const left =
			current.getBoundingClientRect().left -
			el.getBoundingClientRect().left +
			el.scrollLeft -
			(el.clientWidth - current.offsetWidth) / 2;
		el.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});
</script>

<!-- SECTIONS OF THIS PAGE. EACH ONE IS A CARD THAT SAYS WHAT IT IS FOR AND HOW IT STANDS RIGHT NOW. A SIDEWAYS ROW OF PILLS ON A PHONE -->
<nav
	bind:this={row}
	class="enter -m-1 flex [scrollbar-width:none]! gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain p-1 md:grid md:grid-cols-2 md:overflow-visible xl:grid-cols-4 [&::-webkit-scrollbar]:hidden"
	aria-label="Connect sections"
	data-testid="connect-tabs"
>
	{#each TABS as t (t.key)}
		{@const Icon = t.icon}
		<a
			href={connectHref(org, t.key)}
			aria-current={tab === t.key ? 'page' : undefined}
			class="group relative flex min-h-11 shrink-0 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 shadow-[var(--elev-1)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-muted aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft/40 aria-[current=page]:ring-4 aria-[current=page]:ring-accent-soft max-md:py-0"
		>
			<span
				class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-raised text-muted transition-colors group-aria-[current=page]:bg-accent group-aria-[current=page]:text-accent-ink max-md:size-auto max-md:bg-transparent max-md:group-aria-[current=page]:bg-transparent max-md:group-aria-[current=page]:text-accent-text"
				aria-hidden="true"><Icon size={20} /></span
			>
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="text-sm font-semibold whitespace-nowrap text-ink">{t.label}</span>
				<span class="truncate text-xs text-muted max-md:hidden">{t.sub}</span>
			</span>
			<Badge
				tone={status[t.key].tone}
				class={cn('shrink-0 tabular-nums max-md:hidden', status[t.key].mono && 'font-mono')}
				>{status[t.key].text}</Badge
			>
		</a>
	{/each}
</nav>
