<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import { LABEL } from '#lib/board/sidebar-classes.js';
	import { cn } from '#lib/ui/cn.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import OrgTile from '#lib/board/OrgTile.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	// -- DEP-COMPONENTS -- //
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import LogOut from '@lucide/svelte/icons/log-out';

	// -- REQUIRED PROPS -- //

	let {
		name,
		logo,
		slug,
		href,
		me,
		children
	}: {
		/** The name at the top: the organisation, or the product on the account pages. */
		name: string;
		logo?: string | null;
		/** Set on an organisation's sidebar, so the header shows the same tile as the organisation list. */
		slug?: string;
		href: string;
		me: { name: string; email: string };
		/** The links and lists of the body. */
		children: Snippet;
	} = $props();

	// -- STATES -- //

	let account = $state(false);
</script>

<!-- THE FRAME OF EVERY SIDEBAR. A SLIM RAIL OF ICONS THAT OPENS OVER THE PAGE WHEN THE POINTER OR FOCUS IS ON IT. THE NAME ON TOP, THE BODY, THEN THE ACCOUNT WITH ITS MENU. DESKTOP ONLY, A PHONE USES THE TOP BAR AND THE MENU -->
<div class="group/side sticky top-0 z-40 hidden h-dvh w-16 shrink-0 md:block" data-pinned={account}>
	<aside
		class="absolute inset-y-0 left-0 flex w-64 flex-col overflow-hidden border-r border-line bg-surface shadow-[var(--elev-2)] transition-[width,box-shadow] [transition-delay:100ms] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none side-collapsed:w-16 side-collapsed:shadow-none side-collapsed:[transition-delay:0ms]"
		aria-label="Sidebar"
		data-testid="sidebar"
	>
		<a
			{href}
			class={cn(
				'flex h-[65px] shrink-0 items-center gap-2.5 border-b border-line text-base font-semibold text-ink',
				slug ? 'px-5' : 'px-[18px]'
			)}
		>
			{#if slug}
				<span class="contents" data-testid={logo ? 'org-logo' : undefined}>
					<OrgTile {name} {slug} {logo} />
				</span>
			{:else}
				<Mark size={28} class="shrink-0" />
			{/if}
			<span class={LABEL} data-testid="org-name">{name}</span>
		</a>

		<div
			class="flex min-h-0 flex-1 [scrollbar-width:none]! flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain p-3 [&::-webkit-scrollbar]:hidden"
		>
			{@render children()}
		</div>

		<!-- THE FOOT OF THE SIDEBAR. THE ACCOUNT WITH ITS MENU -->
		<div class="flex shrink-0 flex-col gap-1 border-t border-line p-3">
			<Popover bind:open={account} placement="top-start" role="dialog" label="Account" offset={12}>
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
							<span class="truncate text-xs text-muted" data-testid="signed-in-as">{me.email}</span>
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
