<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemRow, Running } from '#lib/board/rows.js';
	// -- MODULES -- //
	import { STATUS_TONE, ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Progress from '#lib/ui/Progress.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	// -- DEP-COMPONENTS -- //
	import Lock from 'phosphor-svelte/lib/Lock';
	import Warning from 'phosphor-svelte/lib/Warning';

	// -- REQUIRED PROPS -- //

	let {
		row,
		href,
		running = [],
		compact = false
	}: {
		row: ItemRow;
		href: string;
		running?: Running[];
		/** Board cards stack the parts, list rows put them on one line. */
		compact?: boolean;
	} = $props();
</script>

<!-- ONE ITEM, AS A LIST ROW OR A BOARD CARD: REFERENCE, TITLE, STATUS, PROGRESS AND WHO IS RUNNING IT -->
{#if compact}
	<a
		{href}
		data-testid="item-card"
		class="flex min-h-11 flex-col gap-2 rounded-xl border border-line bg-surface p-3 hover:bg-raised"
		data-card
	>
		<span class="flex items-center gap-1.5 text-xs text-muted">
			<span class="font-mono">{row.ref}</span>
			{#if row.visibility === 'private'}<Lock size={12} aria-label="Private" />{/if}
			{#if row.flags > 0}<Warning
					size={12}
					class="text-warning"
					aria-label="Needs attention"
				/>{/if}
		</span>
		<span class="text-sm leading-[22px] font-medium text-ink">{row.title}</span>
		<Progress value={row.percent} label={`${row.ref} progress`} />
		<span class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
			{row.doneSteps} of {row.totalSteps} steps
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
		data-testid="item-row"
		data-row
		class="flex h-full items-center gap-3 border-b border-line px-4 hover:bg-raised max-sm:px-3.5"
	>
		<span class="w-24 shrink-0 font-mono text-xs text-muted max-sm:w-20">{row.ref}</span>
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
				{row.title}
				{#if row.visibility === 'private'}<Lock size={12} aria-label="Private" />{/if}
				{#if row.flags > 0}<Warning
						size={12}
						class="text-warning"
						aria-label="Needs attention"
					/>{/if}
			</span>
			<span class="flex items-center gap-2 text-xs text-muted">
				{row.doneSteps} of {row.totalSteps} steps, {ago(row.lastActivityAt)}
				{#each running as r (r.sessionId)}<RunningBadge
						tool={r.tool}
						title={r.title}
						phase={r.phase ?? undefined}
					/>{/each}
			</span>
		</span>
		<Progress
			value={row.percent}
			label={`${row.ref} progress`}
			class="w-20 shrink-0 max-sm:hidden"
		/>
		<Badge tone={STATUS_TONE[row.status]}>{row.status.toLowerCase()}</Badge>
	</a>
{/if}
