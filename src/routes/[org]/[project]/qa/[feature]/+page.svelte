<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED TYPES
	import type { QaMap } from '#lib/server/db/schema/qa.js';
	// IMPORTED ENVS
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED MODULES
	import { api, newKey } from '#lib/board/api.js';
	import {
		QA_SEVERITY_LABEL,
		QA_STATUS_LABEL,
		qaCommand,
		qaCounts,
		qaPercent,
		qaPlural,
		qaStatusOf,
		type QaStatus
	} from '#lib/board/qa/status.js';
	import { ago } from '#lib/board/status.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Copy from '@lucide/svelte/icons/copy';
	import ImageIcon from '@lucide/svelte/icons/image';
	import List from '@lucide/svelte/icons/list';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	// IMPORTED COMPONENTS
	import QaHealthBar from '#lib/board/qa/QaHealthBar.svelte';
	import QaStatusDot from '#lib/board/qa/QaStatusDot.svelte';
	import QaStatusPill from '#lib/board/qa/QaStatusPill.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import Select from '#lib/ui/Select.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- TYPES -- //

	type Edit =
		| { kind: 'feature' }
		| { kind: 'case'; j: string; s: string; c: string }
		| { kind: 'add-case'; j: string; s: string }
		| { kind: 'add-step'; j: string };
	type Journey = QaMap['journeys'][number];
	type Step = Journey['steps'][number];
	type CaseFilter = 'all' | 'broken' | 'not_tested';

	// -- CONSTANTS -- //

	const PRIORITIES = [
		{ value: 'none', label: 'Not set' },
		{ value: 'high', label: 'High' },
		{ value: 'normal', label: 'Normal' },
		{ value: 'low', label: 'Low' }
	];
	const TITLES: Record<Edit['kind'], string> = {
		feature: 'Edit this feature',
		case: 'What should happen in this case?',
		'add-case': 'Add a case to this step',
		'add-step': 'Add a step to this journey'
	};
	const CARD = 'rounded-xl border border-line bg-surface shadow-[var(--elev-1)]';
	const CHIP =
		'group flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-pressed:border-accent/40 aria-pressed:bg-accent-soft aria-pressed:text-accent-text max-sm:h-11 max-sm:justify-center max-sm:gap-1.5 max-sm:px-2 whitespace-nowrap';
	const COUNT =
		'inline-flex min-w-6 items-center justify-center rounded-full bg-raised px-1.5 text-badge font-semibold text-ink tabular-nums group-aria-pressed:bg-surface group-aria-pressed:text-accent-text';
	// The edit and add buttons show on hover or focus on a fine pointer and always on a touch screen
	const REVEAL =
		'opacity-0 transition-opacity focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100';

	// -- STATES -- //

	let open = $state(false);
	let busy = $state(false);
	// The last edit stays while the dialog closes, so its title and fields do not flash blank
	let edit = $state<Edit>({ kind: 'feature' });
	let name = $state('');
	let area = $state('');
	let priority = $state('none');
	let sizes = $state('');
	let description = $state('');
	let first = $state('');
	let second = $state('');
	let third = $state('');
	// Cases a person opened or closed by hand; every other case opens when it is broken or could not be tested
	let manual = $state<Record<string, boolean>>({});
	const uid = $props.id();

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const f = $derived(data.detail?.feature ?? null);
	const journeys = $derived((f?.map.journeys ?? []).filter((j) => !j.removedAt));
	const main = $derived(journeys.filter((j) => !j.parent));
	const filter = $derived<CaseFilter>(
		page.url.searchParams.get('cases') === 'broken'
			? 'broken'
			: page.url.searchParams.get('cases') === 'not_tested'
				? 'not_tested'
				: 'all'
	);
	/**
	 * Where each branch hangs: under the first journey, reached from the main ones, that has the step it branches from. A step key
	 * is only unique inside its journey, so a branch is placed once and never twice, and a branch that points at itself is not
	 * followed.
	 */
	const placement = $derived.by(() => {
		// Plain records and arrays: they are built and read inside this one computation, never kept as reactive state
		const children: Record<string, Journey[]> = {};
		const seen: string[] = main.map((j) => j.key);
		const queue = [...main];
		while (queue.length > 0) {
			const j = queue.shift()!;
			for (const s of j.steps.filter((x) => !x.removedAt)) {
				for (const b of journeys.filter((x) => x.parent === s.key && !seen.includes(x.key))) {
					seen.push(b.key);
					const at = `${j.key}/${s.key}`;
					(children[at] ??= []).push(b);
					queue.push(b);
				}
			}
		}
		return { children, shown: journeys.filter((j) => seen.includes(j.key)) };
	});
	/** Every case the page shows, with the status its newest result gives it. */
	const allCases = $derived(
		placement.shown.flatMap((j) =>
			j.steps
				.filter((s) => !s.removedAt)
				.flatMap((s) =>
					s.cases
						.filter((c) => !c.removedAt)
						.map((c) => ({
							id: `${j.key}/${s.key}/${c.key}`,
							journey: j.key,
							status: qaStatusOf(
								data.detail?.cases[`${j.key}/${s.key}/${c.key}`]?.outcome ?? 'not_tested'
							)
						}))
				)
		)
	);
	/** Every case is open, so the toggle offers to close them; with any case closed it offers to open them. */
	const allOpen = $derived(allCases.length > 0 && allCases.every((c) => isOpen(c.id)));
	const caseCounts = $derived(qaCounts(allCases.map((c) => c.status)));
	const percent = $derived(qaPercent(caseCounts.works, allCases.length));
	/** The outcomes that have at least one case, in the order the Summary lists them. */
	const summaryStatuses = $derived(
		(['works', 'broken', 'could_not_test', 'not_tested'] as const).filter((x) => caseCounts[x] > 0)
	);
	// Each width once: a repeated width would also repeat the keyed chips below
	const sizeList = $derived([
		...new Set(
			sizes
				.split(/[,\s]+/)
				.map((s) => Number(s))
				.filter((n) => Number.isInteger(n) && n > 0)
		)
	]);
	const uniqueSizes = $derived([...new Set(f?.sizes ?? [])]);
	/** The last result at each screen width the feature is tested at: the worst of the cases tested there. */
	const widthResults = $derived(
		uniqueSizes.map((w) => {
			const outcome = data.detail?.widths[w];
			return { width: w, status: outcome ? qaStatusOf(outcome) : null };
		})
	);
	const valid = $derived.by(() => {
		if (edit.kind === 'feature')
			return (
				name.trim() !== '' && sizeList.every((n) => n >= 200 && n <= 4000) && sizeList.length <= 6
			);
		if (edit.kind === 'case') return first.trim() !== '';
		if (edit.kind === 'add-case') return first.trim() !== '' && second.trim() !== '';
		return first.trim() !== '' && second.trim() !== '';
	});

	// -- FUNCTIONS -- //

	const branches = (j: Journey, s: Step) => placement.children[`${j.key}/${s.key}`] ?? [];
	const liveSteps = (j: Journey) => j.steps.filter((s) => !s.removedAt);
	const liveCases = (s: Step) => s.cases.filter((c) => !c.removedAt);
	const caseId = (j: string, s: string, c: string) => `${j}/${s}/${c}`;
	const domId = (id: string) => `${uid}-${id.replaceAll('/', '__')}`;
	const statusOfCase = (id: string): QaStatus =>
		qaStatusOf(data.detail?.cases[id]?.outcome ?? 'not_tested');
	const shownBy = (status: QaStatus) =>
		filter === 'all' ||
		(filter === 'broken'
			? status === 'broken'
			: status === 'not_tested' || status === 'could_not_test');
	/** A case opens by itself when it is broken or could not be tested, unless a person chose otherwise. */
	const isOpen = (id: string) =>
		id in manual ? manual[id] : ['broken', 'could_not_test'].includes(statusOfCase(id));
	/** Whether a journey, a step or a branch still has a case the filter lets through. */
	function journeyHas(j: Journey): boolean {
		return liveSteps(j).some((s) => stepHas(j, s));
	}
	function stepHas(j: Journey, s: Step): boolean {
		return (
			liveCases(s).some((c) => shownBy(statusOfCase(caseId(j.key, s.key, c.key)))) ||
			branches(j, s).some(journeyHas)
		);
	}
	/** The health of one journey: its own cases, its branches left out. */
	function journeyCounts(j: Journey) {
		return qaCounts(
			liveSteps(j).flatMap((s) =>
				liveCases(s).map((c) => statusOfCase(caseId(j.key, s.key, c.key)))
			)
		);
	}
	function worstOf(j: Journey): QaStatus {
		const c = journeyCounts(j);
		return (
			(['broken', 'needs_retest', 'could_not_test', 'not_tested', 'works'] as const).find(
				(s) => c[s] > 0
			) ?? 'not_tested'
		);
	}

	function setFilter(next: CaseFilter) {
		const u = new URL(page.url.href);
		if (next === 'all') u.searchParams.delete('cases');
		else u.searchParams.set('cases', next);
		void goto(u, { replaceState: true, reset: false });
	}

	function toggleCase(id: string) {
		manual[id] = !isOpen(id);
	}

	function toggleAll() {
		const next = !allOpen;
		manual = Object.fromEntries(allCases.map((c) => [c.id, next]));
	}

	/** A short slug for a new step or case, unique among its siblings. */
	function slug(text: string, taken: string[]) {
		const root =
			text
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 40) || 'item';
		let k = root;
		for (let i = 2; taken.includes(k); i++) k = `${root}-${i}`;
		return k;
	}

	function begin(next: Edit) {
		if (!f) return;
		edit = next;
		first = '';
		second = '';
		third = '';
		if (next.kind === 'feature') {
			name = f.name;
			area = f.area;
			priority = f.priority ?? 'none';
			sizes = f.sizes.join(', ');
			description = f.description;
		}
		if (next.kind === 'case') {
			const c = f.map.journeys
				.find((j) => j.key === next.j)
				?.steps.find((s) => s.key === next.s)
				?.cases.find((x) => x.key === next.c);
			first = c?.expected ?? '';
		}
		open = true;
	}

	/** The map with this edit applied. Every path that changes becomes the person's, so the next discovery keeps it. */
	function nextMap(): QaMap {
		const m = JSON.parse(JSON.stringify(f!.map)) as QaMap;
		if (edit.kind === 'case' || edit.kind === 'add-case') {
			const at = edit;
			const s = m.journeys.find((j) => j.key === at.j)?.steps.find((x) => x.key === at.s);
			if (s && at.kind === 'case') {
				const c = s.cases.find((x) => x.key === at.c);
				if (c) c.expected = first.trim();
			}
			if (s && at.kind === 'add-case')
				s.cases.push({
					key: slug(
						first,
						s.cases.map((c) => c.key)
					),
					input: first.trim(),
					expected: second.trim()
				});
		}
		if (edit.kind === 'add-step') {
			const at = edit;
			const j = m.journeys.find((x) => x.key === at.j);
			if (j)
				j.steps.push({
					key: slug(
						second,
						j.steps.map((s) => s.key)
					),
					page: first.trim(),
					action: second.trim(),
					expected: third.trim() ? { screen: third.trim() } : {},
					cases: []
				});
		}
		return m;
	}

	async function save() {
		if (!f || !valid) return;
		busy = true;
		try {
			const body =
				edit.kind === 'feature'
					? {
							expectVersion: f.version,
							name: name.trim(),
							area: area.trim(),
							priority: priority === 'none' ? null : priority,
							sizes: sizeList,
							description: description.trim()
						}
					: { expectVersion: f.version, map: nextMap() };
			await api(org, `/projects/${key}/qa/features/${f.key}`, {
				method: 'PATCH',
				body,
				key: newKey()
			});
			await invalidate('afb:project');
			open = false;
			toast.success('Saved. The next discovery keeps your change.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'The change could not be saved.');
		} finally {
			busy = false;
		}
	}

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(qaCommand(f?.key));
			toast.success('Copied. Paste it into your coding tool, in this project’s folder.');
		} catch {
			toast.error('The command could not be copied.');
		}
	}

	const pageRuns = (offset: number) => {
		const u = new URL(page.url.href);
		if (offset > 0) u.searchParams.set('runs', String(offset));
		else u.searchParams.delete('runs');
		void goto(u);
	};
