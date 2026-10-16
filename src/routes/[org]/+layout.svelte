<script lang="ts">
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import { tagDot } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	// -- DEP-COMPONENTS -- //
	import CaretDown from 'phosphor-svelte/lib/CaretDown';
	import DotsThree from 'phosphor-svelte/lib/DotsThree';
	import Gear from 'phosphor-svelte/lib/Gear';
	import List from 'phosphor-svelte/lib/List';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import Plugs from 'phosphor-svelte/lib/Plugs';
	import SignOut from 'phosphor-svelte/lib/SignOut';
	import UserCircle from 'phosphor-svelte/lib/UserCircle';

	// -- REQUIRED PROPS -- //

	let { data, children: pageContent }: LayoutProps = $props();

	// -- STATES -- //

	let drawer = $state(false);
	let switcher = $state(false);
	let more = $state(false);
	let account = $state(false);
	let palette = $state(false);
	/** The palette is loaded the first time it opens, so it is not in the first load of every page. */
	let Palette = $state<(typeof import('#lib/board/CommandPalette.svelte'))['default'] | null>(null);

	// -- REACTIVE STATES -- //

	const base = $derived(`/${data.org.slug}`);
	const current = $derived(data.projects.find((p) => p.key === page.params.project));
	// Five links stay in the bar. The rest of the project lives under More (ADR-004)
	const primary = $derived(
		current
			? [
					{ href: `${base}/${current.key}`, label: 'Registry', exact: true },
					{ href: `${base}/${current.key}/tasks`, label: 'Tasks' },
					{ href: `${base}/${current.key}/activity`, label: 'Activity' },
					{ href: `${base}/${current.key}/health`, label: 'Health' },
					{ href: `${base}/${current.key}/publish`, label: 'Publish' }
				]
			: []
	);
	const secondary = $derived(
		current
			? [
					...(current.webApp ? [{ href: `${base}/${current.key}/ui`, label: 'UI' }] : []),
					{ href: `${base}/${current.key}/trash`, label: 'Trash' },
					{ href: `${base}/${current.key}/settings`, label: 'Project settings' }
				]
			: []
	);
	const tabs = $derived([...primary, ...secondary]);

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
<svelte:window onkeydown={onShortcut} />

