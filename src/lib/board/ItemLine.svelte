<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemRow, Running } from '#lib/board/rows.js';
	// IMPORTED MODULES
	import { draggable } from '#lib/actions/dnd.svelte.js';
	import { LIST_COLS, STATUS_STYLE, ago } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	import Progress from '#lib/ui/Progress.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
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
		creator = null,
		onContinue
	}: {
		row: ItemRow;
		href: string;
		running?: Running[];
		/** Board cards stack the parts, list rows put them on one line. */
		compact?: boolean;
		/** A board card can be dragged to another status column. */
		dragEnabled?: boolean;
		/** Who made the plan, with "You" for the signed-in person. Nothing is shown for an imported plan or someone who left. */
		creator?: { userId: string; name: string; v: number | null } | null;
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
			<!-- THE REFERENCE ON THE LEFT, PRIVATE AND NEEDS ATTENTION TOGETHER ON THE RIGHT -->
			<span class={cn('flex min-h-6 items-center gap-2 text-xs text-muted', onContinue && 'pr-10')}>
				<span class="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{row.ref}</span>
				{#if row.visibility === 'private' || row.flags > 0}
					<span class="flex shrink-0 items-center gap-2">
						{#if row.visibility === 'private'}
							<span
								class="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 text-badge font-semibold text-danger"
								><Lock size={12} aria-hidden="true" />Private</span
							>
						{/if}
						{#if row.flags > 0}<TriangleAlert
								size={14}
								class="shrink-0 text-warning"
								aria-label="Needs attention"
							/>{/if}
					</span>
				{/if}
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
					{row.doneSteps} of {row.totalSteps} steps
				</span>
				<span class="whitespace-nowrap">{ago(row.lastActivityAt)}</span>
			</span>
			<!-- THE FOOTER IS ONE LINE: WHO MADE IT ON THE LEFT, THE AREA ON THE RIGHT, NEVER WRAPPING -->
			<span class="flex items-center justify-between gap-2.5 text-xs text-muted">
				<!-- THE SAME AVATAR AS THE TOP BAR, AND THE NAME -->
				{#if creator}
					<span class="inline-flex min-w-0 items-center gap-2" data-testid="item-creator">
						<Avatar name={creator.name} userId={creator.userId} v={creator.v} size={24} />
						<span class="truncate font-medium text-ink">{creator.name}</span>
					</span>
				{:else}
					<!-- KEEPS THE AREA CHIP ON THE RIGHT WHEN NO ONE IS SHOWN -->
					<span aria-hidden="true"></span>
				{/if}
				<span class="shrink-0 rounded-md bg-raised px-1.5 font-medium whitespace-nowrap"
					>{row.stream}/{row.scope}</span
				>
			</span>
			<!-- EACH RUNNING SESSION IS ONE FULL-WIDTH STRIP UNDER THE FOOTER, STACKED -->
			{#if running.length > 0}
				<span class="flex flex-col gap-1.5" data-testid="item-running">
					{#each running as r (r.sessionId)}<RunningBadge
							block
							tool={r.tool}
							title={r.title}
							phase={r.phase ?? undefined}
							staleMinutes={r.staleMinutes}
							mockupUnread={r.mockupUnread}
							reviewIdle={r.reviewIdle}
							waiting={r.waiting}
						/>{/each}
				</span>
			{/if}
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
					{row.doneSteps} of {row.totalSteps} steps
				</span>
				<!-- ON A PHONE THE MADE BY COLUMN IS HIDDEN, SO THE NAME SITS IN THIS LINE -->
				{#if creator}
					<span class="inline-flex items-center gap-1.5 md:hidden">
						<Avatar name={creator.name} userId={creator.userId} v={creator.v} size={24} />
						<span class="font-medium text-ink">{creator.name}</span>
					</span>
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
		<!-- MADE BY COLUMN -->
		<span class={cn('flex items-center gap-2 text-xs font-medium text-ink', LIST_COLS.by)}>
			{#if creator}
				<Avatar name={creator.name} userId={creator.userId} v={creator.v} size={24} />
				<span class="truncate">{creator.name}</span>
			{/if}
		</span>
		<span class={cn('text-xs whitespace-nowrap text-muted', LIST_COLS.updated)}
			>{ago(row.lastActivityAt)}</span
		>
	</a>
{/if}
