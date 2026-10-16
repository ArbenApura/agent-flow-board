<script lang="ts">
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import { tagDot } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	import Button from '#lib/ui/Button.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	// -- DEP-COMPONENTS -- //
	import CaretDown from 'phosphor-svelte/lib/CaretDown';
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

	// -- REACTIVE STATES -- //

	const base = $derived(`/${data.org.slug}`);
	const current = $derived(data.projects.find((p) => p.key === page.params.project));
	const tabs = $derived(
		current
			? [
					{ href: `${base}/${current.key}`, label: 'Registry', exact: true },
					{ href: `${base}/${current.key}/tasks`, label: 'Tasks' },
					{ href: `${base}/${current.key}/activity`, label: 'Activity' },
					...(current.webApp ? [{ href: `${base}/${current.key}/ui`, label: 'UI' }] : []),
					{ href: `${base}/${current.key}/trash`, label: 'Trash' },
					{ href: `${base}/${current.key}/publish`, label: 'Publish' },
					{ href: `${base}/${current.key}/health`, label: 'Health' },
					{ href: `${base}/${current.key}/settings`, label: 'Settings' }
				]
			: []
	);

	// -- FUNCTIONS -- //

	const active = (t: { href: string; exact?: boolean }) =>
		t.exact ? page.url.pathname === t.href : page.url.pathname.startsWith(t.href);
</script>

<svelte:head><title>{data.org.name}</title></svelte:head>

<div class="flex min-h-dvh flex-col bg-bg">
	<header class="sticky top-0 z-30 border-b border-line bg-surface">
		<div class="mx-auto flex h-14 max-w-[1200px] items-center gap-3 px-4 max-sm:px-3.5">
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
			<a href={base} class="flex min-w-0 items-center gap-2 font-semibold text-ink">
				{#if data.org.logo}
					<img
						src={data.org.logo}
						alt=""
						class="size-6 rounded-md object-contain"
						data-testid="org-logo"
					/>
				{:else}
					<Mark size={24} />
				{/if}
				<span class="truncate max-sm:max-w-[28vw]" data-testid="org-name">{data.org.name}</span>
			</a>

			{#if data.projects.length}
				<div class="max-md:hidden">
					<Popover bind:open={switcher} placement="bottom-start" role="menu" label="Projects">
						{#snippet trigger({ props, toggle })}
							<Button
								variant="secondary"
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
							<ul class="min-w-56" data-testid="project-list">
								{#each data.projects as p (p.id)}
									<li>
										<a
											href={`${base}/${p.key}`}
											onclick={close}
											class="flex min-h-11 items-center gap-2 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
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

			<nav class="ml-2 flex items-center gap-1 max-md:hidden" aria-label="Project">
				{#each tabs as t (t.href)}
					<a
						href={t.href}
						aria-current={active(t) ? 'page' : undefined}
						class={cn(
							'flex min-h-9 items-center rounded-md px-2.5 text-sm text-muted hover:bg-raised hover:text-ink',
							active(t) && 'bg-accent-soft font-medium text-accent-text hover:bg-accent-soft'
						)}>{t.label}</a
					>
				{/each}
			</nav>

			<div class="ml-auto flex items-center gap-1">
				<Button
					variant="ghost"
					iconOnly
					href={`${base}/search`}
					aria-label="Search"
					data-testid="search-link"
				>
					<MagnifyingGlass size={20} />
				</Button>
				<Button
					variant="ghost"
					iconOnly
					href={`/connect?org=${data.org.slug}`}
					aria-label="Connect a tool"
				>
					<Plugs size={20} />
				</Button>
				<Button
					variant="ghost"
					iconOnly
					href={`${base}/settings`}
					aria-label="Organisation settings"
					data-testid="org-settings-link"
				>
					<Gear size={20} />
				</Button>
				<Button
					variant="ghost"
					iconOnly
					href="/settings"
					aria-label="Your account settings"
					data-testid="account-settings-link"
				>
					<UserCircle size={20} />
				</Button>
				<form method="POST" action="/sign-out" class="max-md:hidden">
					<Button type="submit" variant="ghost" size="sm">Sign out</Button>
				</form>
			</div>
		</div>
	</header>

	<main class="flex-1">
		{@render pageContent()}
	</main>
</div>

<!-- THE MENU ON A PHONE: PROJECTS, THEN THE PAGES OF THE PROJECT, THEN ACCOUNT ACTIONS -->
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
		<form method="POST" action="/sign-out" class="border-t border-line pt-2">
			<Button type="submit" variant="ghost" class="w-full justify-start">
				<SignOut size={16} /> Sign out
			</Button>
		</form>
	</nav>
</ResponsiveModal>
