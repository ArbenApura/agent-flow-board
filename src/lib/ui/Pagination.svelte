<script module lang="ts">
	// -- FUNCTIONS -- //

	/** Page numbers with gaps (null) when the list is long: 1 ... 4 5 6 ... 20. */
	export function pageWindow(page: number, count: number): (number | null)[] {
		if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
		const out: (number | null)[] = [1];
		const from = Math.max(2, page - 1);
		const to = Math.min(count - 1, page + 1);
		if (from > 2) out.push(null);
		for (let p = from; p <= to; p++) out.push(p);
		if (to < count - 1) out.push(null);
		out.push(count);
		return out;
	}
</script>

<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	// -- REQUIRED PROPS -- //

	let {
		page = $bindable(1),
		count,
		onchange
	}: { page?: number; count: number; onchange?: (page: number) => void } = $props();

	// -- FUNCTIONS -- //

	function go(next: number) {
		if (next < 1 || next > count || next === page) return;
		page = next;
		onchange?.(next);
	}

	const btn =
		'inline-flex size-11 cursor-pointer items-center justify-center rounded-lg border text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';
</script>

<nav aria-label="Pages" class="flex flex-wrap items-center gap-1">
	<button
		type="button"
		class={cn(btn, 'border-line bg-surface')}
		aria-label="Previous page"
		disabled={page <= 1}
		onclick={() => go(page - 1)}
	>
		<ChevronLeft size={16} />
	</button>
	{#each pageWindow(page, count) as p, i (p ?? `gap-${i}`)}
		{#if p === null}
			<span class="inline-flex size-11 items-center justify-center text-muted" aria-hidden="true"
				>...</span
			>
		{:else}
			<button
				type="button"
				class={cn(
					btn,
					p === page
						? 'border-accent bg-accent-soft text-accent-text'
						: 'border-line bg-surface text-ink'
				)}
				aria-label={`Page ${p}`}
				aria-current={p === page ? 'page' : undefined}
				onclick={() => go(p)}
			>
				{p}
			</button>
		{/if}
	{/each}
	<button
		type="button"
		class={cn(btn, 'border-line bg-surface')}
		aria-label="Next page"
		disabled={page >= count}
		onclick={() => go(page + 1)}
	>
		<ChevronRight size={16} />
	</button>
</nav>
