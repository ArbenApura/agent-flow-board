<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import {
		QA_SEVERITIES,
		QA_SEVERITY_LABEL,
		QA_SORTS,
		QA_SORT_LABEL,
		QA_STATUS_RAIL,
		qaBugIsOpen,
		qaBugStateOf,
		qaCommand,
		qaCounts,
		qaPercent,
		qaPlural,
		qaSortFeatures,
		qaSortOf,
		qaStatusOf,
		qaSummary
	} from '#lib/board/qa/status.js';
	import { ago } from '#lib/board/status.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Bug from '@lucide/svelte/icons/bug';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import Copy from '@lucide/svelte/icons/copy';
	import List from '@lucide/svelte/icons/list';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import MapIcon from '@lucide/svelte/icons/map';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Search from '@lucide/svelte/icons/search';
	// IMPORTED COMPONENTS
	import QaHealthBar from '#lib/board/qa/QaHealthBar.svelte';
	import QaOverview from '#lib/board/qa/QaOverview.svelte';
	import QaStatusPill from '#lib/board/qa/QaStatusPill.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const CHIP =
		'group flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-pressed:border-accent/40 aria-pressed:bg-accent-soft aria-pressed:text-accent-text max-sm:h-11 max-sm:flex-1 max-sm:justify-center';
	const COUNT =
		'inline-flex min-w-6 items-center justify-center rounded-full bg-raised px-1.5 text-badge font-semibold text-ink tabular-nums group-aria-pressed:bg-surface group-aria-pressed:text-accent-text';
	const CARD = 'rounded-xl border border-line bg-surface shadow-[var(--elev-1)]';
	const SORT_OPTIONS = QA_SORTS.map((s) => ({ value: s, label: QA_SORT_LABEL[s] }));
	const SEVERITY_OPTIONS = [
		{ value: 'all', label: 'All severities' },
		...QA_SEVERITIES.map((s) => ({
			value: s,
			label: QA_SEVERITY_LABEL[s]
		}))
	];

	// -- STATES -- //

	// The search box shows the filter the address holds, so a shared or reloaded link does not look unfiltered
	let q = $state(untrack(() => page.url.searchParams.get('q') ?? ''));
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const projectName = $derived(key);
	const statusFilter = $derived(page.url.searchParams.get('status') ?? 'all');
	const areaFilter = $derived(page.url.searchParams.get('area') ?? 'all');
	const sort = $derived(qaSortOf(page.url.searchParams.get('sort')));
	const query = $derived((page.url.searchParams.get('q') ?? '').trim().toLowerCase());
	const bugState = $derived(qaBugStateOf(page.url.searchParams.get('bugs')));
	const severityFilter = $derived(page.url.searchParams.get('sev') ?? 'all');
	const areas = $derived([...new Set(data.features.map((f) => f.area || 'Other'))].sort());
	const shown = $derived(
		qaSortFeatures(
			data.features.filter(
				(f) =>
					(statusFilter === 'all' || f.status === statusFilter) &&
					(areaFilter === 'all' || (f.area || 'Other') === areaFilter) &&
					(query === '' ||
						f.name.toLowerCase().includes(query) ||
						f.key.toLowerCase().includes(query))
			),
			sort
		)
	);
	const groups = $derived(
		areas
			.map((a) => ({ area: a, features: shown.filter((f) => (f.area || 'Other') === a) }))
			.filter((g) => g.features.length > 0)
	);
	const filtering = $derived(query !== '' || statusFilter !== 'all' || areaFilter !== 'all');
	const statuses = $derived(data.features.map((f) => qaStatusOf(f.status)));
	const counts = $derived(qaCounts(statuses));
	const summaryLine = $derived(qaSummary(statuses));
	const percent = $derived(
		qaPercent(
			data.features.reduce((n, f) => n + f.works, 0),
			data.features.reduce((n, f) => n + f.cases, 0)
		)
	);
	const areaOptions = $derived([
		{ value: 'all', label: 'All areas' },
		...areas.map((a) => ({ value: a, label: a }))
	]);
	const tabOptions = $derived([
		{ value: 'map', label: 'Map', icon: MapIcon },
		{ value: 'runs', label: 'Runs', icon: ListChecks, count: data.runCount },
		{ value: 'bugs', label: 'Bugs', icon: Bug, count: data.bugSummary.open }
	]);
	const allBugs = $derived(data.bugs ?? []);
	const openBugs = $derived(allBugs.filter((b) => qaBugIsOpen(b.status)).length);
	const shownBugs = $derived(
		allBugs.filter(
			(b) =>
				(bugState === 'all' || (bugState === 'open') === qaBugIsOpen(b.status)) &&
				(severityFilter === 'all' || b.severity === severityFilter)
		)
	);
	const bugGroups = $derived(
		[...QA_SEVERITIES, null]
			.map((sev) => ({
				sev,
				bugs: shownBugs.filter(
					(b) => (b.severity && b.severity in QA_SEVERITY_LABEL ? b.severity : null) === sev
				)
			}))
			.filter((g) => g.bugs.length > 0)
	);

	// -- REACTIVE STATEMENTS -- //

	// The box follows the address when it changes under it (a link, back or forward), unless a typed change is still waiting
	$effect(() => {
		const fromUrl = page.url.searchParams.get('q') ?? '';
		untrack(() => {
			if (searchTimer === undefined && fromUrl.trim() !== q.trim()) q = fromUrl;
		});
	});

	// A search that is still waiting is dropped when the page goes away
	$effect(() => () => clearTimeout(searchTimer));

	// -- FUNCTIONS -- //

	/** Keeps the address as the one place the tab and the filters live, so a view can be shared and the back button works. */
	function go(change: Record<string, string | null>) {
		const u = new URL(page.url.href);
		for (const [k, v] of Object.entries(change)) {
			if (v === null || v === '') u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		void goto(u, { replaceState: true, reset: false });
	}

	const typed = () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchTimer = undefined;
			go({ q: q.trim() || null });
		}, 250);
	};

	function clearFilters() {
		q = '';
		go({ q: null, status: null, area: null });
	}

	async function copyCommand(scope?: string) {
		try {
			await navigator.clipboard.writeText(qaCommand(scope));
			toast.success('Copied. Paste it into your coding tool, in this project’s folder.');
		} catch {
			toast.error('The command could not be copied. Type /flow-qa in your coding tool.');
		}
	}
