<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import { tagDot } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	// -- DEP-COMPONENTS -- //
	import Activity from '@lucide/svelte/icons/activity';
	import Building2 from '@lucide/svelte/icons/building-2';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import House from '@lucide/svelte/icons/house';
	import LayoutList from '@lucide/svelte/icons/layout-list';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Plug from '@lucide/svelte/icons/plug';
	import Settings from '@lucide/svelte/icons/settings';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import SquareCheckBig from '@lucide/svelte/icons/square-check-big';
	import Trash from '@lucide/svelte/icons/trash';
	import Upload from '@lucide/svelte/icons/upload';

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
		projects: { id: string; key: string; name: string; colourTag: string | null }[];
		current?: { key: string };
		me: { name: string; email: string };
		/** The pages of the open project, the first five are the main ones. */
		tabs: Tab[];
		base: string;
	} = $props();

	// -- CONSTANTS -- //

	// One icon for each page of a project, the label is what the layout names it
	const TAB_ICON: Record<string, Icon> = {
		Registry: LayoutList,
		Tasks: SquareCheckBig,
		Activity,
		Health: HeartPulse,
		Publish: Upload,
		UI: Monitor,
		Trash,
		'Project settings': Settings2
	};

	// Whole class names on purpose, Tailwind only builds the classes it can read in full
	const LABEL =
		'truncate whitespace-nowrap transition-opacity duration-150 motion-reduce:transition-none side-collapsed:opacity-0';
	const KEY =
		'font-mono text-xs whitespace-nowrap text-muted transition-opacity duration-150 motion-reduce:transition-none side-collapsed:opacity-0';
	const HEADING =
		'px-[11px] pb-1 text-xs font-medium tracking-wide whitespace-nowrap text-muted uppercase transition-opacity duration-150 motion-reduce:transition-none side-collapsed:opacity-0';

	// -- STATES -- //

	let account = $state(false);

	// -- FUNCTIONS -- //

	const active = (t: { href: string; exact?: boolean }) =>
		t.exact ? page.url.pathname === t.href : page.url.pathname.startsWith(t.href);
</script>