</script>

<svelte:head><title>{f ? `${f.name}, Testing` : 'Testing'}</title></svelte:head>

<!-- A CASE: ONE LINE THAT OPENS IN PLACE TO WHAT THE AGENT SAW AND THE PICTURE -->
{#snippet caseBlock(j: Journey, s: Step, c: Step['cases'][number])}
	{@const id = caseId(j.key, s.key, c.key)}
	{@const st = statusOfCase(id)}
	{@const r = data.detail?.cases[id]}
	{@const isOpenNow = isOpen(id)}
	{#if shownBy(st)}
		<li class="group/case rounded-lg border border-line bg-raised/50" data-testid="qa-case">
			<div class="flex items-start">
				<button
					type="button"
					aria-expanded={isOpenNow}
					aria-controls={domId(id)}
					onclick={() => toggleCase(id)}
					class="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
				>
					<QaStatusDot status={st} decorative class="mt-2 size-2" />
					<span class="min-w-0 flex-1">
						<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="text-sm font-medium [overflow-wrap:anywhere] text-ink"
								>{c.input || 'No input'}</span
							>
							{#if r?.severity}
								<Badge
									tone={r.severity === 'blocker' || r.severity === 'major' ? 'danger' : 'warning'}
									>{QA_SEVERITY_LABEL[r.severity] ?? r.severity}</Badge
								>
							{/if}
							<span class="ml-auto"><QaStatusPill status={st} /></span>
						</span>
						<span class="mt-0.5 block text-sm [overflow-wrap:anywhere] text-muted"
							>Should: <span class="text-ink">{c.expected}</span></span
						>
					</span>
					<ChevronDown
						size={16}
						class="mt-1 shrink-0 text-muted transition-transform duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none {isOpenNow
							? 'rotate-180'
							: ''}"
					/>
				</button>
				{#if data.canWrite && !f?.removedAt}
					<Button
						variant="subtle"
						iconOnly
						size="sm"
						class="mt-1.5 mr-1 {REVEAL} group-hover/case:opacity-100"
						aria-label={`Change what should happen for ${c.input || c.key}`}
						onclick={() => begin({ kind: 'case', j: j.key, s: s.key, c: c.key })}
					>
						<Pencil size={16} />
					</Button>
				{/if}
			</div>
			<!-- OPENS OVER 200 MS BY THE ROW HEIGHT, HIDDEN FROM FOCUS AND READERS WHILE CLOSED, OFF UNDER REDUCED MOTION -->
			<div
				id={domId(id)}
				class="grid transition-[grid-template-rows,visibility] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none {isOpenNow
					? 'visible grid-rows-[1fr]'
					: 'invisible grid-rows-[0fr]'}"
			>
				<div class="overflow-hidden">
					<div class="flex flex-col gap-3 border-t border-line px-3 py-3 pl-8">
						{#if r}
							<p class="text-sm text-muted">
								Saw: <span class="[overflow-wrap:anywhere] text-ink"
									>{r.observed || 'nothing written down'}</span
								>
							</p>
							<p class="text-xs text-muted tabular-nums">
								{r.width} px · {r.mode}{r.role ? ` · as ${r.role}` : ''} · {ago(r.at)}
							</p>
							{#if r.screen}
								<a
									href={r.screen.image}
									target="_blank"
									rel="noopener"
									class="block h-20 w-[120px] cursor-pointer overflow-hidden rounded-lg border border-line bg-surface focus-visible:outline-2 focus-visible:outline-accent max-sm:h-16 max-sm:w-24"
									aria-label={`Open the picture the agent saw for ${c.input || c.key}, ${r.width} pixels wide, ${r.mode} mode`}
								>
									<img src={r.screen.image} alt="" class="size-full object-cover" loading="lazy" />
								</a>
							{:else}
								<span class="inline-flex items-center gap-1.5 text-xs text-muted"
									><ImageIcon size={16} /> No picture was taken</span
								>
							{/if}
						{:else}
							<p class="text-sm text-muted">
								The agent has not tested this case yet. Ask it to retest this feature.
							</p>
						{/if}
					</div>
				</div>
			</div>
		</li>
	{/if}
{/snippet}

<!-- A STEP: A NUMBER ON THE RAIL, THE ACTION AND THE PAGE, WHAT SHOULD SHOW, THEN ITS CASES AND ITS BRANCHES -->
{#snippet stepBlock(j: Journey, s: Step, n: number, last: boolean)}
	{#if stepHas(j, s) || filter === 'all'}
		<li class="relative flex gap-3 pb-5 last:pb-0" data-testid="qa-step">
			{#if !last}
				<span class="absolute top-7 bottom-0 left-3 w-px bg-line" aria-hidden="true"></span>
			{/if}
			<span
				class="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface font-mono text-xs text-muted tabular-nums"
				>{n}</span
			>
			<div class="flex min-w-0 flex-1 flex-col gap-3">
				<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<span class="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere] text-ink"
						>{s.action}</span
					>
					<span
						class="rounded-md bg-raised px-2 py-0.5 font-mono text-xs [overflow-wrap:anywhere] text-muted"
						>{s.page}</span
					>
				</div>
				{#if s.expected.screen || s.expected.saved || s.expected.sent || s.expected.logged}
					<dl class="grid gap-x-3 gap-y-1 sm:grid-cols-[72px_minmax(0,1fr)]">
						{#if s.expected.screen}<dt class="text-xs font-medium text-muted">Shows</dt>
							<dd class="text-sm [overflow-wrap:anywhere] text-ink">{s.expected.screen}</dd>{/if}
						{#if s.expected.saved}<dt class="text-xs font-medium text-muted">Saves</dt>
							<dd class="text-sm [overflow-wrap:anywhere] text-ink">{s.expected.saved}</dd>{/if}
						{#if s.expected.sent}<dt class="text-xs font-medium text-muted">Sends</dt>
							<dd class="text-sm [overflow-wrap:anywhere] text-ink">{s.expected.sent}</dd>{/if}
						{#if s.expected.logged}<dt class="text-xs font-medium text-muted">Logs</dt>
							<dd class="text-sm [overflow-wrap:anywhere] text-ink">{s.expected.logged}</dd>{/if}
					</dl>
				{/if}
				<div class="group/step flex flex-col gap-2">
					{#if liveCases(s).length > 0}
						<ul class="flex flex-col gap-2">
							{#each liveCases(s) as c (c.key)}
								{@render caseBlock(j, s, c)}
							{/each}
						</ul>
					{/if}
					{#if data.canWrite && !f?.removedAt}
						<div>
							<Button
								size="sm"
								variant="ghost"
								class={`${REVEAL} group-hover/step:opacity-100`}
								onclick={() => begin({ kind: 'add-case', j: j.key, s: s.key })}
								><Plus size={16} /> Add a case</Button
							>
						</div>
					{/if}
				</div>
				{#each branches(j, s) as b (b.key)}
					<!-- AN ALTERNATIVE PATH SITS UNDER THE STEP IT BRANCHES FROM -->
					{#if filter === 'all' || journeyHas(b)}
						<div class="ml-1 border-l-2 border-line pl-4" data-testid="qa-branch">
							{@render journeyBlock(b, true)}
						</div>
					{/if}
				{/each}
			</div>
		</li>
	{/if}
{/snippet}

<!-- A JOURNEY: A CARD WITH ITS OWN PROGRESS, OR A BRANCH WITHOUT THE CARD -->
{#snippet journeyBlock(j: Journey, nested: boolean)}
	{@const c = journeyCounts(j)}
	{@const total = liveSteps(j).reduce((n, s) => n + liveCases(s).length, 0)}
	<section
		id={nested ? undefined : `j-${j.key}`}
		class={nested ? 'flex flex-col gap-3' : `${CARD} scroll-mt-[73px]`}
		data-testid="qa-journey"
	>
		<div
			class="flex flex-wrap items-center gap-x-3 gap-y-2 {nested
				? ''
				: 'border-b border-line px-4 py-3'}"
		>
			<h2 class="min-w-0 {nested ? 'text-sm' : 'text-lg'} font-semibold tracking-tight text-ink">
				{nested ? `Or: ${j.name}` : j.name}
			</h2>
			<span class="text-xs text-muted tabular-nums"
				>{c.works} of {total}
				{qaPlural(total, 'case')}
				{c.works === 1 && total === 1 ? 'passes' : 'pass'}</span
			>
			<span class="w-16">
				<QaHealthBar counts={c} label={j.name} class="h-1.5 w-16" />
			</span>
			{#if data.canWrite && !f?.removedAt}
				<Button
					size="sm"
					variant="ghost"
					class="ml-auto"
					onclick={() => begin({ kind: 'add-step', j: j.key })}
					><Plus size={16} /> Add a step</Button
				>
			{/if}
		</div>
		<ol class="flex flex-col {nested ? '' : 'p-4'}">
			{#each liveSteps(j) as s, i (s.key)}
				{@render stepBlock(j, s, i + 1, i === liveSteps(j).length - 1)}
			{/each}
		</ol>
	</section>
{/snippet}

<PageFrame class="flex flex-col gap-4 pb-12">
	{#if data.denied}
		<PageHeader title="Testing" back={{ href: `${base}/qa`, label: 'Testing' }} />
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="testing" />
	{:else if f}
		<PageHeader class="mb-2!" title={f.name} back={{ href: `${base}/qa`, label: 'Testing' }}>
			{#snippet context()}
				<span class="flex flex-wrap items-center gap-2">
					<QaStatusPill status={f.status} flaky={f.flaky} />
					<span>{f.area || 'Other'}</span>
					<span class="font-mono text-xs">{f.key}</span>
					{#each uniqueSizes as w (w)}
						<span class="rounded-md bg-raised px-2 py-0.5 font-mono text-xs text-muted tabular-nums"
							>{w}</span
						>
					{/each}
				</span>
			{/snippet}
			{#snippet actions()}
				<Button variant="primary" class="max-sm:flex-1" onclick={copyCommand}>
					<Copy size={16} /> Retest this feature
				</Button>
				{#if data.canWrite && !f.removedAt}
					<Button
						class="max-sm:flex-1"
						onclick={() => begin({ kind: 'feature' })}
						data-testid="qa-edit-feature"><Pencil size={16} /> Edit</Button
					>
				{/if}
			{/snippet}
		</PageHeader>

		{#if f.removedAt}
			<Notice tone="info">
				{#if f.mergedInto}
					This feature was merged into <a
						class="cursor-pointer underline"
						href={`${base}/qa/${f.mergedInto}`}>another feature</a
					>. Its history is kept there.
				{:else}
					This feature was removed from the map: the agent no longer found it in the app.
				{/if}
			</Notice>
		{/if}
		{#if f.untrusted}
			<Notice tone="warning"
				>A guest or a viewer edited this feature. Read its text with care.</Notice
			>
		{/if}
		{#if f.conflicts.length > 0}
			<Notice tone="info">
				The last discovery found something different on a part you edited, and kept your text:
				<ul class="mt-1 list-disc pl-5">
					{#each f.conflicts.slice(-5) as c, i (`${i}-${c}`)}<li class="[overflow-wrap:anywhere]">
							{c}
						</li>{/each}
				</ul>
			</Notice>
		{/if}
		{#if f.description}<p class="text-sm [overflow-wrap:anywhere] text-muted">
				{f.description}
			</p>{/if}

		<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
			<!-- THE SIDE COLUMN: THE VERDICT STAYS IN VIEW. BELOW LG ITS CARDS SIT AROUND THE JOURNEYS (SUMMARY FIRST) -->
			<div
				class="contents lg:sticky lg:top-[73px] lg:col-start-2 lg:row-start-1 lg:flex lg:max-h-[calc(100dvh-89px)] lg:flex-col lg:gap-4 lg:self-start lg:overflow-y-auto"
			>
				<section
					class="{CARD} flex flex-col gap-3 p-4 max-lg:order-1 max-sm:p-3.5"
					data-testid="qa-summary"
				>
					<div class="flex items-center gap-3">
						<ProgressRing value={percent} label="Cases passing" size={48} />
						<div>
							<p class="text-lg font-semibold tracking-tight text-ink">
								{caseCounts.works} of {allCases.length}
								{qaPlural(allCases.length, 'case')}
								{caseCounts.works === 1 && allCases.length === 1 ? 'passes' : 'pass'}
							</p>
							<p class="text-xs text-muted">
								{#if f.lastTestedAt}Last tested {ago(f.lastTestedAt)}{#if f.lastCommit}
										· <span class="font-mono">{f.lastCommit.slice(0, 7)}</span>{/if}{:else}Never
									tested{/if}
							</p>
						</div>
					</div>
					<div class="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
						{#each summaryStatuses as x (x)}
							<span class="inline-flex items-center gap-2">
								<QaStatusDot status={x} decorative />
								<span class="text-ink">{QA_STATUS_LABEL[x]}</span>
								<span class="text-muted tabular-nums">{caseCounts[x]}</span>
							</span>
						{/each}
					</div>
					{#if widthResults.length > 0}
						<div class="flex flex-col gap-1.5 border-t border-line pt-3">
							<p class="text-xs font-medium text-muted">Last result by screen width</p>
							<div class="flex flex-wrap gap-2">
								{#each widthResults as w (w.width)}
									<span
										class="inline-flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 font-mono text-xs text-ink tabular-nums"
									>
										{#if w.status}<QaStatusDot status={w.status} class="size-1.5" />{:else}<span
												class="text-muted"
												aria-hidden="true">–</span
											>{/if}{w.width}
									</span>
								{/each}
							</div>
						</div>
					{/if}
					{#if f.priority}
						<p class="border-t border-line pt-3 text-sm text-muted">
							Priority <span class="font-medium text-ink"
								>{PRIORITIES.find((p) => p.value === f.priority)?.label ?? f.priority}</span
							>
						</p>
					{/if}
				</section>

				{#if main.length > 1}
					<nav
						class="{CARD} hidden flex-col gap-1 p-3 max-lg:order-5 xl:flex"
						aria-label="On this page"
					>
						<p class="px-2 pb-1 text-xs font-medium text-muted">On this page</p>
						{#each main as j (j.key)}
							<a
								href={`#j-${j.key}`}
								class="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-ink hover:bg-raised"
								><QaStatusDot status={worstOf(j)} />{j.name}</a
							>
						{/each}
					</nav>
				{/if}

				{#if f.bugs.length > 0}
					<section class="{CARD} flex flex-col gap-2 p-4 max-lg:order-3 max-sm:p-3.5">
						<h2 class="text-lg font-semibold tracking-tight text-ink">Open bugs</h2>
						<ul class="flex flex-col">
							{#each f.bugs as b (b.id)}
								<li class="flex flex-col gap-1 py-1">
									<span class="font-mono text-xs text-muted">{b.ref}</span>
									<a
										href={`${base}/tasks?task=${encodeURIComponent(b.id)}`}
										class="cursor-pointer text-sm font-medium [overflow-wrap:anywhere] text-ink hover:underline"
										>{b.title}</a
									>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				<section class="{CARD} flex flex-col gap-2 p-4 max-lg:order-4 max-sm:p-3.5">
					<h2 class="text-lg font-semibold tracking-tight text-ink">Runs</h2>
					{#if (data.detail?.runs.length ?? 0) === 0}
						<p class="text-sm text-muted">No run has tested this feature yet.</p>
					{:else}
						<ul class="flex flex-col divide-y divide-line">
							{#each data.detail?.runs ?? [] as r (r.ref)}
								<li>
									<a
										href={`${base}/${r.ref}`}
										class="flex min-h-11 cursor-pointer flex-col justify-center py-1 hover:underline"
									>
										<span class="text-sm font-medium text-ink"
											>Run {r.runNo} <span class="font-normal text-muted">· {ago(r.at)}</span></span
										>
										<span class="text-xs text-muted tabular-nums"
											>{r.works} work · {r.broken} broken · {r.couldNotTest} couldn’t test</span
										>
									</a>
								</li>
							{/each}
						</ul>
						<div class="flex gap-2">
							{#if (data.detail?.runsOffset ?? 0) > 0}
								<Button
									size="sm"
									onclick={() => pageRuns(Math.max(0, (data.detail?.runsOffset ?? 0) - 10))}
									>Newer runs</Button
								>
							{/if}
							{#if data.detail?.moreRuns}
								<Button size="sm" onclick={() => pageRuns((data.detail?.runsOffset ?? 0) + 10)}
									>Older runs</Button
								>
							{/if}
						</div>
					{/if}
				</section>
			</div>

			<div class="flex min-w-0 flex-col gap-4 max-lg:order-2 lg:col-start-1 lg:row-start-1">
				{#if main.length === 0}
					<div class={CARD}>
						<EmptyState
							kind="items"
							title="No journeys yet"
							text="Your agent adds this feature's journeys the next time it runs /flow-qa discover."
						/>
					</div>
				{:else}
					<!-- ONE TOOLBAR CARD LIKE THE MAP: THE CASE FILTER ON THE LEFT, ONE EXPAND TOGGLE ON THE RIGHT -->
					<div
						class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-2.5"
					>
						<div
							class="flex flex-wrap items-center gap-2 max-sm:grid max-sm:w-full max-sm:grid-cols-3"
							role="group"
							aria-label="Show cases"
						>
							<button
								type="button"
								class={CHIP}
								aria-pressed={filter === 'all'}
								onclick={() => setFilter('all')}
							>
								<List size={16} class="text-muted max-sm:hidden" />
								<span>All<span class="max-sm:hidden"> cases</span></span>
								<span class={COUNT}>{allCases.length}</span>
							</button>
							<button
								type="button"
								class={CHIP}
								aria-pressed={filter === 'broken'}
								onclick={() => setFilter('broken')}
							>
								<QaStatusDot status="broken" decorative class="size-2 max-sm:hidden" />
								<span>Broken</span>
								<span class={COUNT}>{caseCounts.broken}</span>
							</button>
							<button
								type="button"
								class={CHIP}
								aria-pressed={filter === 'not_tested'}
								onclick={() => setFilter('not_tested')}
							>
								<QaStatusDot status="not_tested" decorative class="size-2 max-sm:hidden" />
								<span class="max-sm:hidden">Not tested</span><span class="sm:hidden">Untested</span>
								<span class={COUNT}>{caseCounts.not_tested + caseCounts.could_not_test}</span>
							</button>
						</div>
						<Button class="max-sm:w-full" onclick={toggleAll}>
							<ChevronsUpDown size={16} class="text-muted" />
							{allOpen ? 'Collapse all' : 'Expand all'}
						</Button>
					</div>

					{#each main as j (j.key)}
						{#if filter === 'all' || journeyHas(j)}
							{@render journeyBlock(j, false)}
						{/if}
					{/each}
					{#if filter !== 'all' && !main.some(journeyHas)}
						<p class="px-1 text-sm text-muted">
							{filter === 'broken' ? 'No broken cases.' : 'No cases are waiting to be tested.'}
						</p>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</PageFrame>

<ResponsiveModal {open} onclose={() => (open = false)} title={TITLES[edit.kind]} {busy}>
	<form
		class="flex flex-col gap-4 text-sm"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		{#if edit.kind === 'feature'}
			<TextField
				label="What is this feature called?"
				bind:value={name}
				maxlength={120}
				class="text-sm"
			/>
			<TextField
				label="Which area of the app is it in?"
				placeholder="Billing"
				bind:value={area}
				maxlength={80}
				class="text-sm"
			/>
			<div class="flex flex-col gap-1.5">
				<span class="text-sm font-medium text-ink">How important is it to test?</span>
				<Select label="How important is it to test?" options={PRIORITIES} bind:value={priority} />
			</div>
			<TextField
				label="Which screen widths should it be tested at?"
				hint="Pixels, separated by commas, up to six. For example 390, 768, 1440."
				bind:value={sizes}
				class="text-sm"
			/>
			<TextArea
				label="What does it do? (optional)"
				bind:value={description}
				rows={3}
				maxlength={2000}
			/>
		{:else if edit.kind === 'case'}
			<TextArea label="What should happen?" bind:value={first} rows={3} maxlength={1000} />
		{:else if edit.kind === 'add-case'}
			<TextField
				label="What does the tester try?"
				placeholder="Attendees: -3"
				bind:value={first}
				maxlength={400}
				class="text-sm"
			/>
			<TextArea label="What should happen?" bind:value={second} rows={3} maxlength={1000} />
		{:else}
			<TextField
				label="On which page?"
				placeholder="/planning"
				bind:value={first}
				maxlength={300}
				class="text-sm"
			/>
			<TextField
				label="What does the person do?"
				placeholder="Clicks New estimate"
				bind:value={second}
				maxlength={300}
				class="text-sm"
			/>
			<TextArea
				label="What should the screen show? (optional)"
				bind:value={third}
				rows={2}
				maxlength={1000}
			/>
		{/if}
		<button type="submit" class="hidden" aria-hidden="true" tabindex="-1"></button>
	</form>
	{#snippet footer()}
		<Button onclick={() => (open = false)} disabled={busy}>Cancel</Button>
		<Button variant="primary" onclick={save} disabled={busy || !valid}
			>{busy ? 'Saving…' : 'Save'}</Button
		>
	{/snippet}
</ResponsiveModal>