</script>

<svelte:head><title>Testing, {projectName}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title="Testing"
		context={data.denied
			? undefined
			: data.features.length === 0
				? 'No features on the map yet'
				: summaryLine}
	>
		{#snippet actions()}
			{#if !data.denied && data.features.length > 0}
				<Button
					variant="primary"
					class="max-sm:flex-1"
					onclick={() => copyCommand()}
					data-testid="qa-copy-command"
				>
					<Copy size={16} /> Copy the test command
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.denied}
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="testing" />
	{:else}
		<SegmentedControl
			label="Testing views"
			value={data.tab}
			options={tabOptions}
			onchange={(v) => go({ tab: v === 'map' ? null : v })}
			class="w-fit self-start"
		/>

		{#if data.tab === 'map'}
			{#if data.features.length === 0}
				<div class={CARD} data-testid="qa-empty">
					<EmptyState
						kind="files"
						title="No map yet"
						text="Ask your agent to run /flow-qa. It maps the app's features from the code, checks them in its own browser and puts them here."
					>
						{#snippet action()}
							<Button variant="primary" onclick={() => copyCommand()} data-testid="qa-copy-first">
								<Copy size={16} /> Copy the command
							</Button>
						{/snippet}
					</EmptyState>
				</div>
			{:else}
				<!-- THE OVERVIEW: IS IT SAFE TO SHIP, IN ONE LOOK. THE STATUS CHIPS ARE THE STATUS FILTER -->
				<QaOverview
					{counts}
					{percent}
					{statusFilter}
					onstatus={(v) => go({ status: v === 'all' ? null : v })}
					lastRun={data.lastRun}
					bugs={data.bugSummary}
					runsHref={`${base}/qa?tab=runs`}
					bugsHref={`${base}/qa?tab=bugs`}
				/>

				<!-- ONE TOOLBAR CARD: THE SEARCH, THE SORT AND THE AREA, AS ON THE TASKS AND MOCKUPS PAGES -->
				<div
					class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5"
				>
					<div class="min-w-56 flex-1 sm:max-w-80">
						<TextField
							label="Search features"
							icon={Search}
							hideLabel
							placeholder="Search by name or key"
							type="search"
							bind:value={q}
							oninput={typed}
							data-testid="qa-filter-q"
						/>
					</div>
					<Select
						label="Sort"
						prefix="Sort:"
						options={SORT_OPTIONS}
						value={sort}
						onchange={(v) => go({ sort: v === 'attention' ? null : v })}
						triggerClass="w-56"
					/>
					{#if areas.length > 1}
						<Select
							label="Area"
							options={areaOptions}
							value={areaFilter}
							onchange={(v) => go({ area: v === 'all' ? null : v })}
							triggerClass="w-44"
						/>
					{/if}
					{#if filtering}
						<Button variant="ghost" onclick={clearFilters}>Clear filters</Button>
					{/if}
				</div>

				{#if groups.length === 0}
					<EmptyState
						kind="search"
						title="No features match"
						text="Try a different word, or clear the filters."
					>
						{#snippet action()}
							<Button onclick={clearFilters}>Clear filters</Button>
						{/snippet}
					</EmptyState>
				{:else}
					{#each groups as g (g.area)}
						{@const areaCounts = qaCounts(g.features.map((f) => qaStatusOf(f.status)))}
						<section class="flex flex-col gap-2" data-testid="qa-area">
							<div class="flex items-center gap-3 px-1">
								<h2 class="text-xs font-medium text-muted">{g.area}</h2>
								<span class="text-xs text-muted tabular-nums"
									>{g.features.length} {qaPlural(g.features.length, 'feature')}</span
								>
								<span class="ml-auto w-16">
									<QaHealthBar
										counts={areaCounts}
										label={`${g.area}: ${g.features.length} ${qaPlural(g.features.length, 'feature')}`}
										class="h-1.5 w-16"
									/>
								</span>
							</div>
							<ul class="{CARD} overflow-hidden">
								{#each g.features as f (f.id)}
									{@const st = qaStatusOf(f.status)}
									<li
										class="group/row relative flex flex-wrap items-center border-b border-line last:border-b-0 sm:flex-nowrap"
										data-testid="qa-feature"
									>
										<!-- THE STATUS RAIL ON THE LEFT EDGE, A FIXED STATUS TOKEN -->
										<span
											class="absolute inset-y-0 left-0 w-[3px] {QA_STATUS_RAIL[st]}"
											aria-hidden="true"
										></span>
										<a
											href={`${base}/qa/${f.key}`}
											title={f.name}
											class="flex min-h-14 min-w-0 flex-1 basis-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 py-3 pr-2 pl-5 hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent max-sm:pr-14 sm:basis-0 sm:flex-nowrap"
										>
											<span class="flex min-w-0 flex-1 basis-64 flex-col gap-1">
												<span
													class="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere] text-ink"
													>{f.name}</span
												>
												<span
													class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
												>
													<span class="font-mono">{f.key}</span>
													<span aria-hidden="true">·</span>
													<span class="tabular-nums"
														>{f.journeys}
														{qaPlural(f.journeys, 'journey')} · {f.cases}
														{qaPlural(f.cases, 'case')}</span
													>
													<span class="flex items-center gap-1">
														{#if f.sizes.length}
															{#each f.sizes as w (w)}
																<span
																	class="rounded-md bg-raised px-2 py-0.5 font-mono text-xs text-muted tabular-nums"
																	>{w}</span
																>
															{/each}
														{:else}
															No sizes
														{/if}
													</span>
												</span>
											</span>
											<span class="flex shrink-0 items-center gap-3 max-sm:w-full max-sm:flex-wrap">
												<QaStatusPill status={f.status} flaky={f.flaky} />
												<span class="w-16 shrink-0">
													{#if f.openBugs > 0}
														<Badge tone="danger">{f.openBugs} {qaPlural(f.openBugs, 'bug')}</Badge>
													{:else}
														<span class="text-xs text-muted tabular-nums">0 bugs</span>
													{/if}
												</span>
												<span
													class="w-40 shrink-0 text-xs text-muted max-sm:ml-auto max-sm:w-auto sm:text-right"
													>{f.lastTestedAt ? ago(f.lastTestedAt) : 'Never tested'}{#if f.lastCommit}
														<span class="block font-mono sm:inline">
															· {f.lastCommit.slice(0, 7)}</span
														>{/if}</span
												>
											</span>
										</a>
										<!-- THE RETEST BUTTON IS A SIBLING OF THE LINK. HOVER OR FOCUS ON A FINE POINTER, ALWAYS ON TOUCH -->
										<Button
											variant="subtle"
											iconOnly
											class="mx-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none max-sm:absolute max-sm:top-1 max-sm:right-1 max-sm:opacity-100 [@media(hover:none)]:opacity-100"
											aria-label={`Copy the retest command for ${f.name}`}
											title="Copy the retest command"
											onclick={() => copyCommand(f.key)}
											data-testid="qa-retest"
										>
											<RotateCcw size={18} />
										</Button>
									</li>
								{/each}
							</ul>
						</section>
					{/each}
				{/if}
			{/if}
		{:else if data.tab === 'runs'}
			{#if !data.runs || data.runs.length === 0}
				<div class={CARD}>
					<EmptyState
						kind="items"
						title="No runs yet"
						text="A run starts when your agent tests the app with /flow-qa. Each run is a plan item with its results and screenshots."
					/>
				</div>
			{:else}
				<ul class="flex flex-col gap-3" data-testid="qa-runs">
					{#each data.runs as r (r.ref)}
						{@const c = r.report?.counts ?? {}}
						{@const total = (c.works ?? 0) + (c.broken ?? 0) + (c.could_not_test ?? 0)}
						<li>
							<a
								href={`${base}/${r.ref}`}
								class="{CARD} flex cursor-pointer flex-col gap-3 p-4 transition-colors hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent max-sm:p-3.5"
							>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
									<p
										class="min-w-0 flex-1 text-lg font-semibold tracking-tight [overflow-wrap:anywhere] text-ink"
									>
										Run {r.runNo} <span class="font-normal text-muted">· {r.scope}</span>
									</p>
									{#if r.report?.goNoGo}
										<Badge tone={r.report.goNoGo === 'go' ? 'success' : 'danger'}
											>{r.report.goNoGo === 'go' ? 'Go' : 'No go'}</Badge
										>
									{/if}
								</div>
								<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
									{#if r.commit}
										<span
											class="rounded-md bg-raised px-2 py-0.5 font-mono text-xs text-muted tabular-nums"
											>{r.commit.slice(0, 7)}</span
										>
										<span aria-hidden="true">·</span>
									{/if}
									{#if r.target}<span>{r.target}</span><span aria-hidden="true">·</span>{/if}
									<span>{ago(r.createdAt)}</span>
								</p>
								{#if total > 0}
									<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
										<span class="min-w-40 flex-1">
											<QaHealthBar
												counts={{
													works: c.works ?? 0,
													broken: c.broken ?? 0,
													could_not_test: c.could_not_test ?? 0
												}}
												label={`Run ${r.runNo}`}
												class="h-1.5 w-full"
											/>
										</span>
										<span class="text-xs text-muted tabular-nums"
											>{c.works ?? 0} work · {c.broken ?? 0} broken · {c.could_not_test ?? 0} couldn’t
											test</span
										>
									</div>
								{/if}
								{#if r.report?.confidence}
									<p class="line-clamp-2 text-sm text-muted">{r.report.confidence}</p>
								{:else if !r.report}
									<p class="text-sm text-muted">No report written yet.</p>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		{:else if allBugs.length === 0}
			<div class={CARD}>
				<EmptyState
					kind="items"
					title="No bugs found"
					text="When a run finds something broken, your agent files one task for each cause here and on the Tasks page."
				/>
			</div>
		{:else}
			<!-- ONE TOOLBAR CARD LIKE THE MAP: THE STATE CHIPS ON THE LEFT, THE SEVERITY ON THE RIGHT -->
			<div
				class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-2.5"
			>
				<div
					class="flex flex-wrap items-center gap-2 max-sm:w-full"
					role="group"
					aria-label="Bug state"
				>
					<button
						type="button"
						class={CHIP}
						aria-pressed={bugState === 'open'}
						onclick={() => go({ bugs: null })}
					>
						<CircleDot size={16} class="text-info" />
						<span class="flex-1 text-left">Open</span>
						<span class={COUNT}>{openBugs}</span>
					</button>
					<button
						type="button"
						class={CHIP}
						aria-pressed={bugState === 'fixed'}
						onclick={() => go({ bugs: 'fixed' })}
					>
						<CircleCheck size={16} class="text-success" />
						<span class="flex-1 text-left">Fixed</span>
						<span class={COUNT}>{allBugs.length - openBugs}</span>
					</button>
					<button
						type="button"
						class={CHIP}
						aria-pressed={bugState === 'all'}
						onclick={() => go({ bugs: 'all' })}
					>
						<List size={16} class="text-muted" />
						<span class="flex-1 text-left">All</span>
						<span class={COUNT}>{allBugs.length}</span>
					</button>
				</div>
				<Select
					label="Severity"
					options={SEVERITY_OPTIONS}
					value={severityFilter}
					onchange={(v) => go({ sev: v === 'all' ? null : v })}
					triggerClass="w-44"
				/>
			</div>

			{#if bugGroups.length === 0}
				<EmptyState kind="search" title="No bugs match" text="Try a different state or severity." />
			{:else}
				<div class="flex flex-col gap-4" data-testid="qa-bugs">
					{#each bugGroups as g (g.sev ?? 'none')}
						<section class="flex flex-col gap-2">
							<div class="flex items-center gap-2 px-1">
								<span
									class="size-2 rounded-full {g.sev === 'blocker' || g.sev === 'major'
										? 'bg-danger'
										: g.sev
											? 'bg-warning'
											: 'bg-muted'}"
									aria-hidden="true"
								></span>
								<h2 class="text-xs font-medium tracking-wide text-muted uppercase">
									{g.sev ? QA_SEVERITY_LABEL[g.sev] : 'Not rated'}
								</h2>
								<span class="text-xs font-semibold text-muted tabular-nums">{g.bugs.length}</span>
							</div>
							<ul class="{CARD} overflow-hidden">
								{#each g.bugs as b (b.id)}
									<li
										class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0"
									>
										<span class="w-14 shrink-0 font-mono text-xs text-muted">{b.ref}</span>
										<a
											href={`${base}/tasks?task=${encodeURIComponent(b.id)}`}
											class="min-h-11 min-w-0 flex-1 basis-64 cursor-pointer content-center text-sm font-medium text-ink hover:underline focus-visible:outline-2"
											><span class="line-clamp-2 [overflow-wrap:anywhere]">{b.title}</span></a
										>
										<a
											href={`${base}/qa/${b.featureKey}`}
											class="max-w-48 cursor-pointer truncate rounded-md bg-raised px-2 py-0.5 text-xs text-muted hover:text-ink max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
											>{b.featureName}</a
										>
										<span class="w-16 shrink-0 font-mono text-xs text-muted tabular-nums"
											>{b.width ? `${b.width} px` : ''}</span
										>
										<Badge tone={qaBugIsOpen(b.status) ? 'info' : 'neutral'}
											>{b.status === 'DONE'
												? 'Fixed'
												: b.status === 'DROPPED'
													? 'Dropped'
													: 'Open'}</Badge
										>
									</li>
								{/each}
							</ul>
						</section>
					{/each}
				</div>
			{/if}
		{/if}
	{/if}
</PageFrame>
