<script lang="ts">
	// IMPORTED TYPES
	import type { OrgPalette } from '#lib/server/db/schema/core.js';
	// IMPORTED ENVS
	import { page } from '$app/state';
	// IMPORTED MODULES
	import OrgTile from '#lib/board/OrgTile.svelte';
	import { LABEL } from '#lib/board/sidebar-classes.js';
	import SidebarHeading from '#lib/board/SidebarHeading.svelte';
	import SidebarRow from '#lib/board/SidebarRow.svelte';
	import SidebarShell from '#lib/board/SidebarShell.svelte';
	// IMPORTED DEP-COMPONENTS
	import Building2 from '@lucide/svelte/icons/building-2';
	import Plug from '@lucide/svelte/icons/plug';
	import Settings from '@lucide/svelte/icons/settings';

	// -- REQUIRED PROPS -- //

	let {
		orgs,
		me
	}: {
		orgs: {
			id: string;
			name: string;
			slug: string;
			logo?: string | null;
			palette?: OrgPalette | null;
		}[];
		me: { id?: string; name: string; email: string; imageV?: number | null };
	} = $props();
</script>

<!-- THE SIDEBAR OF THE PAGES THAT BELONG TO NO ORGANISATION. THE ORGANISATIONS OF THE PERSON, THEN AT THE FOOT CONNECT A TOOL AND THE PERSON'S OWN SETTINGS, IN THE ORDER OF AN ORGANISATION'S FOOT -->
<SidebarShell name="Agent Flow Board" href="/" {me}>
	<nav class="flex flex-col gap-1" aria-label="Account">
		<SidebarRow
			href="/"
			label="Organisations"
			icon={Building2}
			active={page.url.pathname === '/'}
		/>
	</nav>

	{#if orgs.length}
		<nav class="flex flex-col gap-1" aria-label="Your organisations" data-testid="org-list">
			<SidebarHeading label="Your organisations" />
			{#each orgs as o (o.id)}
				<a
					href={`/${o.slug}`}
					title={o.name}
					class="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
				>
					<OrgTile name={o.name} logo={o.logo} palette={o.palette} />
					<span class={LABEL}>{o.name}</span>
				</a>
			{/each}
		</nav>
	{/if}

	<nav class="mt-auto flex flex-col gap-1" aria-label="Settings">
		<SidebarRow
			href="/connect"
			label="Connect a tool"
			icon={Plug}
			active={page.url.pathname.startsWith('/connect')}
		/>
		<SidebarRow
			href="/settings"
			label="Your settings"
			icon={Settings}
			active={page.url.pathname.startsWith('/settings')}
		/>
	</nav>
</SidebarShell>
