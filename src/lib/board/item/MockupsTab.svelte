<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { ItemMockups } from '#lib/server/web/itemMockups.js';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import { mockupPrompt, screensOf } from '#lib/board/mockups.js';
	import { ago } from '#lib/board/status.js';
	import MockupPreview from '#lib/board/MockupPreview.svelte';
	import MockupThumb from '#lib/board/MockupThumb.svelte';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';

	// -- REQUIRED PROPS -- //

	let { detail, env, mockups }: { detail: ItemView; env: TabEnv; mockups: ItemMockups } = $props();

	// -- STATES -- //

	let chipRow = $state<HTMLElement>();

	// -- REACTIVE STATES -- //

	const base = $derived(`/${env.org}/${page.params.project ?? detail.project.key}`);
	const open = $derived(mockups.open);
	// The mockup on show: the one the preview was loaded for, otherwise the newest
	const current = $derived(mockups.list.find((m) => m.id === open?.id) ?? mockups.list[0]);
	const screens = $derived(screensOf(open?.screens));

	// -- FUNCTIONS -- //

	/** The address of the tab with one mockup chosen. It keeps nothing of the last choices, which belong to the other mockup. */
	const hrefOf = (id: string) => `${page.url.pathname}?tab=mockups&m=${id}`;

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
				text="Say yes to the mockup offer when your tool asks, or ask it for one. The mockup shows here and on the Mockups page."
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
				<Badge tone="success">v{current.currentVersion}</Badge>
				{#if current.publicLinkOn}<Badge tone="info">Public link on</Badge>{/if}
				<span class="text-xs text-muted">{ago(current.updatedAt)}</span>
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
			<div class="p-4 max-sm:p-3.5">
				{#if open}
					<MockupPreview src={open.src} {screens} title={current.title} flush />
				{:else}
					<p class="text-sm text-muted">Loading the preview...</p>
				{/if}
			</div>
		</TabCard>

		<TabCard
			title="Build notes"
			collapsible
			startCollapsed
			storageKey={`afb:collapse:${env.org}:${detail.item.id}:mockup-notes`}
		>
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
