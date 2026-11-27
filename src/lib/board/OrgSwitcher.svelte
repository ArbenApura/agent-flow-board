<script lang="ts">
	// IMPORTED TYPES
	import type { SwitchOrg } from '#lib/board/orgSwitch.js';
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { orderOrgs, readMemory, switchTarget } from '#lib/board/orgSwitch.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Building2 from '@lucide/svelte/icons/building-2';
	import Check from '@lucide/svelte/icons/check';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	// IMPORTED COMPONENTS
	import OrgTile from '#lib/board/OrgTile.svelte';
	import Popover from '#lib/ui/Popover.svelte';

	// -- REQUIRED PROPS -- //

	let {
		orgs,
		current,
		userId,
		open = $bindable(false),
		last = false
	}: {
		/** The organisations the person belongs to, as the org layout loads them. */
		orgs: SwitchOrg[];
		/** The slug of the organisation that is open. */
		current: string;
		/** The signed-in person, so what this browser remembers is kept per person. */
		userId: string;
		open?: boolean;
		/** True when nothing follows the switcher in the breadcrumb, so it reads as the page the person is on. */
		last?: boolean;
	} = $props();

	// -- CONSTANTS -- //

	// More than this many organisations brings a filter field into the panel
	const FILTER_FROM = 6;
	const ROW =
		'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink outline-none hover:bg-raised focus-visible:bg-raised md:min-h-10';

	// -- STATES -- //

	let q = $state('');
	let list = $state<HTMLElement>();

	// -- REACTIVE STATES -- //

	const here = $derived(orgs.find((o) => o.slug === current));
	// Read again each time the panel opens or closes, in the browser only: the panel is never rendered on the server. It is not
	// emptied on close, so the rows keep their order during the close transition
	const memory = $derived.by(() => {
		void open;
		return readMemory(userId);
	});
	const rows = $derived(
		orderOrgs(orgs, current, memory.recent).map((o) => ({
			...o,
			href: switchTarget(o.slug, current, memory.last)
		}))
	);
	const shown = $derived.by(() => {
		const term = q.trim().toLowerCase();
		return term ? rows.filter((o) => o.name.toLowerCase().includes(term)) : rows;
	});

	// -- REACTIVE STATEMENTS -- //

	// Each opening starts with an empty filter
	$effect(() => {
		if (open) untrack(() => (q = ''));
	});

	// -- FUNCTIONS -- //

	function rowLinks() {
		return [...(list?.querySelectorAll<HTMLAnchorElement>('a[data-org-row]') ?? [])];
	}

	function pick(href: string | undefined) {
		if (!href) return;
		open = false;
		void goto(href);
	}

	// Arrow keys move between the rows, Enter in the filter opens the first match, and 1 to 9 open the row at that place
	function onKey(e: KeyboardEvent) {
		const links = rowLinks();
		const inFilter = (e.target as HTMLElement | null)?.tagName === 'INPUT';
		const at = links.indexOf(document.activeElement as HTMLAnchorElement);
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const next =
				e.key === 'ArrowDown'
					? Math.min(links.length - 1, at + 1)
					: at <= 0
						? -1
						: Math.max(0, at - 1);
			if (next < 0) list?.parentElement?.querySelector<HTMLInputElement>('input')?.focus();
			else links[next]?.focus();
		} else if (e.key === 'Enter' && inFilter) {
			e.preventDefault();
			pick(shown[0]?.href);
		} else if (
			/^[1-9]$/.test(e.key) &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			(!inFilter || q === '')
		) {
			const row = shown[Number(e.key) - 1];
			if (!row) return;
			e.preventDefault();
			pick(row.href);
		}
	}
</script>

<!-- THE ORGANISATION SWITCHER. THE OPEN ORGANISATION AS THE FIRST CRUMB OF THE BAR, OPENING THE LIST OF THE PERSON'S ORGANISATIONS -->
<Popover
	bind:open
	placement="bottom-start"
	role="dialog"
	label="Switch organisation"
	offset={12}
	anchorClass="min-w-0"
>
	{#snippet trigger({ props, toggle })}
		<button
			type="button"
			onclick={toggle}
			aria-label={`Switch organisation, ${here?.name ?? current} is open`}
			data-testid="org-switcher"
			class={cn(
				'-mx-1.5 flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:min-h-9',
				last ? 'font-semibold text-ink' : 'text-muted max-md:font-semibold max-md:text-ink'
			)}
			{...props}
		>
			<span class="flex shrink-0" data-testid={here?.logo ? 'org-logo' : undefined}>
				<OrgTile name={here?.name ?? current} logo={here?.logo} palette={here?.palette} />
			</span>
			<span class="truncate max-sm:max-w-[34vw]" data-testid="org-name"
				>{here?.name ?? current}</span
			>
			<ChevronsUpDown size={16} class="shrink-0 text-muted" />
		</button>
	{/snippet}
	{#snippet children({ close })}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="w-72 max-w-[calc(100vw-32px)]" onkeydown={onKey}>
			<div class="flex items-center justify-between px-2.5 pt-2 pb-1.5 text-xs text-muted">
				<span>Switch organisation</span>
				<kbd class="rounded border border-line px-1.5 font-mono max-md:hidden">O</kbd>
			</div>
			{#if orgs.length >= FILTER_FROM}
				<div class="px-1 pb-1">
					<input
						bind:value={q}
						type="text"
						aria-label="Filter organisations"
						placeholder="Filter organisations"
						class="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
						data-testid="org-switcher-filter"
					/>
				</div>
			{/if}
			{#if shown.length === 0}
				<p class="px-2.5 py-3 text-sm text-muted">No organisation matches.</p>
			{:else}
				<ul bind:this={list} class="py-1" aria-label="Organisations">
					{#each shown as o, i (o.id)}
						<li>
							<a
								href={o.href}
								onclick={close}
								data-org-row
								data-testid="org-switcher-row"
								aria-current={o.slug === current ? 'true' : undefined}
								class={ROW}
							>
								<OrgTile name={o.name} logo={o.logo} palette={o.palette} />
								<span class="min-w-0 flex-1 truncate">{o.name}</span>
								{#if o.slug === current}
									<Check size={16} class="shrink-0 text-accent-text" aria-hidden="true" />
								{/if}
								{#if i < 9 && !q}
									<kbd
										class="rounded border border-line px-1.5 font-mono text-xs text-muted max-md:hidden"
										>{i + 1}</kbd
									>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
			<div class="border-t border-line pt-1">
				<a href="/" onclick={close} class={ROW}>
					<Building2 size={18} class="text-muted" /> All organisations
				</a>
			</div>
		</div>
	{/snippet}
</Popover>
