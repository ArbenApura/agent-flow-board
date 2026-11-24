<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { ItemMockups } from '#lib/server/web/itemMockups.js';
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { mockupPrompt, screensOf } from '#lib/board/mockups.js';
	import { ago } from '#lib/board/status.js';
	import MockupHistoryDrawer from '#lib/board/MockupHistoryDrawer.svelte';
	import MockupPreview from '#lib/board/MockupPreview.svelte';
	import MockupThumb from '#lib/board/MockupThumb.svelte';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Clock from '@lucide/svelte/icons/clock';
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import History from '@lucide/svelte/icons/history';

	// -- REQUIRED PROPS -- //

	let { detail, env, mockups }: { detail: ItemView; env: TabEnv; mockups: ItemMockups } = $props();

	// -- STATES -- //

	let chipRow = $state<HTMLElement>();
	let pickerOpen = $state(false);
	let historyOpen = $state(false);

	// -- REACTIVE STATES -- //

	const base = $derived(`/${env.org}/${page.params.project ?? detail.project.key}`);
	const open = $derived(mockups.open);
	// The mockup on show: the one the preview was loaded for, otherwise the newest
	const current = $derived(mockups.list.find((m) => m.id === open?.id) ?? mockups.list[0]);
	const screens = $derived(screensOf(open?.screens));
	// The version on show, and the newest: an older one gets a banner and a way back
	const viewing = $derived(open?.version ?? current?.currentVersion ?? 1);
	const newest = $derived(current?.currentVersion ?? 1);
	const versions = $derived(open?.versions ?? []);
	// The facts of the version on show, for the stamp in the card header
	const stamp = $derived(versions.find((v) => v.number === viewing));
	// Versions are listed newest first, so the one before the place of the version on show is the newer one
	const place = $derived(versions.findIndex((v) => v.number === viewing));
	const newer = $derived(place > 0 ? versions[place - 1].number : null);
	const older = $derived(
		place >= 0 && place < versions.length - 1 ? versions[place + 1].number : null
	);
	const kb = (n: number) =>
		n < 1024 * 1024
			? `${Math.max(1, Math.round(n / 1024))} KB`
			: `${(n / 1024 / 1024).toFixed(1)} MB`;

	// -- FUNCTIONS -- //

	/** The address of the tab with one mockup chosen. It keeps nothing of the last choices, which belong to the other mockup. */
	const hrefOf = (id: string) => `${page.url.pathname}?tab=mockups&m=${id}`;

	/** The address of the mockup on show at one of its versions. The newest has no version in the address. */
	const versionHref = (n: number) =>
		n === newest ? hrefOf(current?.id ?? '') : `${hrefOf(current?.id ?? '')}&v=${n}`;

	/** Copies an earlier version on top as the newest, as the viewer does, then shows it. */
	async function restore(n: number) {
		if (!current) return;
		const id = current.id;
		try {
			await toast.promise(
				api(env.org, `/mockups/${id}/restore`, {
					method: 'POST',
					body: { version: n },
					key: newKey()
				}),
				{
					loading: `Restoring version ${n}...`,
					success: `Version ${n} is now the newest.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The version was not restored.')
				}
			);
			historyOpen = false;
			await goto(hrefOf(id), { invalidateAll: true });
		} catch {
			// The promise toast already shows the failure
		}
	}

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(
				`${mockupPrompt(detail.project.name)} It is for plan ${detail.item.ref}: ${detail.item.title}.`
			);
			toast.success('Prompt copied. Paste it into your coding tool.');
		} catch {
			toast.error('The prompt could not be copied. Select it and copy by hand.');
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// The mockup on show slides to the centre of the chip row, which scrolls sideways on a phone
	$effect(() => {
		void current?.id;
		const row = chipRow;
		const active = row?.querySelector<HTMLElement>('[aria-current="true"]');
		if (!row || !active) return;
		const left =
			active.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - active.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});
</script>

<!-- THE MOCKUPS TAB OF A PLAN: THE PREVIEW OF ITS MOCKUP, AND WHAT TO KEEP AND WHAT IS FREE. A BUILD OF THE PLAN FOLLOWS ITS MOCKUP (AFB-20261110-2331) -->
<div class="flex flex-col gap-4" data-testid="mockups-tab">
	{#if !current}
		<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
			<EmptyState
				kind="files"
				title="No mockup for this plan"
				text="Ask your coding tool for a mockup when you want one. The mockup shows here and on the Mockups page."
			>
				{#snippet action()}
					{#if env.canWrite}
						<Button variant="primary" onclick={copyPrompt}
							><Copy size={16} /> Copy the prompt</Button
						>
					{/if}
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<TabCard title="Preview" stack>
			{#snippet meta()}
				<!-- WHETHER THE VERSION ON SHOW IS THE NEWEST, THEN WHEN IT WAS PUBLISHED AND HOW BIG IT IS. ITS NUMBER IS IN THE VERSION ROW BELOW -->
				<span class="flex flex-wrap items-center gap-x-2.5 gap-y-1" data-testid="version-stamp">
					<Badge tone={viewing === newest ? 'success' : 'neutral'}
						>{viewing === newest ? 'Newest version' : 'Older version'}</Badge
					>
					{#if stamp}
						<span class="inline-flex items-center gap-1 text-xs text-muted">
							<Clock size={13} class="shrink-0" aria-hidden="true" />
							Published {ago(stamp.createdAt)}
							<span aria-hidden="true">·</span>
							{kb(stamp.size)}
						</span>
					{/if}
					{#if current.publicLinkOn}<Badge tone="info">Public link on</Badge>{/if}
				</span>
			{/snippet}
			{#snippet actions()}
				<Button href={`${base}/mockups/${current.id}`} data-testid="open-viewer">
					<ExternalLink size={16} /> Open the viewer
				</Button>
			{/snippet}

			<!-- ONE CHIP FOR EACH MOCKUP OF THE PLAN, ONLY WHEN THERE ARE TWO OR MORE. EACH IS A LINK, SO THE ADDRESS AND THE BACK BUTTON FOLLOW THE CHOICE -->
			{#if mockups.list.length > 1}
				<nav
					bind:this={chipRow}
					aria-label="Mockups of this plan"
					class="flex [scrollbar-width:none]! gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-line p-3 max-sm:p-2.5 [&::-webkit-scrollbar]:hidden"
					data-testid="mockup-switcher"
				>
					{#each mockups.list as m (m.id)}
						{@const on = m.id === current.id}
						<a
							href={hrefOf(m.id)}
							data-sveltekit-noscroll
							aria-current={on ? 'true' : undefined}
							class={cn(
								'flex min-h-14 max-w-72 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border p-1.5 pr-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
								on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-raised'
							)}
						>
							<span class="w-16 shrink-0"
								><MockupThumb id={m.id} src={m.thumb} live={m.live} /></span
							>
							<span class="flex min-w-0 flex-col">
								<span
									class={cn('truncate text-sm font-semibold', on ? 'text-accent-text' : 'text-ink')}
									>{m.title}</span
								>
								<span class="font-mono text-xs text-muted">v{m.currentVersion}</span>
							</span>
						</a>
					{/each}
				</nav>
			{/if}

			<!-- THE VERSION ROW: OLDER AND NEWER ARE LINKS, SO THE ADDRESS AND THE BACK BUTTON FOLLOW THE CHOICE. HISTORY OPENS THE SAME DRAWER AS THE VIEWER -->
			{#if open && versions.length > 0}
				<div
					class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line p-3 max-sm:p-2.5"
					data-testid="mockup-version-row"
				>
					<!-- ONE JOINED CONTROL: THE VERSION BEFORE, THE LIST OF EVERY VERSION, THE VERSION AFTER. THE ARROWS AND THE LIST ROWS ARE LINKS, SO THE ADDRESS AND THE BACK BUTTON FOLLOW THE CHOICE -->
					<div
						class="inline-flex h-10 max-w-full overflow-hidden rounded-lg border border-line bg-surface max-sm:h-11"
						data-testid="version-picker"
					>
						{#if older !== null}
							<a
								href={versionHref(older)}
								data-sveltekit-noscroll
								aria-label={`Version ${older}, the one before`}
								class="grid w-10 cursor-pointer place-items-center text-ink hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-sm:w-11"
								><ChevronLeft size={18} aria-hidden="true" /></a
							>
						{:else}
							<span
								class="grid w-10 place-items-center text-muted opacity-40 max-sm:w-11"
								aria-hidden="true"><ChevronLeft size={18} /></span
							>
						{/if}
						<Popover
							bind:open={pickerOpen}
							label="Versions of this mockup"
							anchorClass="flex min-w-0"
						>
							{#snippet trigger({ props, toggle })}
								<button
									type="button"
									{...props}
									onclick={toggle}
									aria-label="Choose a version"
									data-testid="version-trigger"
									class="flex min-w-0 cursor-pointer items-center gap-1.5 border-x border-line px-3.5 text-sm hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:min-w-44"
								>
									<span class="font-medium whitespace-nowrap text-ink">Version {viewing}</span>
									<span class="whitespace-nowrap text-muted">of {newest}</span>
									<ChevronDown size={16} class="ml-auto shrink-0 text-muted" aria-hidden="true" />
								</button>
							{/snippet}
							{#snippet children({ close })}
								<ul class="max-h-80 min-w-80 overflow-y-auto p-1 max-sm:min-w-64">
									{#each versions as v (v.number)}
										{@const on = v.number === viewing}
										<li>
											<a
												href={versionHref(v.number)}
												data-sveltekit-noscroll
												onclick={close}
												aria-current={on ? 'page' : undefined}
												class={cn(
													'flex min-h-12 cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-sm:min-h-14',
													on ? 'bg-accent-soft text-accent-text' : 'text-ink hover:bg-raised'
												)}
											>
												<span class="min-w-0 flex-1">
													<span class="block font-medium">Version {v.number}</span>
													<span class={cn('block text-xs', on ? 'text-accent-text' : 'text-muted')}
														>{ago(v.createdAt)}, {kb(v.size)}{v.restoredFrom
															? `, copied from version ${v.restoredFrom}`
															: ''}</span
													>
												</span>
												{#if v.number === newest}<Badge tone="success">Newest</Badge>{/if}
												{#if on}<Check size={16} class="shrink-0" aria-hidden="true" />{/if}
											</a>
										</li>
									{/each}
								</ul>
							{/snippet}
						</Popover>
						{#if newer !== null}
							<a
								href={versionHref(newer)}
								data-sveltekit-noscroll
								aria-label={`Version ${newer}, the one after`}
								class="grid w-10 cursor-pointer place-items-center text-ink hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-sm:w-11"
								><ChevronRight size={18} aria-hidden="true" /></a
							>
						{:else}
							<span
								class="grid w-10 place-items-center text-muted opacity-40 max-sm:w-11"
								aria-hidden="true"><ChevronRight size={18} /></span
							>
						{/if}
					</div>
					<Button class="ml-auto" onclick={() => (historyOpen = true)} data-testid="history-button">
						<History size={16} /> History
					</Button>
				</div>
				{#if viewing !== newest}
					<div class="p-3 pb-0 max-sm:p-2.5 max-sm:pb-0">
						<Notice tone="warning" data-testid="not-current-notice">
							<span class="flex flex-wrap items-center gap-x-3 gap-y-2">
								<span>You are looking at version {viewing}. The newest is version {newest}.</span>
								<span class="flex gap-2">
									<Button size="sm" href={versionHref(newest)} data-sveltekit-noscroll
										>Show the newest</Button
									>
									{#if open.canWrite}
										<Button size="sm" onclick={() => restore(viewing)}>Restore this version</Button>
									{/if}
								</span>
							</span>
						</Notice>
					</div>
				{/if}
			{/if}
			<div class="p-4 max-sm:p-3.5">
				{#if open}
					<MockupPreview src={open.src} {screens} title={current.title} flush />
				{:else}
					<p class="text-sm text-muted">Loading the preview...</p>
				{/if}
			</div>
		</TabCard>

		{#if open}
			<MockupHistoryDrawer
				open={historyOpen}
				onclose={() => (historyOpen = false)}
				{versions}
				current={newest}
				{viewing}
				canWrite={open.canWrite}
				hrefFor={versionHref}
				onrestore={restore}
			/>
		{/if}

		<TabCard
			title="Build notes"
			collapsible
			startCollapsed
			storageKey={`afb:collapse:${env.org}:${detail.item.id}:mockup-notes`}
		>
			{#snippet meta()}
				<!-- THE NOTES BELONG TO THE VERSION ON SHOW, SO AN OLDER ONE SAYS WHICH -->
				{#if viewing !== newest}
					<span class="text-xs text-muted">Notes of version {viewing}</span>
				{/if}
			{/snippet}
			<div class="flex flex-col gap-4 p-4 max-sm:p-3.5" data-testid="build-notes">
				<!-- PLAIN TEXT ONLY: THE NOTES WERE WRITTEN BY WHOEVER PUBLISHED, SO THEY ARE NEVER RENDERED AS MARKUP -->
				{#if open?.notes && (open.notes.keep || open.notes.free)}
					<section>
						<h3 class="text-sm font-semibold text-ink">Keep</h3>
						<p class="text-xs text-muted">
							Layout, hierarchy, flow, states and copy the build keeps.
						</p>
						<p class="mt-1 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
							{open.notes.keep || 'Nothing written.'}
						</p>
					</section>
					<section>
						<h3 class="text-sm font-semibold text-ink">Free</h3>
						<p class="text-xs text-muted">
							Pixels, colours and invented components the build may change.
						</p>
						<p class="mt-1 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
							{open.notes.free || 'Nothing written.'}
						</p>
					</section>
					{#if open.notes.author}<p class="text-xs text-muted">
							Written by {open.notes.author}.
						</p>{/if}
				{:else}
					<p class="text-sm text-muted">The tool that made this mockup left no build notes.</p>
				{/if}
			</div>
		</TabCard>
	{/if}
</div>
