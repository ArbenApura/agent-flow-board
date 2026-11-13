<script lang="ts">
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { navigating, page } from '$app/state';
	// -- MODULES -- //
	import { itemTabsBar } from '#lib/board/item/itemTabsBar.svelte.js';
	import { itemTabsFrom } from '#lib/board/item/itemTabs.js';
	import { projectTabs } from '#lib/board/projectTabs.js';
	import { cn } from '#lib/ui/cn.js';
	import Button from '#lib/ui/Button.svelte';
	import ProjectTile from '#lib/board/ProjectTile.svelte';
	import AppSidebar from '#lib/board/AppSidebar.svelte';
	import ItemTabs from '#lib/board/item/ItemTabs.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import RouteSkeleton from '#lib/ui/RouteSkeleton.svelte';
	import ThemeToggle from '#lib/ui/ThemeToggle.svelte';
	import { signOut } from '#lib/ui/signOut.js';
	// -- DEP-COMPONENTS -- //
	import Settings from '@lucide/svelte/icons/settings';
	import Menu from '@lucide/svelte/icons/menu';
	import Search from '@lucide/svelte/icons/search';
	import Plug from '@lucide/svelte/icons/plug';
	import LogOut from '@lucide/svelte/icons/log-out';
	import CircleUser from '@lucide/svelte/icons/circle-user';

	// -- REQUIRED PROPS -- //

	let { data, children: pageContent }: LayoutProps = $props();

	// -- STATES -- //

	let drawer = $state(false);
	/** A quiet shadow under the bar once the page has scrolled. */
	let scrolled = $state(false);
	let account = $state(false);
	let palette = $state(false);
	/** The palette is loaded the first time it opens, so it is not in the first load of every page. */
	let Palette = $state<(typeof import('#lib/board/CommandPalette.svelte'))['default'] | null>(null);

	// -- REACTIVE STATES -- //

	const base = $derived(`/${data.org.slug}`);
	const current = $derived(data.projects.find((p) => p.key === page.params.project));
	// Six links stay in the bar: Notes joined them after Tasks (AFB-20261111-0035). The rest of the project lives under More
	// (ADR-004). The list is built in one place, and a guest on the project gets no Notes link
	const projectPages = $derived(
		current
			? projectTabs(
					base,
					current.key,
					(page.data as { summary?: { role?: string } | null }).summary?.role
				)
			: { primary: [], secondary: [] }
	);
	const primary = $derived(projectPages.primary);
	const secondary = $derived(projectPages.secondary);
	const tabs = $derived<{ href: string; label: string; exact?: boolean }[]>([
		...primary,
		...secondary
	]);
	// The tabs of the open item, for the top bar on a wide screen. Null on any other page, and on an item that did not load
	const itemTabs = $derived(itemTabsFrom(page.route.id, page.data, page.url.searchParams));
	// Where the person is, shown in the top bar: the open project and its page, or the name of the screen
	const crumbs = $derived.by(() => {
		const path = page.url.pathname;
		if (current) {
			const tab = tabs.find((t) => (t.exact ? path === t.href : path.startsWith(t.href)));
			// The organisation comes first, so a project page never shows one lone word in the bar
			return [
				{ label: data.org.name, href: base },
				{ label: current.name, href: `${base}/${current.key}` },
				...(tab && !tab.exact ? [{ label: tab.label, href: tab.href }] : [])
			];
		}
		if (path === base) return [{ label: 'Projects', href: base }];
		if (path.startsWith(`${base}/settings`))
			return [{ label: 'Organisation settings', href: path }];
		if (path.startsWith(`${base}/search`)) return [{ label: 'Search', href: path }];
		return [{ label: data.org.name, href: base }];
	});

	// -- FUNCTIONS -- //

	async function openPalette() {
		Palette ??= (await import('#lib/board/CommandPalette.svelte')).default;
		palette = true;
	}

	// "/" and Ctrl or Cmd with K open the search from anywhere that is not a text field
	function onShortcut(e: KeyboardEvent) {
		const target = e.target as HTMLElement | null;
		const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
		if (
			(e.key === 'k' && (e.ctrlKey || e.metaKey)) ||
			(e.key === '/' && !typing && !e.metaKey && !e.ctrlKey)
		) {
			e.preventDefault();
			void openPalette();
		}
	}

	const active = (t: { href: string; exact?: boolean }) =>
		t.exact ? page.url.pathname === t.href : page.url.pathname.startsWith(t.href);
