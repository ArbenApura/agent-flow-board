<script lang="ts">
	// -- TYPES -- //
	import type { MockupRow } from '#lib/board/mockups.js';
	// -- MODULES -- //
	import { ago } from '#lib/board/status.js';
	import MockupThumb from '#lib/board/MockupThumb.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	// -- DEP-COMPONENTS -- //
	import Globe from '@lucide/svelte/icons/globe';
	import Lock from '@lucide/svelte/icons/lock';
	import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';

	// -- REQUIRED PROPS -- //

	let { mockup, href }: { mockup: MockupRow; href: string } = $props();
</script>

<!-- ONE MOCKUP AS A CARD: A WIDE PREVIEW ACROSS THE TOP, THEN ITS TITLE AND THE PLAN IT BELONGS TO. THE WHOLE CARD IS ONE LINK -->
<a
	{href}
	data-testid="mockup"
	data-card
	class="flex cursor-pointer flex-col gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:p-3.5"
>
	<!-- THE PREVIEW IS THE SCREENSHOT OF THE CURRENT VERSION, OR A LIVE PREVIEW WHEN THERE IS NONE, OVER A QUIET PLACEHOLDER -->
	{#if mockup.thumb}
		<MockupThumb id={mockup.id} src={mockup.thumb} live={mockup.live ?? false} />
	{:else}
		<span
			data-card-preview
			class="flex aspect-[16/10] w-full items-center justify-center rounded-lg border border-line bg-raised"
		>
			<PanelsTopLeft size={24} class="text-muted" aria-hidden="true" />
		</span>
	{/if}
	<span class="flex min-w-0 flex-col gap-1.5">
		<span class="line-clamp-2 text-sm leading-6 font-semibold [overflow-wrap:anywhere] text-ink"
			>{mockup.title}</span
		>
		{#if mockup.plan}
			<span class="truncate font-mono text-xs text-muted">{mockup.plan.ref}</span>
		{:else}
			<span class="text-xs text-muted">Not on a plan</span>
		{/if}
		<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
			<span class="font-mono">v{mockup.currentVersion}</span>
			<span aria-hidden="true">·</span>
			<span>{ago(mockup.updatedAt)}</span>
			{#if mockup.publicLinkOn}
				<Badge tone="info"><Globe size={12} aria-hidden="true" /> Public</Badge>
			{:else if mockup.visibility === 'private'}
				<Badge><Lock size={12} aria-hidden="true" /> Private</Badge>
			{/if}
		</span>
	</span>
</a>
