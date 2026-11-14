<script lang="ts">
	// IMPORTED MODULES
	import { scrollFade } from '#lib/actions/scrollFade.js';
	import { cn } from '#lib/ui/cn.js';

	// -- TYPES -- //

	type Phase = { key: string; title: string; done: number; total: number };

	// -- REQUIRED PROPS -- //

	let { phases, class: extra }: { phases: Phase[]; class?: string } = $props();
</script>

<!-- THE PHASES OF AN ITEM AS A ROW OF SEGMENTS. EACH ONE FILLS AS ITS STEPS ARE DONE, WITH ITS NAME AND COUNT AS TEXT (ADR-005). A ROW THAT IS CUT SHOWS A FADE OF THE SURFACE AT THE EDGE WHERE IT CONTINUES, AND SNAPS TO A PHASE -->
<div class={cn(extra)}>
	<div class="group/fade relative">
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			use:scrollFade
			role="region"
			aria-label="Phases"
			tabindex="0"
			class="snap-x snap-proximity [scrollbar-width:none]! overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1 [&::-webkit-scrollbar]:hidden"
		>
			<ol class="flex w-full gap-3">
				{#each phases as p (p.key)}
					{@const pct = p.total ? Math.round((p.done / p.total) * 100) : 0}
					<li
						class="min-w-32 flex-1 snap-start"
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
		<!-- THE TWO FADES. THEY ARE GRADIENTS OF THE SURFACE TOKEN AND SHOW ONLY WHILE THE ROW CONTINUES ON THAT SIDE -->
		<span
			class="pointer-events-none absolute inset-y-0 left-0 w-6 bg-[linear-gradient(to_right,var(--surface),transparent)] opacity-0 transition-opacity group-data-[fade-start]/fade:opacity-100 motion-reduce:transition-none"
			aria-hidden="true"
		></span>
		<span
			class="pointer-events-none absolute inset-y-0 right-0 w-8 bg-[linear-gradient(to_left,var(--surface),transparent)] opacity-0 transition-opacity group-data-[fade-end]/fade:opacity-100 motion-reduce:transition-none"
			aria-hidden="true"
		></span>
	</div>
</div>
