<script lang="ts">
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import History from '@lucide/svelte/icons/history';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Notice from '#lib/ui/Notice.svelte';

	// -- REQUIRED PROPS -- //

	let {
		changelog
	}: {
		/** The newest releases first, each with the skills it changed, as "name version". */
		changelog: { version: string; date: string; notes: string[]; touched: string[] }[];
	} = $props();

	// -- CONSTANTS -- //

	// A note longer than this is cut to three lines until the person asks for the rest
	const LONG = 200;

	// -- STATES -- //

	let open = $state<Record<string, boolean>>({});
</script>

<!-- WHAT CHANGED: THE NEWEST RELEASES FIRST, AS A TIMELINE. THE LINE GROWS DOWN ONCE WHEN IT APPEARS -->
<Card
	data-testid="skills-changelog"
	icon={History}
	title="What changed"
	description="The newest releases first."
>
	<ol>
		{#each changelog as c, i (c.version)}
			{@const text = c.notes.join(' ')}
			<li class={cn('relative flex gap-4', i < changelog.length - 1 && 'pb-6')}>
				{#if i < changelog.length - 1}
					<span class="grow-in absolute top-6 bottom-0 left-[11px] w-px bg-line" aria-hidden="true"
					></span>
				{/if}
				<span
					class={cn(
						'relative mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 bg-surface',
						i === 0 ? 'border-accent' : 'border-line'
					)}
					aria-hidden="true"
				>
					<span class={cn('size-2 rounded-full', i === 0 ? 'bg-accent' : 'bg-muted')}></span>
				</span>
				<div class="min-w-0 flex-1">
					<p class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
						<span class="font-mono">{c.version}</span>
						<span class="font-normal text-muted tabular-nums">{c.date}</span>
						{#if i === 0}<Badge tone="success">Latest</Badge>{/if}
					</p>
					{#if c.touched.length}
						<p class="mt-1.5 flex flex-wrap gap-1">
							{#each c.touched as t (t)}
								<span
									class="inline-flex items-center rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-xs text-ink"
									>{t}</span
								>
							{/each}
						</p>
					{/if}
					<div class={cn('mt-2 text-sm text-muted', !open[c.version] && 'line-clamp-3')}>
						{#each c.notes as n, k (k)}<p>{n}</p>{/each}
					</div>
					{#if text.length > LONG}
						<button
							type="button"
							aria-expanded={!!open[c.version]}
							onclick={() => (open[c.version] = !open[c.version])}
							class="mt-1 inline-flex min-h-11 cursor-pointer items-center gap-1 text-sm font-medium text-accent-text hover:underline"
							>{open[c.version] ? 'Show less' : 'Show more'}</button
						>
					{/if}
				</div>
			</li>
		{/each}
	</ol>
</Card>

<Notice tone="info">
	To see whether your agent is current, ask it to check what it has installed against this release.
</Notice>
