<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemRow, Running } from '#lib/board/rows.js';
	// IMPORTED MODULES
	import { draggable } from '#lib/actions/dnd.svelte.js';
	import { LIST_COLS, STATUS_STYLE, ago } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	import Progress from '#lib/ui/Progress.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	// IMPORTED DEP-COMPONENTS
	import Lock from '@lucide/svelte/icons/lock';
	import Play from '@lucide/svelte/icons/play';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	// -- REQUIRED PROPS -- //

	let {
		row,
		href,
		running = [],
		compact = false,
		dragEnabled = false,
		onContinue
	}: {
		row: ItemRow;
		href: string;
		running?: Running[];
		/** Board cards stack the parts, list rows put them on one line. */
		compact?: boolean;
		/** A board card can be dragged to another status column. */
		dragEnabled?: boolean;
		/** Given, a small button on a board card opens the Continue with dialog for this item. */
		onContinue?: (row: ItemRow) => void;
	} = $props();
</script>

<!-- ONE ITEM, AS A LIST ROW OR A BOARD CARD. REFERENCE, TITLE, STATUS, A PROGRESS RING AND WHO IS RUNNING IT -->
{#if compact}
	<!-- THE BUTTON IS A SIBLING OF THE LINK, NEVER INSIDE IT, SO A CLICK ON IT CANNOT OPEN THE ITEM OR START A DRAG -->
	<div class="group relative">
		<a
			{href}
			use:draggable={{ id: row.ref, disabled: !dragEnabled }}
			data-testid="item-card"
			class="group relative flex flex-col gap-2.5 overflow-hidden rounded-xl border border-line bg-surface py-3.5 pr-3.5 pl-4.5 transition-colors hover:border-muted"
			data-card
		>
			<!-- STATUS RAIL -->
			<span
				class={cn('absolute inset-y-0 left-0 w-[3px]', STATUS_STYLE[row.status].rail)}
				aria-hidden="true"
			></span>
			<span
				class={cn(
					'flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted',
					onContinue && 'pr-10'
				)}
			>
				<span class="font-mono [overflow-wrap:anywhere]">{row.ref}</span>
				{#if row.visibility === 'private'}
					<span
						class="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 text-badge font-semibold text-danger"
						><Lock size={12} aria-hidden="true" />Private</span
					>
				{/if}
				{#if row.flags > 0}<TriangleAlert
						size={14}
						class="ml-auto text-warning"
						aria-label="Needs attention"
					/>{/if}
			</span>
			<span class="line-clamp-2 text-sm leading-6 font-semibold text-ink">{row.title}</span>
			<span class="flex items-center gap-2.5">
				<Progress
					value={row.percent}
					label={`${row.ref} progress`}
					fill={STATUS_STYLE[row.status].rail}
				/>
				<span
					class="w-10 shrink-0 text-right text-xs font-semibold whitespace-nowrap text-ink tabular-nums"
					>{row.percent}%</span
				>
			</span>
			<span class="flex items-center justify-between gap-2.5 text-xs text-muted">
				<span class="tabular-nums">
					{row.doneSteps} of {row.totalSteps} steps{#if !row.isLegacy}
						· Verified {row.verifiedPercent !== null ? `${row.verifiedPercent}%` : 'n/a'}{/if}
				</span>
				<span class="whitespace-nowrap">{ago(row.lastActivityAt)}</span>
			</span>
			<span class="flex flex-wrap items-center gap-2 text-xs text-muted">
				<span class="rounded-md bg-raised px-1.5 font-medium">{row.stream}/{row.scope}</span>
				{#if row.unverifiedVisually}
					<Badge tone="warning" data-testid="unverified-visually-badge">UNVERIFIED VISUALLY</Badge>
				{/if}
				{#each running as r (r.sessionId)}<RunningBadge
						tool={r.tool}
						title={r.title}
						phase={r.phase ?? undefined}
						staleMinutes={r.staleMinutes}
						mockupUnread={r.mockupUnread}
						reviewIdle={r.reviewIdle}
						waiting={r.waiting}
					/>{/each}
			</span>
		</a>
		{#if onContinue}
			<!-- JUST THE ICON, SMALL, AND ONLY WHEN THE POINTER IS ON THE CARD OR THE BUTTON HAS FOCUS. A TOUCH SCREEN HAS NO HOVER, SO IT IS ALWAYS THERE. THE HIT AREA IS 44 PX ON A PHONE -->
			<button
				type="button"
				onclick={() => onContinue(row)}
				aria-label={`Resume ${row.ref} with a coding tool`}
				title="Resume with a coding tool"
				data-testid="card-continue"
				class="absolute top-2 right-2 inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface text-ink opacity-0 shadow-[var(--elev-1)] transition-[opacity,background-color,border-color] duration-150 group-focus-within:opacity-100 group-hover:opacity-100 hover:border-muted hover:bg-raised focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none max-sm:size-11 max-sm:opacity-100 [@media(hover:none)]:opacity-100"
			>
				<Play size={14} fill="currentColor" aria-hidden="true" />
			</button>
		{/if}
	</div>
{:else}
	<!-- A LIST ROW. THE COLUMNS MATCH THE HEADER ABOVE THE LIST (LIST_COLS) -->
	<a
		{href}
		data-testid="item-row"
		data-row
		class="flex h-full items-center gap-4 overflow-hidden border-b border-line px-5 py-2 hover:bg-raised max-sm:px-4"
	>
		<span
			class={cn('font-mono text-xs leading-4 [overflow-wrap:anywhere] text-muted', LIST_COLS.ref)}
			>{row.ref}</span
		>
		<span class="flex min-w-0 flex-1 flex-col">
			<span class="flex items-center gap-1.5 text-sm font-semibold text-ink">
				<span class="truncate">{row.title}</span>
				{#if row.visibility === 'private'}<Lock
						size={14}
						class="shrink-0 text-muted"
						aria-label="Private"
					/>{/if}
				{#if row.flags > 0}<TriangleAlert
						size={14}
						class="shrink-0 text-warning"
						aria-label="Needs attention"
					/>{/if}
			</span>
			<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
				<span class="tabular-nums">
					{row.doneSteps} of {row.totalSteps} steps{#if !row.isLegacy}
						· Verified {row.verifiedPercent !== null ? `${row.verifiedPercent}%` : 'n/a'}{/if}
				</span>
				{#if row.unverifiedVisually}
					<Badge tone="warning" data-testid="unverified-visually-badge">UNVERIFIED VISUALLY</Badge>
				{/if}
				{#each running as r (r.sessionId)}<RunningBadge
						tool={r.tool}
						title={r.title}
						phase={r.phase ?? undefined}
						staleMinutes={r.staleMinutes}
						mockupUnread={r.mockupUnread}
						reviewIdle={r.reviewIdle}
						waiting={r.waiting}
					/>{/each}
			</span>
		</span>
		<span class={cn('flex items-center gap-2 text-xs font-medium text-ink', LIST_COLS.status)}>
			<span class={cn('size-2 rounded-full', STATUS_STYLE[row.status].dot)} aria-hidden="true"
			></span>
			{row.status.toLowerCase()}
		</span>
		<span class={cn('flex items-center gap-2.5', LIST_COLS.progress)}>
			<Progress
				value={row.percent}
				label={`${row.ref} progress`}
				fill={STATUS_STYLE[row.status].rail}
			/>
			<span
				class="w-10 shrink-0 text-right text-xs font-semibold whitespace-nowrap text-ink tabular-nums"
				>{row.percent}%</span
			>
		</span>
		<span class={cn('truncate text-xs text-muted', LIST_COLS.area)}>{row.stream}/{row.scope}</span>
		<span class={cn('text-xs whitespace-nowrap text-muted', LIST_COLS.updated)}
			>{ago(row.lastActivityAt)}</span
		>
	</a>
{/if}
