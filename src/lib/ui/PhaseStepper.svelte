<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- TYPES -- //

	type Phase = { key: string; title: string; done: number; total: number };

	// -- REQUIRED PROPS -- //

	let { phases, class: extra }: { phases: Phase[]; class?: string } = $props();
</script>

<!-- THE PHASES OF AN ITEM AS A ROW OF SEGMENTS. EACH ONE FILLS AS ITS STEPS ARE DONE, WITH ITS NAME AND COUNT AS TEXT (ADR-005) -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div role="region" aria-label="Phases" tabindex="0" class={cn('overflow-x-auto pb-1', extra)}>
	<ol class="flex w-full gap-3">
		{#each phases as p (p.key)}
			{@const pct = p.total ? Math.round((p.done / p.total) * 100) : 0}
			<li
				class="min-w-32 flex-1"
				aria-label={`Phase ${p.key} ${p.title}, ${p.done} of ${p.total} steps`}
			>
				<div class="h-2 overflow-hidden rounded-full bg-raised">
					<!-- DYNAMIC RUNTIME WIDTH -->
					<div
						class={cn('h-full rounded-full', pct === 100 ? 'bg-success' : 'bg-info')}
						style="width:{pct}%"
					></div>
				</div>
				<p class="mt-2 flex items-baseline gap-1.5 text-xs text-muted">
					<span class="font-mono">{p.key}</span>
					<span class="min-w-0 flex-1 truncate text-ink">{p.title}</span>
					<span class="tabular-nums">{p.done}/{p.total}</span>
				</p>
			</li>
		{/each}
	</ol>
</div>
