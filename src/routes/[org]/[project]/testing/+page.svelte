<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED TYPES
	import type { AppGroup, Device, Status } from '#lib/board/testing/status.js';
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED CONSTANTS
	import {
		ALL_APPS,
		KIND_LABEL,
		SEVERITY_DOT,
		SEVERITY_LABEL,
		STATUS_LABEL,
		STATUS_RAIL,
		STATUS_RANK,
		ago,
		appOf,
		countStatuses,
		groupCases,
		inScope,
		retestPrompt
	} from '#lib/board/testing/status.js';
	// IMPORTED MODULES
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import AppWindow from '@lucide/svelte/icons/app-window';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import Check from '@lucide/svelte/icons/check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Copy from '@lucide/svelte/icons/copy';
	import Download from '@lucide/svelte/icons/download';
	import FileText from '@lucide/svelte/icons/file-text';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Minus from '@lucide/svelte/icons/minus';
	import Rows2 from '@lucide/svelte/icons/rows-2';
	import Rows4 from '@lucide/svelte/icons/rows-4';
	import Search from '@lucide/svelte/icons/search';
	// IMPORTED COMPONENTS
	import CaseDrawer from '#lib/board/testing/CaseDrawer.svelte';
	import DeviceBar from '#lib/board/testing/DeviceBar.svelte';
	import HistoryStrip from '#lib/board/testing/HistoryStrip.svelte';
	import TestStatus from '#lib/board/testing/TestStatus.svelte';
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import Select from '#lib/ui/Select.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- TYPES -- //

	// The sheet's status plus 'running', for the case an open run is on now
	type Row = Omit<NonNullable<typeof data.sheet>['cases'][number], 'status'> & { status: Status };

	// -- CONSTANTS -- //

	const CARD = 'rounded-xl border border-line bg-surface text-ink shadow-[var(--elev-1)]';
	const CHIP =
		'group flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-pressed:border-accent/40 aria-pressed:bg-accent-soft aria-pressed:text-accent-text max-sm:h-11 max-sm:gap-1.5 max-sm:px-2.5';
	const COUNT =
		'inline-flex min-w-6 items-center justify-center rounded-full bg-raised px-1.5 text-badge font-semibold text-ink tabular-nums group-aria-pressed:bg-surface group-aria-pressed:text-accent-text';
	const LINK =
		'cursor-pointer text-sm text-accent-text hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center';
	const HEAD =
		'sticky top-[57px] z-10 h-11 border-b border-line bg-surface px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted md:top-[65px]';
	const CHECKBOX =
		'peer absolute inset-0 size-5 cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-muted bg-surface checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
	const FILTERS: Status[] = ['fail', 'blocked', 'not_run', 'pass'];
	const DEVICE_OPTIONS = [
		{ value: 'all', label: 'All devices' },
		{ value: 'wide', label: 'Wide' },
		{ value: 'laptop', label: 'Laptop' },
		{ value: 'tablet', label: 'Tablet' },
		{ value: 'phone', label: 'Phone' },
		{ value: 'custom', label: 'Custom' }
	];
	const KIND_OPTIONS = [
		{ value: 'all', label: 'All kinds' },
		...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))
	];
	const DOT_BG: Record<Status, string> = {
		fail: 'bg-danger',
		blocked: 'bg-warning',
		not_run: 'border border-muted',
		pass: 'bg-success',
		running: 'bg-info'
	};

	// -- STATES -- //

	let scope = $state(ALL_APPS);
	let filter = $state<Status | ''>('');
	let query = $state('');
	let kind = $state('all');
	let device = $state('all');
	let dense = $state(false);
	let folded = $state<Record<string, boolean>>({});
	let treeFolded = $state<Record<string, boolean>>({});
	let selected = $state<Record<string, boolean>>({});
	let pillRow = $state<HTMLElement>();
	let selectAll = $state<HTMLInputElement>();

	// -- REACTIVE STATES -- //

	const sheet = $derived(data.sheet);
	const base = $derived(`/${page.params.org ?? ''}/${page.params.project ?? ''}`);
	const live = $derived(sheet?.run?.state === 'open' ? sheet.run : null);
	// The first case of an open run that has no result yet is the one running now
	const runningKey = $derived(live?.pending[0] ?? null);
	const rows = $derived<Row[]>(
		(sheet?.cases ?? [])
			.filter((c) => !c.retired)
			.map((c) => ({ ...c, status: c.key === runningKey ? 'running' : (c.status as Status) }))
	);
	const scoped = $derived(rows.filter((c) => inScope(c.area, scope)));
	const counts = $derived(countStatuses(scoped));
	const passPct = $derived(scoped.length ? Math.round((counts.pass * 100) / scoped.length) : 0);
	const q = $derived(query.trim().toLowerCase());
	const filtered = $derived(filter !== '' || q !== '' || kind !== 'all' || device !== 'all');
	const shown = $derived(
		scoped.filter(
			(c) =>
				(!filter || c.status === filter) &&
				(!q || `${c.key} ${c.title}`.toLowerCase().includes(q)) &&
				(kind === 'all' || c.kind === kind) &&
				(device === 'all' || c.devices.some((d) => d.device === device))
		)
	);
	const groups = $derived<AppGroup<Row>[]>(groupCases(shown));
	const apps = $derived(
		[...new Set(rows.map((c) => appOf(c.area)))].sort().map((path) => {
			const list = rows.filter((c) => inScope(c.area, path));
			return {
				path,
				name: path.split('/').pop() ?? path,
				list,
				failing: list.some((c) => c.status === 'fail'),
				areas: [...new Set(list.map((c) => c.area))]
					.filter((a) => a !== path)
					.sort()
					.map((a) => ({
						path: a,
						name: a.slice(path.length + 1),
						list: rows.filter((c) => inScope(c.area, a))
					}))
			};
		})
	);
	const attention = $derived(
		filtered
			? []
			: scoped
					.filter((c) => c.status === 'fail' || c.status === 'blocked')
					.sort(
						(a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.key.localeCompare(b.key)
					)
	);
	// Only the selected cases still shown count: a filter, a scope or a retirement drops the hidden ones from the bar
	const chosen = $derived(shown.filter((c) => selected[c.key]).map((c) => c.key));
	const allPicked = $derived(shown.length > 0 && shown.every((c) => selected[c.key]));
	const somePicked = $derived(!allPicked && shown.some((c) => selected[c.key]));
	// The severities of the cases with an open defect: 2 major, 1 minor
	const defectSeverities = $derived.by(() => {
		// A plain record: it lives only inside this derived, so it needs no reactivity
		const n: Record<string, number> = {};
		for (const c of rows) if (c.defect && c.severity) n[c.severity] = (n[c.severity] ?? 0) + 1;
		return ['blocker', 'major', 'minor', 'cosmetic']
			.filter((s) => n[s])
			.map((s) => `${n[s]} ${s}`)
			.join(', ');
	});
	const coverage = $derived.by(() => {
		const c = sheet?.coverage;
		if (!c) return null;
		const total = c.route.total + c.mcp.total + c.api.total;
		const covered = c.route.covered + c.mcp.covered + c.api.covered;
		return {
			total,
			covered,
			pct: total ? Math.round((covered * 100) / total) : 0,
			left: total - covered
		};
	});

	// -- REACTIVE STATEMENTS -- //

	// A native checkbox shows "some selected" only through its property
	$effect(() => {
		if (selectAll) selectAll.indeterminate = somePicked;
	});
	// The open app pill slides to the centre of its row with the row's own scrollTo
	$effect(() => {
		void scope;
		const row = pillRow;
		const active = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
		if (!row || !active) return;
		const left =
			active.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - active.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});

	// -- FUNCTIONS -- //

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied. Paste it into your coding tool, in this project’s folder.');
		} catch {
			toast.error('The browser did not let the page copy. Select the text and copy it yourself.');
		}
	}

	function openCase(key: string) {
		const url = new URL(page.url.href);
		url.searchParams.set('case', key);
		void goto(url, { reset: false });
	}

	function closeCase() {
		const url = new URL(page.url.href);
		url.searchParams.delete('case');
		// Closing replaces the entry, so Back after a close does not open the case again
		void goto(url, { replace: true, reset: false });
	}

	function clearFilters() {
		filter = '';
		query = '';
		kind = 'all';
		device = 'all';
	}

	function toggleAll() {
		const on = !allPicked;
		const next = { ...selected };
		for (const c of shown) next[c.key] = on;
		selected = next;
	}

	function rowKey(e: KeyboardEvent, key: string) {
		if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
			e.preventDefault();
			openCase(key);
		}
	}

	const problems = (n: Record<Status, number>) =>
		[
			n.fail ? { text: `${n.fail} fail`, tone: 'text-danger' } : null,
			n.blocked ? { text: `${n.blocked} blocked`, tone: 'text-warning' } : null,
			n.running ? { text: `${n.running} running`, tone: 'text-info' } : null
		].filter((x): x is { text: string; tone: string } => x !== null);