<!-- ONE ROW OF THE SIDEBAR. AN ICON AND A LABEL, THE LABEL GOES WHEN THE SIDEBAR IS COLLAPSED -->
{#snippet row(href: string, label: string, Glyph: Icon, isActive: boolean)}
	<a
		{href}
		title={label}
		aria-current={isActive ? 'page' : undefined}
		class={cn(
			'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-[11px] text-sm text-muted hover:bg-raised hover:text-ink',
			isActive &&
				'bg-accent-soft font-medium text-accent-text hover:bg-accent-soft hover:text-accent-text'
		)}
	>
		<Glyph size={18} class="shrink-0" />
		<span class={LABEL}>{label}</span>
	</a>
{/snippet}

<!-- THE SIDEBAR. A SLIM RAIL OF ICONS THAT OPENS OVER THE PAGE WHEN THE POINTER OR FOCUS IS ON IT. THE ORGANISATION ON TOP, ITS PROJECTS WITH THE PAGES OF THE OPEN ONE UNDER IT, THEN SETTINGS AND THE ACCOUNT. DESKTOP ONLY, A PHONE USES THE TOP BAR AND THE MENU -->
<div class="group/side sticky top-0 z-40 hidden h-dvh w-16 shrink-0 md:block" data-pinned={account}>
	<aside
		class="absolute inset-y-0 left-0 flex w-64 flex-col overflow-hidden border-r border-line bg-surface shadow-[var(--elev-2)] transition-[width,box-shadow] [transition-delay:100ms] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none side-collapsed:w-16 side-collapsed:shadow-none side-collapsed:[transition-delay:0ms]"
		aria-label="Sidebar"
		data-testid="sidebar"
	>
		<a
			href={base}
			class={cn(
				'flex h-[65px] shrink-0 items-center gap-2.5 border-b border-line px-[18px] text-base font-semibold text-ink'
			)}
		>
			{#if org.logo}
				<img
					src={org.logo}
					alt=""
					class="size-7 shrink-0 rounded-md object-contain"
					data-testid="org-logo"
				/>
			{:else}
				<Mark size={28} class="shrink-0" />
			{/if}
			<span class={LABEL} data-testid="org-name">{org.name}</span>
		</a>

		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-3">
			<nav class="flex flex-col gap-1" aria-label="Organisation">
				{@render row(base, 'Projects', House, page.url.pathname === base)}
			</nav>

			{#if projects.length}
				<nav class="flex flex-col gap-1" aria-label="Projects" data-testid="project-list">
					<p class={HEADING}>Projects</p>
					{#each projects as p (p.id)}
						{@const open = p.key === current?.key}
						<a
							href={`${base}/${p.key}`}
							title={`${p.key} ${p.name}`}
							aria-current={open && tabs.every((t) => !active(t)) ? 'page' : undefined}
							class={cn(
								'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-[11px] text-sm text-ink transition-colors hover:bg-raised',
								open && 'font-medium'
							)}
						>
							<span class={cn('size-2 shrink-0 rounded-full', tagDot(p.colourTag))}></span>
							<span class={KEY}>{p.key}</span>
							<span class={LABEL}>{p.name}</span>
						</a>
						{#if open && tabs.length}
							<ul
								class={cn(
									'mb-1 ml-[18px] flex flex-col gap-0.5 border-l border-line pl-2 transition-[margin,padding,border-color] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none',
									'side-collapsed:ml-0 side-collapsed:border-transparent side-collapsed:pl-0'
								)}
							>
								{#each tabs as t (t.href)}
									<li>
										{@render row(t.href, t.label, TAB_ICON[t.label] ?? LayoutList, active(t))}
									</li>
								{/each}
							</ul>
						{/if}
					{/each}
				</nav>
			{/if}

			<nav class="mt-auto flex flex-col gap-1" aria-label="Settings">
				{@render row(
					`${base}/settings`,
					'Organisation settings',
					Settings,
					page.url.pathname === `${base}/settings`
				)}
				{@render row(`/connect?org=${base.slice(1)}`, 'Connect a tool', Plug, false)}
				{@render row('/', 'All organisations', Building2, false)}
			</nav>
		</div>
		<!-- THE FOOT OF THE SIDEBAR. THE ACCOUNT WITH ITS MENU -->
		<div class="flex shrink-0 flex-col gap-1 border-t border-line p-3">
			<Popover bind:open={account} placement="top-start" role="dialog" label="Account">
				{#snippet trigger({ props, toggle })}
					<button
						type="button"
						onclick={toggle}
						aria-label="Account menu"
						data-testid="account-menu-side"
						class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
						{...props}
					>
						<Avatar name={me.name || me.email} size={32} class="shrink-0" />
						<span class={cn('flex min-w-0 flex-1 flex-col leading-tight', LABEL)}>
							<span class="truncate text-sm font-medium text-ink">{me.name}</span>
							<span class="truncate text-xs text-muted">{me.email}</span>
						</span>
						<ChevronsUpDown size={16} class={cn('mr-1 shrink-0 text-muted', LABEL)} />
					</button>
				{/snippet}
				{#snippet children({ close })}
					<div class="min-w-64 p-1">
						<div class="flex items-center gap-3 border-b border-line px-2.5 pt-2 pb-3">
							<Avatar name={me.name || me.email} size={40} />
							<div class="min-w-0">
								<p class="truncate text-sm font-medium text-ink">{me.name}</p>
								<p class="truncate text-xs text-muted">{me.email}</p>
							</div>
						</div>
						<ul class="py-1">
							<li>
								<a
									href="/settings"
									onclick={close}
									data-testid="account-settings-link-side"
									class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
									><CircleUser size={18} class="text-muted" /> Your account settings</a
								>
							</li>
						</ul>
						<form method="POST" action="/sign-out" class="border-t border-line pt-1">
							<button
								type="submit"
								class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
							>
								<LogOut size={18} class="text-muted" /> Sign out
							</button>
						</form>
					</div>
				{/snippet}
			</Popover>
		</div>
	</aside>
</div>