</script>

<svelte:head><title>{data.org.name}</title></svelte:head>
<svelte:window onkeydown={onShortcut} onscroll={() => (scrolled = window.scrollY > 4)} />

<div class="min-h-dvh md:flex">
	<AppSidebar org={data.org} projects={data.projects} {current} me={data.me} {tabs} {base} />

	<div class="flex min-w-0 flex-1 flex-col">
		<!-- THE TOP BAR. WHERE THE PERSON IS, SEARCH AND THE ACCOUNT -->
		<header
			class={cn(
				'sticky top-0 z-30 border-b border-line bg-bar backdrop-blur-md transition-shadow duration-150',
				scrolled && 'shadow-[var(--elev-2)]'
			)}
		>
			<PageFrame testid="nav-frame">
				<div class="flex h-14 items-center gap-2 md:h-16 md:gap-3">
					<Button
						variant="subtle"
						iconOnly
						class="md:hidden"
						aria-label="Open the menu"
						data-testid="menu-button"
						onclick={() => (drawer = true)}
					>
						<Menu size={20} />
					</Button>
					<a
						href={base}
						class="flex min-w-0 items-center gap-2.5 text-base font-semibold text-ink md:hidden"
					>
						{#if data.org.logo}
							<img src={data.org.logo} alt="" class="size-6 rounded-md object-contain" />
						{:else}
							<Mark size={24} />
						{/if}
						<span class="truncate max-sm:max-w-[34vw]">{data.org.name}</span>
					</a>
					<nav
						class="flex min-w-0 items-center gap-2 text-sm max-md:hidden"
						aria-label="Breadcrumb"
					>
						{#each crumbs as c, i (c.href)}
							{#if i > 0}<span class="text-muted" aria-hidden="true">/</span>{/if}
							<a
								href={c.href}
								aria-current={i === crumbs.length - 1 ? 'page' : undefined}
								class={cn(
									'truncate',
									i === crumbs.length - 1 ? 'font-semibold text-ink' : 'text-muted hover:text-ink'
								)}>{c.label}</a
							>
						{/each}
					</nav>
					<!-- THE TABS OF THE OPEN ITEM FROM 1536 PX UP, TEXT ONLY, IN THE SAME CAPSULE AS THE CARD IN THE PAGE. THEY APPEAR ONLY ONCE THAT CARD HAS SCROLLED PAST THE BAR (VISIBILITY, SO A HIDDEN COPY IS NOT FOCUSABLE OR READ), CENTRED IN THE ROOM BETWEEN THE BREADCRUMB AND SEARCH, AND SCROLL WHEN IT IS NOT ENOUGH. BELOW 1536 PX THE CARD STAYS STUCK UNDER THE BAR -->
					{#if itemTabs}
						<nav
							aria-label="Item sections, pinned"
							class={cn(
								'hidden min-w-0 flex-1 justify-center transition-[opacity,visibility] duration-150 motion-reduce:transition-none 2xl:flex',
								itemTabsBar.show ? 'visible opacity-100' : 'invisible opacity-0'
							)}
							data-testid="item-tabs-bar"
						>
							<div
								class="max-w-full min-w-0 rounded-xl border border-line bg-surface p-1 shadow-[var(--elev-1)]"
							>
								<ItemTabs
									tabs={itemTabs.tabs}
									counts={itemTabs.counts}
									active={itemTabs.active}
									pathname={page.url.pathname}
									icons={false}
								/>
							</div>
						</nav>
					{/if}

					<div class="ml-auto flex items-center gap-2">
						<Button
							variant="secondary"
							href={`${base}/search`}
							aria-label="Search"
							data-testid="search-link-bar"
							onclick={(e: MouseEvent) => {
								// A plain click opens the palette. A modified click or no JavaScript still goes to the search page
								if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
								e.preventDefault();
								void openPalette();
							}}
							class="text-muted max-md:size-10 max-md:px-0 md:w-52 md:justify-start"
						>
							<Search size={18} />
							<span class="max-md:hidden">Search</span>
							<kbd
								class="ml-auto rounded border border-line px-1.5 text-xs text-muted max-md:hidden"
								>/</kbd
							>
						</Button>
						<ThemeToggle />
						<div class="max-md:hidden">
							<Popover
								bind:open={account}
								placement="bottom-end"
								role="dialog"
								label="Account"
								offset={12}
							>
								{#snippet trigger({ props, toggle })}
									<button
										type="button"
										onclick={toggle}
										aria-label="Account menu"
										data-testid="account-menu"
										class="cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
										{...props}
									>
										<Avatar
											name={data.me.name || data.me.email}
											userId={data.me.id}
											v={data.me.imageV}
											size={40}
										/>
									</button>
								{/snippet}
								{#snippet children({ close })}
									<div class="min-w-64 p-1">
										<div class="border-b border-line px-2.5 pt-2 pb-3">
											<p class="truncate text-sm font-medium text-ink">{data.me.name}</p>
											<p class="truncate text-xs text-muted">{data.me.email}</p>
										</div>
										<ul class="py-1">
											<li>
												<a
													href="/settings"
													onclick={close}
													data-testid="account-settings-link"
													class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
													><CircleUser size={18} class="text-muted" /> Your account settings</a
												>
											</li>
											<li>
												<a
													href={`${base}/settings`}
													onclick={close}
													data-testid="org-settings-link"
													class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
													><Settings size={18} class="text-muted" /> Organisation settings</a
												>
											</li>
											<li>
												<a
													href={`/connect?org=${data.org.slug}`}
													onclick={close}
													class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
													><Plug size={18} class="text-muted" /> Connect a tool</a
												>
											</li>
										</ul>
										<form
											method="POST"
											action="/sign-out"
											onsubmit={signOut}
											class="border-t border-line pt-1"
										>
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
					</div>
				</div>
			</PageFrame>
		</header>

		<main class="flex-1">
			<!-- ANOTHER SCREEN IS LOADING, SO ITS SKELETON REPLACES THE OLD PAGE AT ONCE. A CHANGE OF FILTER OR TAB ON THE SAME SCREEN KEEPS THE PAGE -->
			{#if navigating.to && navigating.to.route.id !== navigating.from?.route.id && navigating.to.url.pathname.startsWith(`/${data.org.slug}`)}
				<RouteSkeleton routeId={navigating.to.route.id} />
			{:else}
				{@render pageContent()}
			{/if}
		</main>
	</div>
</div>

<!-- THE MENU ON A PHONE. PROJECTS, THEN THE PAGES OF THE PROJECT, THEN ACCOUNT ACTIONS -->
<ResponsiveModal open={drawer} onclose={() => (drawer = false)} title="Menu">
	<nav class="flex flex-col gap-4" aria-label="Menu">
		<ul>
			{#each data.projects as p (p.id)}
				<li>
					<a
						href={`${base}/${p.key}`}
						onclick={() => (drawer = false)}
						class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-ink hover:bg-raised"
					>
						<ProjectTile id={p.id} projectKey={p.key} logoV={p.logoV} size={24} />
						<span class="font-mono text-xs text-muted">{p.key}</span>
						<span class="truncate">{p.name}</span>
					</a>
				</li>
			{/each}
		</ul>
		{#if tabs.length}
			<ul class="border-t border-line pt-2">
				{#each tabs as t (t.href)}
					<li>
						<a
							href={t.href}
							onclick={() => (drawer = false)}
							aria-current={active(t) ? 'page' : undefined}
							class="flex min-h-11 items-center rounded-md px-2 text-sm hover:bg-raised aria-[current=page]:font-medium aria-[current=page]:text-accent-text"
							>{t.label}</a
						>
					</li>
				{/each}
			</ul>
		{/if}
		<ul class="border-t border-line pt-2">
			<li>
				<a
					href="/settings"
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><CircleUser size={18} /> Your account settings</a
				>
			</li>
			<li>
				<a
					href={`${base}/settings`}
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><Settings size={18} /> Organisation settings</a
				>
			</li>
			<li>
				<a
					href={`/connect?org=${data.org.slug}`}
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><Plug size={18} /> Connect a tool</a
				>
			</li>
		</ul>
		<form method="POST" action="/sign-out" onsubmit={signOut} class="border-t border-line pt-2">
			<Button type="submit" variant="subtle" class="w-full justify-start">
				<LogOut size={16} /> Sign out
			</Button>
		</form>
	</nav>
</ResponsiveModal>

{#if Palette}
	<Palette open={palette} onclose={() => (palette = false)} org={data.org.slug} pages={tabs} />
{/if}
