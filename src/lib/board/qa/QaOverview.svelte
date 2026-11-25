<script lang="ts">
	// IMPORTED TYPES
	import type { QaStatus } from '#lib/board/qa/status.js';
	// IMPORTED MODULES
	import { QA_STATUSES, QA_STATUS_LABEL, qaPlural } from '#lib/board/qa/status.js';
	import { ago } from '#lib/board/status.js';
	// IMPORTED COMPONENTS
	import QaHealthBar from '#lib/board/qa/QaHealthBar.svelte';
	import QaStatusDot from '#lib/board/qa/QaStatusDot.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';

	// -- REQUIRED PROPS -- //

	let {
		counts,
		percent,
		statusFilter,
		onstatus,
		lastRun,
		bugs,
		runsHref,
		bugsHref
	}: {
		/** How many features have each status. */
		counts: Record<QaStatus, number>;
		/** The share of cases that pass, 0 to 100. */
		percent: number;
		/** The status filter in the address, or `all`. */
		statusFilter: string;
		/** Sets the filter; the selected chip sends `all` to clear it. */
		onstatus: (status: string) => void;
		/** The newest run the person can see, or null when there is none. */
		lastRun: {
			runNo: number;
			goNoGo: string | null;
			commit: string | null;
			createdAt: Date | string;
		} | null;
		bugs: { open: number; major: number; fixedThisWeek: number };
		runsHref: string;
		bugsHref: string;
	} = $props();

	// -- CONSTANTS -- //

	const linkClass =
		'cursor-pointer text-sm text-accent-text hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center';

	// -- REACTIVE STATES -- //

	const total = $derived(QA_STATUSES.reduce((n, s) => n + counts[s], 0));
	const attention = $derived(counts.broken + counts.needs_retest);
</script>

<!-- THE FIRST SCREEN ANSWERS ONE QUESTION: IS IT SAFE TO SHIP. THE RING AND THE HEADLINE, THE LAST RUN AND THE OPEN BUGS, ONE HEALTH BAR, THEN THE STATUS FILTERS -->
<div
	class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] max-sm:p-3.5"
	data-testid="qa-overview"
>
	<div class="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
		<div class="flex min-w-0 items-center gap-3">
			<ProgressRing value={percent} label="Cases passing" size={48} />
			<div class="min-w-0">
				<h2 class="text-lg font-semibold tracking-tight text-ink">{percent}% of cases pass</h2>
				<p class="text-sm text-muted">
					{counts.works} of {total}
					{qaPlural(total, 'feature')}
					{counts.works === 1 && total === 1 ? 'works' : 'work'}{#if attention > 0}
						· {attention} {attention === 1 ? 'needs' : 'need'} attention first{/if}
				</p>
			</div>
		</div>
		<div
			class="grid w-full gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:flex lg:w-auto lg:items-stretch lg:gap-6 lg:border-t-0 lg:pt-0"
		>
			<div class="flex min-w-0 flex-col gap-0.5 lg:min-w-44">
				<p class="text-xs font-medium text-muted">Last run</p>
				{#if lastRun}
					<p class="flex flex-wrap items-center gap-2 text-sm text-ink">
						<span class="font-medium">Run {lastRun.runNo}</span>
						{#if lastRun.goNoGo}
							<Badge tone={lastRun.goNoGo === 'go' ? 'success' : 'danger'}
								>{lastRun.goNoGo === 'go' ? 'Go' : 'No go'}</Badge
							>
						{/if}
					</p>
					<p class="text-xs text-muted">
						{#if lastRun.commit}<span class="font-mono">{lastRun.commit.slice(0, 7)}</span> ·
						{/if}{ago(lastRun.createdAt)}
					</p>
				{:else}
					<p class="text-sm text-ink">No run yet</p>
					<p class="text-xs text-muted">Ask your agent for /flow-qa</p>
				{/if}
				<a href={runsHref} class={linkClass}>Open the runs</a>
			</div>
			<span class="hidden w-px bg-line lg:block" aria-hidden="true"></span>
			<div class="flex min-w-0 flex-col gap-0.5 lg:min-w-44">
				<p class="text-xs font-medium text-muted">Open bugs</p>
				<p class="text-sm text-ink">
					<span class="font-medium">{bugs.open} open</span>
					{#if bugs.major > 0}· {bugs.major} major{/if}
				</p>
				<p class="text-xs text-muted">{bugs.fixedThisWeek} fixed this week</p>
				<a href={bugsHref} class={linkClass}>Open the bugs</a>
			</div>
		</div>
	</div>

	<QaHealthBar
		{counts}
		label={`${total} ${qaPlural(total, 'feature')} by status`}
		class="h-2 w-full"
	/>

	<div
		class="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
		role="group"
		aria-label="Filter by status"
	>
		{#each QA_STATUSES as s (s)}
			<button
				type="button"
				aria-pressed={statusFilter === s}
				title={QA_STATUS_LABEL[s]}
				onclick={() => onstatus(statusFilter === s ? 'all' : s)}
				data-testid="qa-chip"
				class="group flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-pressed:border-accent/40 aria-pressed:bg-accent-soft aria-pressed:text-accent-text max-sm:h-11 max-sm:gap-1.5 max-sm:px-2.5"
			>
				<QaStatusDot status={s} decorative />
				<span class="min-w-0 flex-1 truncate text-left">{QA_STATUS_LABEL[s]}</span>
				<span
					class="inline-flex min-w-6 items-center justify-center rounded-full bg-raised px-1.5 text-badge font-semibold text-ink tabular-nums group-aria-pressed:bg-surface group-aria-pressed:text-accent-text"
					>{counts[s]}</span
				>
			</button>
		{/each}
	</div>
</div>
