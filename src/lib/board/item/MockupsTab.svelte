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
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';

	// -- REQUIRED PROPS -- //

	let { detail, env, mockups }: { detail: ItemView; env: TabEnv; mockups: ItemMockups } = $props();

	// -- REACTIVE STATES -- //

	const base = $derived(`/${env.org}/${page.params.project ?? detail.project.key}`);
	const open = $derived(mockups.open);
	const first = $derived(mockups.list[0]);
	const others = $derived(mockups.list.slice(1));
	const screens = $derived(screensOf(open?.screens));

	// -- FUNCTIONS -- //

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
</script>

<!-- THE MOCKUPS TAB OF A PLAN: THE PREVIEW OF ITS MOCKUP, AND WHAT TO KEEP AND WHAT IS FREE. A MOCKUP IS INSPIRATION, NEVER THE SPEC -->
<div class="flex flex-col gap-4" data-testid="mockups-tab">
	{#if !first}
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
		<TabCard title="Preview" padded>
			{#snippet meta()}
				<Badge tone="success">v{first.currentVersion}</Badge>
				{#if first.publicLinkOn}<Badge tone="info">Public link on</Badge>{/if}
				<span class="text-xs text-muted">{ago(first.updatedAt)}</span>
			{/snippet}
			{#snippet actions()}
				<Button href={`${base}/mockups/${first.id}`} data-testid="open-viewer">
					<ExternalLink size={16} /> Open the viewer
				</Button>
			{/snippet}
			<div class="p-4 max-sm:p-3.5">
				{#if open}
					<MockupPreview src={open.src} {screens} title={first.title} />
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
			padded
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

		{#if others.length}
			<TabCard title="Other mockups of this plan" padded>
				<ul>
					{#each others as m (m.id)}
						<li class="border-b border-line last:border-b-0">
							<a
								href={`${base}/mockups/${m.id}`}
								class="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 text-sm text-ink hover:bg-raised"
								><span class="min-w-0 flex-1 truncate">{m.title}</span>
								<span class="font-mono text-xs text-muted">v{m.currentVersion}</span></a
							>
						</li>
					{/each}
				</ul>
			</TabCard>
		{/if}
	{/if}
</div>