</script>

<svelte:head><title>Testing</title></svelte:head>

{#snippet bar(n: Record<Status, number>, cls: string)}
	<!-- EACH SEGMENT TAKES ITS SHARE AT RUNTIME, SO ITS FLEX GROW IS AN INLINE STYLE -->
	<span
		role="img"
		aria-label="Results by status"
		class={['flex gap-0.5 overflow-hidden rounded-full bg-raised', cls]}
	>
		{#each ['fail', 'blocked', 'running', 'not_run', 'pass'] as const as s (s)}
			{#if n[s] > 0}
				<span
					class={['h-full min-w-1', s === 'not_run' ? 'bg-muted/40' : DOT_BG[s]]}
					style="flex: {n[s]}"
				></span>
			{/if}
		{/each}
	</span>
{/snippet}

{#snippet problemLine(n: Record<Status, number>)}
	<span class="text-xs tabular-nums">
		{#each problems(n) as p, i (p.text)}{#if i > 0}<span class="text-muted" aria-hidden="true">
					·
				</span>{/if}<span class={['font-semibold', p.tone]}>{p.text}</span>{/each}
	</span>
{/snippet}

{#snippet pickBox(key: string, label: string)}
	<label
		class="relative inline-flex size-11 cursor-pointer items-center justify-center"
		title={label}
	>
		<span class="relative inline-flex size-5">
			<input type="checkbox" aria-label={label} class={CHECKBOX} bind:checked={selected[key]} />
			<Check
				size={14}
				strokeWidth={3}
				class="pointer-events-none absolute top-[3px] left-[3px] text-accent-ink opacity-0 peer-checked:opacity-100"
			/>
		</span>
	</label>
{/snippet}

{#snippet copyIcon(what: string)}
	<button
		type="button"
		class="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink opacity-0 transition-colors group-hover/grp:opacity-100 hover:bg-ink/10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none max-sm:size-11 pointer-coarse:opacity-100"
		aria-label={`Copy the retest command for ${what}`}
		title={`Copy the retest command for ${what}`}
		onclick={() => copy(retestPrompt(what))}
	>
		<Copy size={16} aria-hidden="true" />
	</button>
{/snippet}

{#if data.denied}
	<PageFrame class="py-8">
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="Testing" />
	</PageFrame>
{:else if sheet}
	<PageFrame class="flex flex-col gap-4 pb-24">
		<!-- THE HEADER BAND -->
		<PageHeader
			title="Testing"
			context={rows.length === 0
				? 'No test cases yet'
				: `${rows.length} test ${rows.length === 1 ? 'case' : 'cases'} in ${apps.length} ${apps.length === 1 ? 'area' : 'apps'} · ${countStatuses(rows).pass} pass · ${countStatuses(rows).fail} fail`}
		>
			{#snippet actions()}
				{#if rows.length > 0}
					<Button
						size="sm"
						onclick={() => copy(retestPrompt('failed'))}
						data-testid="test-retest-failed"
					>
						<Copy size={16} aria-hidden="true" /> Copy retest failed
					</Button>
					<ActionMenu
						size="sm"
						label="Export"
						items={[
							{
								label: 'CSV file',
								icon: FileText,
								onselect: () => (window.location.href = `${base}/testing/export?format=csv`)
							},
							{
								label: 'Excel file (.xlsx)',
								icon: Download,
								onselect: () => (window.location.href = `${base}/testing/export?format=xlsx`)
							}
						]}
					/>
				{/if}
			{/snippet}
		</PageHeader>

		{#if rows.length === 0}
			<!-- EMPTY: NO CASE YET -->
			<div class={[CARD, 'px-6 py-4']}>
				<EmptyState
					kind="items"
					title="No test cases yet"
					text="Your coding tool writes test cases when it plans a change and runs them at the end of the plan, at the devices each case names. To start from what the app already has, run a sweep."
				>
					{#snippet action()}
						<Button onclick={() => copy('/flow-qa sweep')}>
							<Copy size={16} aria-hidden="true" /> Copy sweep command
						</Button>
					{/snippet}
				</EmptyState>
			</div>
		{:else}
			{#if live}
				<!-- A RUN IN PROGRESS: RESULTS FILL IN AS THEY COME, FROM THE LIVE STREAM -->
				<div
					class="flex flex-col gap-2 rounded-xl border border-info/30 bg-info-soft px-4 py-3"
					role="status"
					data-testid="test-live"
				>
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
						<span class="inline-flex items-center gap-2 font-medium text-info">
							<LoaderCircle
								size={16}
								class="shrink-0 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							Run {live.runNo} is running
						</span>
						<span class="text-ink">
							{live.harness || 'An agent'} is testing{live.plan ? ` ${live.plan}` : ''} · {live.done}
							of {live.total}
							{live.total === 1 ? 'case' : 'cases'}
						</span>
						<span class="ml-auto text-xs text-muted max-sm:ml-0"
							>Results appear here as they come in</span
						>
					</div>
					<!-- THE BAR WIDTH IS THE RUN'S PROGRESS AT RUNTIME, SO IT IS AN INLINE STYLE -->
					<span class="block h-1.5 w-full overflow-hidden rounded-full bg-surface">
						<span
							class="block h-full rounded-full bg-info transition-[width] duration-[600ms] ease-out motion-reduce:transition-none"
							style="width: {live.total ? Math.round((live.done * 100) / live.total) : 0}%"
						></span>
					</span>
				</div>
			{/if}

			<!-- THE OVERVIEW: THE VERDICT FIRST, THEN THE LATEST RUN, COVERAGE AND DEFECTS, THE BAR AND THE CHIPS THAT FILTER -->
			<div class={[CARD, 'flex flex-col gap-4 p-4 max-sm:p-3.5']} data-testid="test-overview">
				<div class="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
					<div class="flex min-w-0 items-center gap-3">
						<ProgressRing value={passPct} label="Cases passing" size={48} />
						<div class="min-w-0">
							<p class="text-xs text-muted">
								{scope === ALL_APPS ? 'All apps' : scope.split('/').join(' / ')}
							</p>
							<h2 class="text-xl font-semibold tracking-tight text-ink tabular-nums sm:text-2xl">
								{counts.pass} of {scoped.length} cases pass
							</h2>
							<p class="mt-0.5 text-sm tabular-nums">
								{#if problems(counts).length === 0}<span class="text-muted">Nothing failing</span
									>{:else}{@render problemLine(counts)}{/if}{#if counts.not_run > 0}<span
										class="text-muted"
									>
										· {counts.not_run} not run</span
									>{/if}
							</p>
						</div>
					</div>
					<div
						class="grid w-full gap-4 border-t border-line pt-4 sm:grid-cols-3 lg:flex lg:w-auto lg:items-stretch lg:gap-6 lg:border-t-0 lg:pt-0"
					>
						<div class="flex min-w-0 flex-col gap-0.5 lg:min-w-48">
							<p class="text-xs font-medium text-muted">{live ? 'Running now' : 'Latest run'}</p>
							{#if sheet.run}
								<p class="flex flex-wrap items-center gap-2 text-sm text-ink">
									<span class="font-medium">Run {sheet.run.runNo}</span>
									{#if sheet.run.counts.fail > 0 && !live}
										<TestStatus status="fail" /><span class="sr-only"
											>{sheet.run.counts.fail} failing</span
										>
									{/if}
								</p>
								<p class="text-xs text-muted">
									{#if sheet.run.commit}<span class="font-mono">{sheet.run.commit.slice(0, 7)}</span
										> ·
									{/if}{sheet.run.harness || 'Agent'} · {ago(
										sheet.run.finishedAt ?? sheet.run.startedAt
									)}
								</p>
								{#if sheet.run.plan}
									<a href={`${base}/${sheet.run.plan}?tab=testing`} class={LINK}>{sheet.run.plan}</a
									>
								{/if}
							{:else}
								<p class="text-sm text-muted">No run yet</p>
							{/if}
						</div>
						<span class="hidden w-px bg-line lg:block" aria-hidden="true"></span>
						<div class="flex min-w-0 flex-col gap-0.5 lg:min-w-48">
							<p class="text-xs font-medium text-muted">Coverage</p>
							{#if coverage && coverage.total > 0}
								<p class="text-sm text-ink">
									<span class="font-medium">{coverage.pct}% covered</span> · {coverage.left}
									{coverage.left === 1 ? 'surface' : 'surfaces'} left
								</p>
								<p class="text-xs text-muted tabular-nums">
									{sheet.coverage.route.covered} of {sheet.coverage.route.total} routes · {sheet
										.coverage.mcp.covered}
									of {sheet.coverage.mcp.total} MCP tools · {sheet.coverage.api.covered} of {sheet
										.coverage.api.total} API
								</p>
								{#if coverage.left > 0}<a href="#uncovered" class={LINK}>See what is not covered</a
									>{/if}
							{:else}
								<p class="text-sm text-muted">No surfaces sent yet</p>
							{/if}
						</div>
						<span class="hidden w-px bg-line lg:block" aria-hidden="true"></span>
						<div class="flex min-w-0 flex-col gap-0.5 lg:min-w-44">
							<p class="text-xs font-medium text-muted">Defects</p>
							<p class="text-sm text-ink">
								<span class="font-medium">{sheet.defects} open</span>{#if defectSeverities}<span
										class="text-muted"
									>
										· {defectSeverities}</span
									>{/if}
							</p>
							<a href={`${base}/tasks`} class={LINK}>Open the tasks</a>
						</div>
					</div>
				</div>
				{@render bar(counts, 'h-2 w-full')}
				<div
					class="grid grid-cols-2 gap-2 sm:grid-cols-4"
					role="group"
					aria-label="Filter by status"
				>
					{#each FILTERS as s (s)}
						<button
							type="button"
							aria-pressed={filter === s}
							class={[CHIP, counts[s] === 0 && 'opacity-60']}
							onclick={() => (filter = filter === s ? '' : s)}
							data-testid="test-chip"
						>
							<span class={['size-2.5 shrink-0 rounded-full', DOT_BG[s]]} aria-hidden="true"></span>
							<span class="min-w-0 flex-1 truncate text-left">{STATUS_LABEL[s]}</span>
							<span class={COUNT}>{counts[s]}</span>
						</button>
					{/each}
				</div>
			</div>

			{#if attention.length > 0}
				<!-- NEEDS ATTENTION: THE FAILING AND BLOCKED CASES, ONE CLICK FROM THE DRAWER -->
				<section class="flex flex-col gap-3" data-testid="test-attention">
					<h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink">
						Needs attention<span class="text-sm font-normal text-muted tabular-nums"
							>{attention.length}</span
						>
					</h2>
					<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
						{#each attention as c (c.key)}
							{@const bad = c.results.find((r) => r.status === 'fail' || r.status === 'blocked')}
							<button
								type="button"
								onclick={() => openCase(c.key)}
								class={[
									'flex cursor-pointer flex-col gap-2 rounded-xl border border-t-2 border-line bg-surface p-4 text-left shadow-[var(--elev-1)] transition-shadow hover:shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none',
									c.status === 'fail' ? 'border-t-danger' : 'border-t-warning'
								]}
							>
								<span class="flex items-center justify-between gap-2">
									<span class="font-mono text-xs text-muted">{c.key}</span>
									<TestStatus status={c.status} />
								</span>
								<span class="line-clamp-2 text-sm font-semibold text-ink">{c.title}</span>
								<span
									class="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2 text-xs text-muted"
								>
									{#if bad}<span class="text-ink"
											>{bad.device === 'custom'
												? `${bad.width} × ${bad.height}`
												: bad.device[0].toUpperCase() + bad.device.slice(1)}</span
										>{/if}
									{#if c.severity}<span aria-hidden="true">·</span><span
											class="inline-flex items-center gap-1.5 text-ink"
											><span
												class={['size-1.5 rounded-full', SEVERITY_DOT[c.severity]]}
												aria-hidden="true"
											></span>{SEVERITY_LABEL[c.severity]}</span
										>{/if}
									<span class="ml-auto font-mono">{c.area.split('/').slice(-2).join(' / ')}</span>
								</span>
							</button>
						{/each}
					</div>
				</section>
			{/if}

			<div class="flex items-start gap-4">
				<!-- THE APPS TREE (FROM 2XL), LIKE THE NOTES FOLDER TREE -->
				<nav
					aria-label="Apps and areas"
					class={[CARD, 'sticky top-[73px] hidden w-72 shrink-0 self-start 2xl:block']}
				>
					<div class="flex items-center gap-2 border-b border-line px-4 py-3">
						<h2 class="min-w-0 flex-1 text-sm font-semibold">Apps</h2>
						<span class="text-xs text-muted tabular-nums">{apps.length}</span>
					</div>
					<ul class="flex flex-col gap-0.5 p-2">
						{#snippet treeRow(
							key: string,
							label: string,
							list: Row[],
							depth: number,
							kids: boolean
						)}
							{@const on = scope === key}
							<li>
								<!-- THE INDENT IS A RUNTIME LEVEL, 16 PX A LEVEL, SO IT IS AN INLINE PADDING -->
								<div
									class={[
										'group flex h-10 items-center rounded-lg pr-2',
										on ? 'bg-accent-soft text-accent-text' : 'text-ink hover:bg-raised'
									]}
									style="padding-left: {4 + depth * 16}px"
								>
									<span class="inline-flex size-6 shrink-0 items-center justify-center">
										{#if kids}
											<button
												type="button"
												class="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted hover:text-ink"
												aria-label={`${treeFolded[key] ? 'Open' : 'Fold'} ${label}`}
												aria-expanded={!treeFolded[key]}
												onclick={() => (treeFolded[key] = !treeFolded[key])}
											>
												<ChevronRight
													size={14}
													class={[
														'transition-transform duration-150 motion-reduce:transition-none',
														!treeFolded[key] && 'rotate-90'
													]}
													aria-hidden="true"
												/>
											</button>
										{/if}
									</span>
									<button
										type="button"
										class={[
											'flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left text-sm',
											on && 'font-medium'
										]}
										aria-current={on ? 'true' : undefined}
										onclick={() => (scope = key)}
									>
										<span
											class={[
												'inline-flex size-6 shrink-0 items-center justify-center',
												!on && 'text-muted'
											]}
										>
											{#if key === ALL_APPS}<ListChecks
													size={16}
													aria-hidden="true"
												/>{:else if depth === 0}<AppWindow
													size={16}
													aria-hidden="true"
												/>{:else if on}<FolderOpen size={16} aria-hidden="true" />{:else}<Folder
													size={16}
													aria-hidden="true"
												/>{/if}
										</span>
										<span class="truncate">{label}</span>
										{#if list.some((c) => c.status === 'fail')}
											<span
												class="size-1.5 shrink-0 rounded-full bg-danger"
												title="Has failing cases"
												aria-hidden="true"
											></span>
										{:else if list.some((c) => c.status === 'blocked')}
											<span class="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true"
											></span>
										{/if}
									</button>
									<span
										class={[
											'inline-flex w-8 shrink-0 justify-end text-xs tabular-nums',
											!on && 'text-muted'
										]}>{list.length}</span
									>
								</div>
							</li>
						{/snippet}
						{@render treeRow(ALL_APPS, 'All apps', rows, 0, false)}
						{#each apps as a (a.path)}
							{@render treeRow(a.path, a.name, a.list, 0, a.areas.length > 0)}
							{#if !treeFolded[a.path]}
								{#each a.areas as ar (ar.path)}
									{@render treeRow(ar.path, ar.name, ar.list, 1, false)}
								{/each}
							{/if}
						{/each}
					</ul>
				</nav>

				<div class="flex min-w-0 flex-1 flex-col gap-3">
					<!-- BELOW 2XL THE APPS ARE ONE SIDEWAYS ROW OF PILLS -->
					<div
						bind:this={pillRow}
						class="flex [scrollbar-width:none]! gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain 2xl:hidden [&::-webkit-scrollbar]:hidden"
						role="group"
						aria-label="Apps"
					>
						{#each [{ path: ALL_APPS, name: 'All apps', list: rows, failing: false }, ...apps] as a (a.path)}
							<button
								type="button"
								aria-pressed={appOf(scope) === a.path || scope === a.path}
								onclick={() => (scope = a.path)}
								class="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm text-ink hover:bg-raised aria-pressed:border-accent/40 aria-pressed:bg-accent-soft aria-pressed:text-accent-text max-sm:h-11"
							>
								{#if a.path === ALL_APPS}<ListChecks
										size={16}
										class="shrink-0 opacity-70"
										aria-hidden="true"
									/>{:else}<AppWindow
										size={16}
										class="shrink-0 opacity-70"
										aria-hidden="true"
									/>{/if}
								{a.name}
								{#if a.list.some((c) => c.status === 'fail')}<span
										class="size-1.5 rounded-full bg-danger"
										aria-hidden="true"
									></span>{/if}
								<span class="rounded-full bg-raised px-1.5 text-badge font-semibold tabular-nums"
									>{a.list.length}</span
								>
							</button>
						{/each}
					</div>

					<!-- THE SHEET: ONE CARD THAT CLIPS WITHOUT BECOMING A SCROLL BOX, SO ITS HEAD STICKS TO THE PAGE -->
					<div
						class="overflow-clip rounded-xl border border-line bg-surface text-ink shadow-[var(--elev-1)]"
						data-testid="test-sheet"
					>
						<div class="flex flex-wrap items-center gap-2 border-b border-line p-2.5">
							<div class="group relative min-w-56 flex-1 sm:max-w-72">
								<Search
									size={18}
									class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted transition-colors group-focus-within:text-accent-text"
									aria-hidden="true"
								/>
								<input
									type="search"
									bind:value={query}
									placeholder="Search by ID or title"
									aria-label="Search test cases"
									class="h-10 w-full rounded-lg border border-line bg-surface pr-3 pl-10 text-sm text-ink shadow-[var(--elev-1)] transition-[border-color,box-shadow] duration-150 placeholder:text-muted hover:border-muted focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none max-sm:h-11"
								/>
							</div>
							<Select
								label="Device"
								prefix="Device"
								options={DEVICE_OPTIONS}
								bind:value={device}
								class="w-48 max-sm:w-full"
							/>
							<Select
								label="Kind"
								prefix="Kind"
								options={KIND_OPTIONS}
								bind:value={kind}
								class="w-40 max-sm:w-full"
							/>
							<Button variant="ghost" class="max-sm:flex-1" onclick={() => (folded = {})}>
								<ChevronsUpDown size={16} aria-hidden="true" /> Expand all
							</Button>
							<Button
								variant="ghost"
								class="max-sm:flex-1"
								onclick={() => (folded = Object.fromEntries(groups.map((g) => [g.path, true])))}
							>
								<ChevronsDownUp size={16} aria-hidden="true" /> Collapse all
							</Button>
							{#if filtered}
								<Button variant="ghost" class="border-transparent" onclick={clearFilters}
									>Clear filters</Button
								>
							{/if}
							<span class="ml-auto max-lg:hidden">
								<span
									role="radiogroup"
									aria-label="Row height"
									class="inline-flex h-10 items-stretch rounded-lg border border-line bg-raised p-0.5"
								>
									{#each [{ on: false, label: 'Comfortable', Icon: Rows2 }, { on: true, label: 'Compact', Icon: Rows4 }] as o (o.label)}
										<button
											type="button"
											role="radio"
											aria-checked={dense === o.on}
											title={o.label}
											onclick={() => (dense = o.on)}
											class={[
												'inline-flex h-full min-w-10 cursor-pointer items-center justify-center rounded-md px-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
												dense === o.on
													? 'bg-surface text-ink shadow-[0_0_0_1px_var(--line)]'
													: 'text-muted hover:text-ink'
											]}
										>
											<o.Icon size={16} aria-hidden="true" /><span class="sr-only">{o.label}</span>
										</button>
									{/each}
								</span>
							</span>
						</div>

						{#if groups.length === 0}
							<div class="px-6 py-4">
								<EmptyState
									kind="search"
									title="No test cases match"
									text="Try a different word, or clear the filters."
								>
									{#snippet action()}<Button onclick={clearFilters}>Clear filters</Button>{/snippet}
								</EmptyState>
							</div>
						{:else}
							<!-- FROM LG: A REAL TABLE WITH ONE STICKY HEAD ROW -->
							<table class="w-full border-separate border-spacing-0 max-lg:hidden">
								<thead>
									<tr>
										<th scope="col" class={[HEAD, 'w-11 px-0']}>
											<label
												class="relative inline-flex size-11 cursor-pointer items-center justify-center"
												title="Select every case shown"
											>
												<span class="relative inline-flex size-5">
													<input
														bind:this={selectAll}
														type="checkbox"
														aria-label="Select every case shown"
														class={CHECKBOX}
														checked={allPicked}
														onchange={toggleAll}
													/>
													{#if somePicked}<Minus
															size={14}
															strokeWidth={3}
															class="pointer-events-none absolute top-[3px] left-[3px] text-accent-ink"
														/>{:else}<Check
															size={14}
															strokeWidth={3}
															class="pointer-events-none absolute top-[3px] left-[3px] text-accent-ink opacity-0 peer-checked:opacity-100"
														/>{/if}
												</span>
											</label>
										</th>
										<th scope="col" class={[HEAD, 'w-32']}>ID</th>
										<th scope="col" class={HEAD}>Test case</th>
										<th scope="col" class={[HEAD, 'w-36']}>Devices</th>
										<th scope="col" class={[HEAD, 'w-28 text-ink']}>
											<span class="inline-flex items-center gap-1"
												>Status <ArrowDown size={12} aria-hidden="true" /></span
											>
										</th>
										<th scope="col" class={[HEAD, 'w-32']}>Last 10</th>
										<th scope="col" class={[HEAD, 'w-32']}>Tested</th>
									</tr>
								</thead>
								<tbody>
									{#each groups as g (g.path)}
										{@const gn = countStatuses(g.cases)}
										<tr class="group/grp">
											<td colspan="7" class="border-b border-line bg-raised/50 p-0">
												<div class="flex min-h-14 items-center gap-4 pr-3 pl-2">
													<button
														type="button"
														class="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
														aria-expanded={!folded[g.path]}
														onclick={() => (folded[g.path] = !folded[g.path])}
													>
														<ChevronRight
															size={16}
															class={[
																'shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none',
																!folded[g.path] && 'rotate-90'
															]}
															aria-hidden="true"
														/>
														<span
															class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink shadow-[var(--elev-1)]"
														>
															<AppWindow size={16} aria-hidden="true" />
														</span>
														<span class="flex min-w-0 flex-col leading-tight">
															<span class="text-base font-semibold text-ink">{g.name}</span>
															<span class="truncate text-xs text-muted"
																>{g.path} · {g.cases.length}
																{g.cases.length === 1 ? 'case' : 'cases'}</span
															>
														</span>
													</button>
													{@render problemLine(gn)}
													<span class="flex w-40 shrink-0 items-center gap-2">
														<span class="flex-1">{@render bar(gn, 'h-1.5 w-full')}</span>
														<span class="text-xs text-muted tabular-nums"
															>{gn.pass}/{g.cases.length}</span
														>
													</span>
													{@render copyIcon(g.path)}
												</div>
											</td>
										</tr>
										{#if !folded[g.path]}
											{#each g.areas as ar (ar.path)}
												{#if ar.path !== g.path}
													<tr class="group/grp">
														<td colspan="7" class="border-b border-line p-0">
															<div class="flex min-h-10 items-center gap-3 pr-3 pl-12">
																<button
																	type="button"
																	class="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
																	aria-expanded={!folded[ar.path]}
																	onclick={() => (folded[ar.path] = !folded[ar.path])}
																>
																	<ChevronRight
																		size={14}
																		class={[
																			'shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none',
																			!folded[ar.path] && 'rotate-90'
																		]}
																		aria-hidden="true"
																	/>
																	<span
																		class="text-xs font-semibold tracking-wider text-muted uppercase"
																		>{ar.name}</span
																	>
																	<span class="text-xs text-muted tabular-nums"
																		>{ar.cases.length}</span
																	>
																</button>
																{@render problemLine(countStatuses(ar.cases))}
																{@render copyIcon(ar.path)}
															</div>
														</td>
													</tr>
												{/if}
												{#if !folded[ar.path]}
													{#each ar.cases as c (c.key)}
														{@const loud = !!STATUS_RAIL[c.status]}
														{@const td = [
															'border-b border-line px-3 align-middle',
															dense ? 'py-2' : 'py-3.5'
														]}
														<tr
															class={[
																'cursor-pointer transition-colors hover:bg-raised/60 motion-reduce:transition-none',
																selected[c.key] && 'bg-accent-soft/40 hover:bg-accent-soft/60',
																c.status === 'running' && 'motion-safe:animate-pulse'
															]}
															tabindex="0"
															role="button"
															aria-label={`${c.key}: ${c.title}`}
															onclick={(e) => {
																if (!(e.target as HTMLElement).closest('label')) openCase(c.key);
															}}
															onkeydown={(e) => rowKey(e, c.key)}
															data-testid="test-case"
														>
															<td class="relative border-b border-line p-0 align-middle">
																{#if loud}<span
																		class={[
																			'absolute inset-y-0 left-0 w-[3px]',
																			STATUS_RAIL[c.status]
																		]}
																		aria-hidden="true"
																	></span>{/if}
																{@render pickBox(c.key, `Select ${c.key}`)}
															</td>
															<td
																class={[
																	td,
																	'font-mono text-xs whitespace-nowrap',
																	loud ? 'text-ink' : 'text-muted'
																]}>{c.key}</td
															>
															<td class={td}>
																<span class="line-clamp-2 text-sm font-medium text-ink"
																	>{c.title}</span
																>
																{#if !dense}
																	<span
																		class="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted"
																	>
																		<span>{KIND_LABEL[c.kind] ?? c.kind}</span><span
																			aria-hidden="true">·</span
																		><span>v{c.version}</span><span aria-hidden="true">·</span><span
																			class="tabular-nums"
																			>{c.steps} {c.steps === 1 ? 'step' : 'steps'}</span
																		>
																		{#if c.priority === 'high'}<span aria-hidden="true">·</span
																			><span class="font-medium text-ink">High priority</span>{/if}
																		{#if c.flaky}<span aria-hidden="true">·</span><span
																				class="font-semibold text-warning">Flaky</span
																			>{/if}
																	</span>
																{/if}
															</td>
															<td class={td}>
																<DeviceBar
																	kind={c.kind}
																	results={c.kind === 'ui'
																		? c.devices.map((d) => {
																				const r = c.results.find(
																					(x) => x.device === d.device && x.width === d.width
																				);
																				return {
																					device: d.device as Device,
																					width: d.width,
																					height: d.height,
																					// A device of the running case with no result yet is the one being tested
																					status: (r?.status ??
																						(c.status === 'running'
																							? 'running'
																							: 'not_run')) as Status
																				};
																			})
																		: []}
																/>
															</td>
															<td class={td}
																><TestStatus
																	status={c.status}
																	severity={c.severity ? SEVERITY_LABEL[c.severity] : null}
																/></td
															>
															<td class={td}><HistoryStrip history={c.history} /></td>
															<td class={td}>
																<span class="flex flex-col text-xs leading-tight">
																	<span class="truncate text-ink">{c.testedBy || '—'}</span>
																	<span class="text-muted"
																		>{c.status === 'running' ? 'Now' : ago(c.testedAt)}</span
																	>
																</span>
															</td>
														</tr>
													{/each}
												{/if}
											{/each}
										{/if}
									{/each}
								</tbody>
							</table>

							<!-- BELOW LG: EACH APP IS A CARD OF CASE CARDS -->
							<div class="flex flex-col gap-3 p-3 lg:hidden">
								{#each groups as g (g.path)}
									<section class={CARD}>
										<div
											class="flex min-h-12 items-center gap-2.5 border-b border-line bg-raised/70 px-3"
										>
											<span
												class="inline-flex size-7 items-center justify-center rounded-md border border-line bg-surface text-muted"
											>
												<AppWindow size={16} aria-hidden="true" />
											</span>
											<span class="min-w-0 flex-1 truncate text-sm font-semibold text-ink"
												>{g.name}</span
											>
											<span class="w-16">{@render bar(countStatuses(g.cases), 'h-1.5 w-full')}</span
											>
										</div>
										{#each g.areas as ar (ar.path)}
											{#if ar.path !== g.path}
												<div
													class="flex min-h-11 items-center gap-2 border-b border-line bg-raised/30 px-3 text-sm"
												>
													<Folder size={16} class="shrink-0 text-muted" aria-hidden="true" />
													<span class="min-w-0 flex-1 truncate font-semibold text-ink"
														>{ar.name}</span
													>
													<span class="text-xs text-muted tabular-nums">{ar.cases.length}</span>
												</div>
											{/if}
											<ul>
												{#each ar.cases as c (c.key)}
													<li
														class={[
															'relative border-b border-line last:border-b-0',
															selected[c.key] && 'bg-accent-soft/40'
														]}
													>
														{#if STATUS_RAIL[c.status]}<span
																class={['absolute inset-y-0 left-0 w-[3px]', STATUS_RAIL[c.status]]}
																aria-hidden="true"
															></span>{/if}
														<div class="flex items-start gap-1 py-2 pr-3 pl-2">
															{@render pickBox(c.key, `Select ${c.key}`)}
															<button
																type="button"
																onclick={() => openCase(c.key)}
																class="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 rounded-lg py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
															>
																<span class="flex items-center justify-between gap-2">
																	<span class="font-mono text-xs text-ink">{c.key}</span>
																	<TestStatus status={c.status} />
																</span>
																<span class="text-sm font-medium text-ink">{c.title}</span>
																<span
																	class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
																>
																	<span>{KIND_LABEL[c.kind] ?? c.kind}</span><span
																		>v{c.version}</span
																	>
																	{#if c.priority === 'high'}<span class="font-medium text-ink"
																			>High priority</span
																		>{/if}
																	{#if c.severity && c.status === 'fail'}<span
																			>{SEVERITY_LABEL[c.severity]}</span
																		>{/if}
																</span>
																<span class="flex flex-wrap items-center justify-between gap-2">
																	<DeviceBar
																		kind={c.kind}
																		results={c.devices.map((d) => ({
																			device: d.device as Device,
																			width: d.width,
																			height: d.height,
																			status: (c.results.find(
																				(x) => x.device === d.device && x.width === d.width
																			)?.status ?? 'not_run') as Status
																		}))}
																	/>
																	<span class="flex items-center gap-3">
																		<HistoryStrip history={c.history} />
																		<span class="text-xs text-muted">{ago(c.testedAt)}</span>
																	</span>
																</span>
															</button>
														</div>
													</li>
												{/each}
											</ul>
										{/each}
									</section>
								{/each}
							</div>

							<div
								class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-xs text-muted max-sm:px-3.5"
							>
								<span class="tabular-nums"
									>Showing {shown.length}
									{shown.length === 1 ? 'case' : 'cases'} in {groups.length}
									{groups.length === 1 ? 'app' : 'apps'}</span
								>
								<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
									{#each ['pass', 'fail', 'blocked', 'not_run'] as const as s (s)}
										<span class="inline-flex items-center gap-1"
											><span
												class={['size-2 rounded-full', s === 'not_run' ? 'bg-muted/40' : DOT_BG[s]]}
												aria-hidden="true"
											></span>{STATUS_LABEL[s]}</span
										>
									{/each}
									<span>A grey segment: the case does not run at that device</span>
								</span>
								<span class="ml-auto max-sm:ml-0"
									>Wide 1600 · Laptop 1280 · Tablet 820 · Phone 408 · or a custom size</span
								>
							</div>
						{/if}
					</div>

					{#if sheet.coverage.uncovered.length > 0 && !filtered}
						<!-- NOT COVERED YET: SURFACES FOUND IN THE CODE THAT NO CASE TOUCHES -->
						<section id="uncovered" class={[CARD, 'scroll-mt-[73px] overflow-hidden']}>
							<div
								class="flex items-center gap-2 border-b border-line px-4 py-3 max-sm:flex-wrap max-sm:px-3.5"
							>
								<h2 class="min-w-0 flex-1 text-lg leading-7 font-semibold">Not covered yet</h2>
								<span class="text-xs text-muted tabular-nums"
									>{sheet.coverage.uncovered.length}</span
								>
								<div
									class="ml-auto flex shrink-0 items-center gap-2 max-sm:ml-0 max-sm:w-full max-sm:[&>*]:flex-1"
								>
									<Button size="sm" onclick={() => copy('/flow-qa sweep')}
										><Copy size={16} aria-hidden="true" /> Copy sweep command</Button
									>
								</div>
							</div>
							<p class="px-4 pt-3 text-sm text-muted max-sm:px-3.5">
								Found in the code on the last run. No test case touches them yet; a sweep writes
								cases for them.
							</p>
							<ul class="px-4 py-2 max-sm:px-3.5">
								{#each sheet.coverage.uncovered.slice(0, 50) as u (`${u.kind}:${u.key}`)}
									<li
										class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2 last:border-b-0"
									>
										<span
											class="w-16 rounded-md bg-raised px-2 py-0.5 text-center text-xs text-muted"
										>
											{u.kind === 'route' ? 'Route' : u.kind === 'mcp' ? 'MCP tool' : 'API'}
										</span>
										<span class="min-w-0 flex-1 truncate font-mono text-sm text-ink">{u.key}</span>
										<span class="text-xs text-muted">First seen {ago(u.firstSeenAt)}</span>
									</li>
								{/each}
								{#if sheet.coverage.uncovered.length > 50}
									<li class="py-2 text-sm text-muted">
										and {sheet.coverage.uncovered.length - 50} more
									</li>
								{/if}
							</ul>
						</section>
					{/if}
				</div>
			</div>
		{/if}
	</PageFrame>

	{#if chosen.length > 0}
		<!-- THE SELECTION BAR: COPY ONE RETEST COMMAND FOR THE CASES PICKED -->
		<div class="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
			<div
				class="pointer-events-auto flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface py-2 pr-2 pl-4 shadow-[var(--shadow-pop)]"
			>
				<span class="text-sm font-medium text-ink tabular-nums">{chosen.length} selected</span>
				<Button size="sm" onclick={() => copy(retestPrompt(chosen.join(' ')))}>
					<Copy size={16} aria-hidden="true" /> Copy retest command
				</Button>
				<Button size="sm" variant="subtle" onclick={() => (selected = {})}>Clear</Button>
			</div>
		</div>
	{/if}

	<CaseDrawer detail={data.open} onclose={closeCase} {base} oncopy={copy} />
{/if}