<div class="flex min-h-dvh flex-col bg-bg">
	<header class="sticky top-0 z-30 border-b border-line bg-surface">
		<PageFrame testid="nav-frame">
			<div class="flex h-16 items-center gap-3">
				<Button
					variant="ghost"
					iconOnly
					class="md:hidden"
					aria-label="Open the menu"
					data-testid="menu-button"
					onclick={() => (drawer = true)}
				>
					<List size={20} />
				</Button>
				<a href={base} class="flex min-w-0 items-center gap-2.5 text-base font-semibold text-ink">
					{#if data.org.logo}
						<img
							src={data.org.logo}
							alt=""
							class="size-7 rounded-md object-contain"
							data-testid="org-logo"
						/>
					{:else}
						<Mark size={28} />
					{/if}
					<span class="truncate max-sm:max-w-[28vw]" data-testid="org-name">{data.org.name}</span>
				</a>

				{#if data.projects.length}
					<span class="text-muted max-md:hidden" aria-hidden="true">/</span>
					<div class="max-md:hidden">
						<Popover bind:open={switcher} placement="bottom-start" role="dialog" label="Projects">
							{#snippet trigger({ props, toggle })}
								<Button
									variant="ghost"
									size="sm"
									onclick={toggle}
									data-testid="project-switcher"
									{...props}
								>
									{#if current}
										<span class={cn('size-2 rounded-full', tagDot(current.colourTag))}></span>
										{current.key}
									{:else}
										Projects
									{/if}
									<CaretDown size={14} />
								</Button>
							{/snippet}
							{#snippet children({ close })}
								<ul class="min-w-64 p-1" data-testid="project-list">
									{#each data.projects as p (p.id)}
										<li>
											<a
												href={`${base}/${p.key}`}
												onclick={close}
												class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
												aria-current={p.key === current?.key ? 'page' : undefined}
											>
												<span class={cn('size-2 rounded-full', tagDot(p.colourTag))}></span>
												<span class="font-mono text-xs text-muted">{p.key}</span>
												<span class="truncate">{p.name}</span>
											</a>
										</li>
									{/each}
								</ul>
							{/snippet}
						</Popover>
					</div>
				{/if}

				<nav class="ml-3 flex h-full items-stretch gap-1 max-md:hidden" aria-label="Project">
					{#each primary as t (t.href)}
						<a
							href={t.href}
							aria-current={active(t) ? 'page' : undefined}
							class={cn(
								'flex items-center border-b-2 border-transparent px-3 text-sm text-muted hover:text-ink',
								active(t) && 'border-accent font-medium text-ink'
							)}>{t.label}</a
						>
					{/each}
					{#if secondary.length}
						<div class="flex items-center">
							<Popover bind:open={more} placement="bottom-start" role="dialog" label="More pages">
								{#snippet trigger({ props, toggle })}
									<Button
										variant="ghost"
										size="sm"
										onclick={toggle}
										aria-label="More pages"
										data-testid="nav-more"
										{...props}
									>
										<DotsThree size={20} weight="bold" />
									</Button>
								{/snippet}
								{#snippet children({ close })}
									<ul class="min-w-48 p-1">
										{#each secondary as t (t.href)}
											<li>
												<a
													href={t.href}
													onclick={close}
													aria-current={active(t) ? 'page' : undefined}
													class="flex min-h-10 items-center rounded-md px-2.5 text-sm text-ink hover:bg-raised aria-[current=page]:font-medium aria-[current=page]:text-accent-text"
													>{t.label}</a
												>
											</li>
										{/each}
									</ul>
								{/snippet}
							</Popover>
						</div>
					{/if}
				</nav>

				<div class="ml-auto flex items-center gap-2">
					<Button
						variant="secondary"
						href={`${base}/search`}
						aria-label="Search"
						data-testid="search-link"
						onclick={(e: MouseEvent) => {
							// A plain click opens the palette. A modified click or no JavaScript still goes to the search page
							if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
							e.preventDefault();
							void openPalette();
						}}
						class="text-muted max-md:size-10 max-md:px-0 md:w-52 md:justify-start"
					>
						<MagnifyingGlass size={18} />
						<span class="max-md:hidden">Search</span>
						<kbd class="ml-auto rounded border border-line px-1.5 text-xs text-muted max-md:hidden"
							>/</kbd
						>
					</Button>
					<div class="max-md:hidden">
						<Popover bind:open={account} placement="bottom-end" role="dialog" label="Account">
							{#snippet trigger({ props, toggle })}
								<button
									type="button"
									onclick={toggle}
									aria-label="Account menu"
									data-testid="account-menu"
									class="cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									{...props}
								>
									<Avatar name={data.me.name || data.me.email} size={32} />
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
												><UserCircle size={18} class="text-muted" /> Your account settings</a
											>
										</li>
										<li>
											<a
												href={`${base}/settings`}
												onclick={close}
												data-testid="org-settings-link"
												class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
												><Gear size={18} class="text-muted" /> Organisation settings</a
											>
										</li>
										<li>
											<a
												href={`/connect?org=${data.org.slug}`}
												onclick={close}
												class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
												><Plugs size={18} class="text-muted" /> Connect a tool</a
											>
										</li>
									</ul>
									<form method="POST" action="/sign-out" class="border-t border-line pt-1">
										<button
											type="submit"
											class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
										>
											<SignOut size={18} class="text-muted" /> Sign out
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
		{@render pageContent()}
	</main>
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
						<span class={cn('size-2 rounded-full', tagDot(p.colourTag))}></span>
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
					><UserCircle size={18} /> Your account settings</a
				>
			</li>
			<li>
				<a
					href={`${base}/settings`}
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><Gear size={18} /> Organisation settings</a
				>
			</li>
			<li>
				<a
					href={`/connect?org=${data.org.slug}`}
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><Plugs size={18} /> Connect a tool</a
				>
			</li>
		</ul>
		<form method="POST" action="/sign-out" class="border-t border-line pt-2">
			<Button type="submit" variant="ghost" class="w-full justify-start">
				<SignOut size={16} /> Sign out
			</Button>
		</form>
	</nav>
</ResponsiveModal>

{#if Palette}
	<Palette open={palette} onclose={() => (palette = false)} org={data.org.slug} pages={tabs} />
{/if}
