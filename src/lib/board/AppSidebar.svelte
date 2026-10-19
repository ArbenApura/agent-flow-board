<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import { LABEL } from '#lib/board/sidebar-classes.js';
	import { cn } from '#lib/ui/cn.js';
	import SidebarRow from '#lib/board/SidebarRow.svelte';
	import ProjectTile from '#lib/board/ProjectTile.svelte';
	import SidebarShell from '#lib/board/SidebarShell.svelte';
	// -- DEP-COMPONENTS -- //
	import Activity from '@lucide/svelte/icons/activity';
	import Building2 from '@lucide/svelte/icons/building-2';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import House from '@lucide/svelte/icons/house';
	import LayoutList from '@lucide/svelte/icons/layout-list';
	import Plug from '@lucide/svelte/icons/plug';
	import Settings from '@lucide/svelte/icons/settings';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import SquareCheckBig from '@lucide/svelte/icons/square-check-big';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Trash from '@lucide/svelte/icons/trash';

	// -- TYPES -- //

	type Icon = Component<{ size?: number; class?: string }>;
	type Tab = { href: string; label: string; exact?: boolean };

	// -- REQUIRED PROPS -- //

	let {
		org,
		projects,
		current,
		me,
		tabs,
		base
	}: {
		org: { name: string; logo?: string | null };
		projects: {
			id: string;
			key: string;
			name: string;
			logoV?: number | null;
		}[];
		current?: { key: string };
		me: { id?: string; name: string; email: string; imageV?: number | null };
		/** The pages of the open project, the first five are the main ones. */
		tabs: Tab[];
		base: string;
	} = $props();

	// -- CONSTANTS -- //

	// One icon for each page of a project, the label is what the layout names it
	const TAB_ICON: Record<string, Icon> = {
		Registry: LayoutList,
		Tasks: SquareCheckBig,
		Skills: Sparkles,
		Activity,
		Health: HeartPulse,
		Trash,
		'Project settings': Settings2
	};

	// -- FUNCTIONS -- //

	// A project whose name is only its key is shown once, not twice
	const sameName = (p: { key: string; name: string }) =>
		p.key.trim().toLowerCase() === p.name.trim().toLowerCase();

	const active = (t: { href: string; exact?: boolean }) =>
		t.exact ? page.url.pathname === t.href : page.url.pathname.startsWith(t.href);
</script>

<!-- THE SIDEBAR OF AN ORGANISATION. ITS PROJECTS WITH THE PAGES OF THE OPEN ONE UNDER IT, THEN SETTINGS -->
<SidebarShell name={org.name} logo={org.logo} slug={base.slice(1)} href={base} {me}>
	<nav class="flex flex-col gap-1" aria-label="Organisation">
		<SidebarRow href={base} label="Projects" icon={House} active={page.url.pathname === base} />
	</nav>

	{#if projects.length}
		<nav
			class="flex flex-col gap-1 border-t border-line pt-4"
			aria-label="Projects"
			data-testid="project-list"
		>
			{#each projects as p (p.id)}
				{@const open = p.key === current?.key}
				<a
					href={`${base}/${p.key}`}
					title={`${p.key} ${p.name}`}
					aria-current={open && tabs.every((t) => !active(t)) ? 'page' : undefined}
					class={cn(
						'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-[11px] text-sm text-muted transition-colors hover:bg-raised hover:text-ink',
						open && 'font-medium text-ink'
					)}
				>
					<!-- EVERY PROJECT SHOWS A SMALL TILE WITH ITS KEY, SO THE SLIM RAIL NAMES IT TOO. -->
					<ProjectTile
						id={p.id}
						projectKey={p.key}
						logoV={p.logoV}
						class={cn('-ml-[3px]', open && 'text-ink')}
					/>
					<span class={LABEL}>{sameName(p) ? p.key : p.name}</span>
				</a>
				{#if open && tabs.length}
					<ul
						class={cn(
							'mt-0.5 mb-2 ml-[20px] flex flex-col gap-0.5 border-l border-line pl-2 transition-[margin,padding,border-color] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none',
							'side-collapsed:ml-0 side-collapsed:border-transparent side-collapsed:pl-0'
						)}
					>
						{#each tabs as t (t.href)}
							<li>
								<SidebarRow
									href={t.href}
									label={t.label}
									icon={TAB_ICON[t.label] ?? LayoutList}
									active={active(t)}
								/>
							</li>
						{/each}
					</ul>
				{/if}
			{/each}
		</nav>
	{/if}

	<nav class="mt-auto flex flex-col gap-1" aria-label="Settings">
		<SidebarRow href={`/connect?org=${base.slice(1)}`} label="Connect a tool" icon={Plug} />
		<SidebarRow
			href={`${base}/settings`}
			label="Organisation settings"
			icon={Settings}
			active={page.url.pathname === `${base}/settings`}
		/>
		<SidebarRow href="/" label="All organisations" icon={Building2} />
	</nav>
</SidebarShell>
