<script lang="ts">
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import AccountSidebar from '#lib/board/AccountSidebar.svelte';
	import { cn } from '#lib/ui/cn.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import ThemeToggle from '#lib/ui/ThemeToggle.svelte';
	import { signOut } from '#lib/ui/signOut.js';
	// -- DEP-COMPONENTS -- //
	import Building2 from '@lucide/svelte/icons/building-2';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Menu from '@lucide/svelte/icons/menu';
	import Plug from '@lucide/svelte/icons/plug';
	import Settings from '@lucide/svelte/icons/settings';

	// -- REQUIRED PROPS -- //

	let { data, children: pageContent }: LayoutProps = $props();

	// -- STATES -- //

	let drawer = $state(false);
	let account = $state(false);
	/** A quiet shadow under the bar once the page has scrolled. */
	let scrolled = $state(false);

	// -- REACTIVE STATES -- //

	// An organisation scheduled for deletion is reached from the organisations list only
	const liveOrgs = $derived(data.orgs.filter((o) => !o.deleted));
	// Where the person is, shown in the top bar
	const crumb = $derived(
		page.url.pathname.startsWith('/connect')
			? 'Connect a tool'
			: page.url.pathname.startsWith('/settings')
				? 'Your settings'
				: 'Organisations'
	);
</script>

<svelte:window onscroll={() => (scrolled = window.scrollY > 4)} />

<div class="min-h-dvh md:flex">
	<AccountSidebar orgs={liveOrgs} me={data.me} />

	<div class="flex min-w-0 flex-1 flex-col">
		<!-- THE TOP BAR. THE MENU ON A PHONE, WHERE THE PERSON IS, AND THE ACCOUNT -->
		<header
			class={cn(
				'sticky top-0 z-30 border-b border-line bg-bar backdrop-blur-md transition-shadow duration-150',
				scrolled && 'shadow-[var(--elev-2)]'
			)}
		>
			<PageFrame testid="nav-frame">
				<div class="flex h-14 items-center gap-2 md:h-16 md:gap-3">
					<Button
						variant="ghost"
						iconOnly
						class="md:hidden"
						aria-label="Open the menu"
						data-testid="menu-button"
						onclick={() => (drawer = true)}
					>
						<Menu size={20} />
					</Button>
					<a
						href="/"
						class="flex min-w-0 items-center gap-2.5 text-base font-semibold text-ink md:hidden"
					>
						<Mark size={24} />
						<span class="truncate max-sm:max-w-[34vw]">Agent Flow Board</span>
					</a>
					<nav
						class="flex min-w-0 items-center gap-2 text-sm max-md:hidden"
						aria-label="Breadcrumb"
					>
						<span class="truncate font-semibold text-ink" aria-current="page">{crumb}</span>
					</nav>

					<div class="ml-auto flex items-center gap-2">
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
										<Avatar name={data.me.name || data.me.email} size={40} />
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

		<main class="flex flex-1 flex-col">
			{@render pageContent()}
		</main>
	</div>
</div>

<!-- THE MENU ON A PHONE. THE ORGANISATIONS, THEN CONNECT A TOOL, THE PERSON'S SETTINGS AND SIGN OUT -->
<ResponsiveModal open={drawer} onclose={() => (drawer = false)} title="Menu">
	<nav class="flex flex-col gap-4" aria-label="Menu">
		<ul>
			<li>
				<a
					href="/"
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><Building2 size={18} /> Organisations</a
				>
			</li>
			{#each liveOrgs as o (o.id)}
				<li>
					<a
						href={`/${o.slug}`}
						onclick={() => (drawer = false)}
						class="flex min-h-11 items-center gap-2 rounded-md px-2 pl-8 text-sm text-ink hover:bg-raised"
						><span class="truncate">{o.name}</span></a
					>
				</li>
			{/each}
		</ul>
		<ul class="border-t border-line pt-2">
			<li>
				<a
					href="/connect"
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><Plug size={18} /> Connect a tool</a
				>
			</li>
			<li>
				<a
					href="/settings"
					onclick={() => (drawer = false)}
					class="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-raised"
					><Settings size={18} /> Your settings</a
				>
			</li>
		</ul>
		<form method="POST" action="/sign-out" onsubmit={signOut} class="border-t border-line pt-2">
			<Button type="submit" variant="ghost" class="w-full justify-start">
				<LogOut size={16} /> Sign out
			</Button>
		</form>
	</nav>
</ResponsiveModal>
