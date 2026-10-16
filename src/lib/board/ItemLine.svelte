<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemRow, Running } from '#lib/board/rows.js';
	// -- MODULES -- //
	import { STATUS_TONE, ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	// -- DEP-COMPONENTS -- //
	import Lock from '@lucide/svelte/icons/lock';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	// -- REQUIRED PROPS -- //

	let {
		row,
		href,
		running = [],
		compact = false,
		onopen
	}: {
		row: ItemRow;
		href: string;
		running?: Running[];
		/** Board cards stack the parts, list rows put them on one line. */
		compact?: boolean;
		/** Given, a plain click opens a quick look in a drawer, and a modified click or a middle click still opens the page. */
		onopen?: (row: ItemRow) => void;
	} = $props();

	// -- FUNCTIONS -- //

	function peek(e: MouseEvent) {
		if (!onopen || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		onopen(row);
	}
</script>

<!-- ONE ITEM, AS A LIST ROW OR A BOARD CARD. REFERENCE, TITLE, STATUS, A PROGRESS RING AND WHO IS RUNNING IT -->
{#if compact}
	<a
		{href}
		onclick={peek}
		data-testid="item-card"
		class="group flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] transition-colors hover:border-muted"
		data-card
	>
		<span class="flex items-center gap-2 text-xs text-muted">
			<span class="font-mono">{row.ref}</span>
			{#if row.visibility === 'private'}<Lock size={14} aria-label="Private" />{/if}
			{#if row.flags > 0}<TriangleAlert
					size={14}
					class="text-warning"
					aria-label="Needs attention"
				/>{/if}
			<ProgressRing value={row.percent} label={`${row.ref} progress`} size={36} class="ml-auto" />
		</span>
		<span class="-mt-1 text-sm leading-6 font-medium text-ink">{row.title}</span>
		<span class="flex flex-wrap items-center gap-2 text-xs text-muted">
			<span class="tabular-nums">{row.doneSteps} of {row.totalSteps} steps</span>
			{#each running as r (r.sessionId)}<RunningBadge
					tool={r.tool}
					title={r.title}
					phase={r.phase ?? undefined}
				/>{/each}
		</span>
	</a>
{:else}
	<a
		{href}
		onclick={peek}
		data-testid="item-row"
		data-row
		class="flex h-full items-center gap-4 border-b border-line px-5 hover:bg-raised max-sm:px-4"
	>
		<span class="w-24 shrink-0 font-mono text-xs text-muted max-sm:w-20">{row.ref}</span>
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
				{row.title}
				{#if row.visibility === 'private'}<Lock size={14} aria-label="Private" />{/if}
				{#if row.flags > 0}<TriangleAlert
						size={14}
						class="text-warning"
						aria-label="Needs attention"
					/>{/if}
			</span>
			<span class="flex items-center gap-2 text-xs text-muted">
				<span class="tabular-nums"
					>{row.doneSteps} of {row.totalSteps} steps, {ago(row.lastActivityAt)}</span
				>
				{#each running as r (r.sessionId)}<RunningBadge
						tool={r.tool}
						title={r.title}
						phase={r.phase ?? undefined}
					/>{/each}
			</span>
		</span>
		<ProgressRing
			value={row.percent}
			label={`${row.ref} progress`}
			size={28}
			class="shrink-0 max-sm:hidden"
		/>
		<Badge tone={STATUS_TONE[row.status]}>{row.status.toLowerCase()}</Badge>
	</a>
{/if}
