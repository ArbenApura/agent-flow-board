<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED ENVS
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { api, newKey } from '#lib/board/api.js';
	import {
		QA_SEVERITY_LABEL,
		QA_STATUSES,
		QA_STATUS_LABEL,
		QA_TABS,
		QA_TAB_LABEL,
		qaCommand,
		qaStatusOf,
		qaSummary,
		type QaTab
	} from '#lib/board/qa/status.js';
	import { ago } from '#lib/board/status.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Copy from '@lucide/svelte/icons/copy';
	import Globe from '@lucide/svelte/icons/globe';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	// IMPORTED COMPONENTS
	import QaStatusPill from '#lib/board/qa/QaStatusPill.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- TYPES -- //

	type TargetRow = { id: string; origin: string; writes: boolean };

	// -- STATES -- //

	// The search box shows the filter the address holds, so a shared or reloaded link does not look unfiltered
	let q = $state(untrack(() => page.url.searchParams.get('q') ?? ''));
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let targetsOpen = $state(false);
	let targetsBusy = $state(false);
	let targetRows = $state<TargetRow[]>([]);

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const projectName = $derived(data.summary?.project.name ?? key);
	const statusFilter = $derived(page.url.searchParams.get('status') ?? 'all');
	const areaFilter = $derived(page.url.searchParams.get('area') ?? 'all');
	const query = $derived((page.url.searchParams.get('q') ?? '').trim().toLowerCase());
	const areas = $derived([...new Set(data.features.map((f) => f.area || 'Other'))].sort());
	const shown = $derived(
		data.features.filter(
			(f) =>
				(statusFilter === 'all' || f.status === statusFilter) &&
				(areaFilter === 'all' || (f.area || 'Other') === areaFilter) &&
				(query === '' ||
					f.name.toLowerCase().includes(query) ||
					f.key.toLowerCase().includes(query))
		)
	);
	const groups = $derived(
		areas
			.map((a) => ({ area: a, features: shown.filter((f) => (f.area || 'Other') === a) }))
			.filter((g) => g.features.length > 0)
	);
	const filtering = $derived(query !== '' || statusFilter !== 'all' || areaFilter !== 'all');
	const summaryLine = $derived(qaSummary(data.features.map((f) => qaStatusOf(f.status))));
	const statusOptions = $derived([
		{ value: 'all', label: 'All statuses' },
		...QA_STATUSES.map((s) => ({ value: s, label: QA_STATUS_LABEL[s] }))
	]);
	const areaOptions = $derived([
		{ value: 'all', label: 'All areas' },
		...areas.map((a) => ({ value: a, label: a }))
	]);
	const targetsValid = $derived(
		targetRows.every((t) => /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i.test(t.origin.trim()))
	);

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
		searchTimer = setTimeout(() => go({ q: q.trim() || null }), 250);
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

	function openTargets() {
		targetRows = data.targets.map((t) => ({ id: crypto.randomUUID(), ...t }));
		targetsOpen = true;
	}

	function addTarget() {
		targetRows = [...targetRows, { id: crypto.randomUUID(), origin: '', writes: false }];
	}

	async function saveTargets() {
		targetsBusy = true;
		try {
			await api(org, `/projects/${key}/qa/settings/targets`, {
				method: 'PUT',
				body: {
					targets: targetRows
						.filter((t) => t.origin.trim() !== '')
						.map((t) => ({ origin: t.origin.trim(), writes: t.writes }))
				},
				key: newKey()
			});
			await invalidate('afb:project');
			targetsOpen = false;
			toast.success('Test addresses saved.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'The test addresses could not be saved.');
		} finally {
			targetsBusy = false;
		}
	}
</script>

<svelte:head><title>Testing, {projectName}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader class="mb-2!" title="Testing" context={data.denied ? undefined : summaryLine}>
		{#snippet actions()}
			{#if !data.denied && data.features.length > 0}
				<Button onclick={() => copyCommand()} data-testid="qa-copy-command">
					<Copy size={16} /> Copy the test command
				</Button>
			{/if}
			{#if data.canEdit}
				<Button onclick={openTargets} data-testid="qa-targets">
					<Globe size={16} /> Test addresses
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
			options={QA_TABS.map((t) => ({ value: t, label: QA_TAB_LABEL[t as QaTab] }))}
			onchange={(v) => go({ tab: v === 'map' ? null : v })}
			class="max-sm:w-full"
		/>

		{#if data.tab === 'map'}
			{#if data.features.length === 0}
				<div
					class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
					data-testid="qa-empty"
				>
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
				<!-- ONE TOOLBAR CARD: THE SEARCH AND THE FILTERS, AS ON THE TASKS AND MOCKUPS PAGES -->
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
						label="Status"
						options={statusOptions}
						value={statusFilter}
						onchange={(v) => go({ status: v === 'all' ? null : v })}
						triggerClass="w-44"
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
						<section class="flex flex-col gap-2" data-testid="qa-area">
							<h2 class="px-1 text-xs font-medium text-muted">{g.area}</h2>
							<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
								{#each g.features as f (f.id)}
									<li
										class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0"
										data-testid="qa-feature"
									>
										<a
											href={`${base}/qa/${f.key}`}
											class="min-h-11 min-w-0 flex-1 cursor-pointer content-center text-sm font-medium text-ink hover:underline focus-visible:outline-2"
											><span class="line-clamp-2 [overflow-wrap:anywhere]">{f.name}</span></a
										>
										<span
											class="w-36 shrink-0 font-mono text-xs text-muted tabular-nums max-lg:hidden"
											>{f.sizes.length ? f.sizes.join(' · ') : 'No sizes'}</span
										>
										<QaStatusPill status={f.status} flaky={f.flaky} />
										<span class="w-20 shrink-0 text-xs text-muted tabular-nums"
											>{f.openBugs} {f.openBugs === 1 ? 'bug' : 'bugs'}</span
										>
										<span
											class="w-40 shrink-0 text-right text-xs text-muted max-sm:w-full max-sm:text-left"
											>{f.lastTestedAt ? ago(f.lastTestedAt) : 'Never tested'}{#if f.lastCommit}
												<span class="font-mono"> · {f.lastCommit.slice(0, 7)}</span>{/if}</span
										>
									</li>
								{/each}
							</ul>
						</section>
					{/each}
				{/if}
			{/if}
		{:else if data.tab === 'runs'}
			{#if !data.runs || data.runs.length === 0}
				<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					<EmptyState
						kind="items"
						title="No runs yet"
						text="A run starts when your agent tests the app with /flow-qa. Each run is a plan item with its results and screenshots."
					/>
				</div>
			{:else}
				<ul
					class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
					data-testid="qa-runs"
				>
					{#each data.runs as r (r.ref)}
						{@const counts = r.report?.counts ?? {}}
						<li
							class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0"
						>
							<a
								href={`${base}/${r.ref}`}
								class="min-h-11 min-w-0 flex-1 cursor-pointer content-center text-sm font-medium text-ink hover:underline focus-visible:outline-2"
								><span class="line-clamp-2 [overflow-wrap:anywhere]">Run {r.runNo}: {r.scope}</span
								></a
							>
							<span class="font-mono text-xs text-muted max-md:hidden"
								>{r.commit ? r.commit.slice(0, 7) : 'no commit'}</span
							>
							<span class="text-xs text-muted tabular-nums"
								>{counts.works ?? 0} work · {counts.broken ?? 0} broken · {counts.could_not_test ??
									0}
								couldn't test</span
							>
							{#if r.report?.goNoGo}
								<Badge tone={r.report.goNoGo === 'go' ? 'success' : 'danger'}
									>{r.report.goNoGo === 'go' ? 'Go' : 'No go'}</Badge
								>
							{/if}
							<span class="w-24 shrink-0 text-right text-xs text-muted max-sm:hidden"
								>{ago(r.createdAt)}</span
							>
							{#if r.report?.confidence}
								<p class="w-full text-xs text-muted">{r.report.confidence}</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{:else if !data.bugs || data.bugs.length === 0}
			<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
				<EmptyState
					kind="items"
					title="No bugs found"
					text="When a run finds something broken, your agent files one task for each cause here and on the Tasks page."
				/>
			</div>
		{:else}
			<ul
				class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
				data-testid="qa-bugs"
			>
				{#each data.bugs as b (b.id)}
					<li
						class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0"
					>
						<span class="w-14 shrink-0 font-mono text-xs text-muted">{b.ref}</span>
						<a
							href={`${base}/tasks?task=${encodeURIComponent(b.id)}`}
							class="min-h-11 min-w-0 flex-1 cursor-pointer content-center text-sm font-medium text-ink hover:underline focus-visible:outline-2"
							><span class="line-clamp-2 [overflow-wrap:anywhere]">{b.title}</span></a
						>
						{#if b.severity}
							<Badge
								tone={b.severity === 'blocker' || b.severity === 'major' ? 'danger' : 'warning'}
								>{QA_SEVERITY_LABEL[b.severity] ?? b.severity}</Badge
							>
						{/if}
						<span class="w-40 shrink-0 truncate text-xs text-muted max-md:hidden"
							>{b.featureName}</span
						>
						<span class="w-16 shrink-0 font-mono text-xs text-muted tabular-nums max-sm:hidden"
							>{b.width ? `${b.width}px` : ''}</span
						>
						<Badge tone={b.status === 'DONE' || b.status === 'DROPPED' ? 'neutral' : 'info'}
							>{b.status === 'DONE' ? 'Fixed' : b.status === 'DROPPED' ? 'Dropped' : 'Open'}</Badge
						>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</PageFrame>

<!-- THE TEST ADDRESSES: WHERE A RUN MAY TEST, AND WHICH ONES HOLD THROWAWAY DATA A RUN MAY WRITE TO -->
<ResponsiveModal
	open={targetsOpen}
	onclose={() => (targetsOpen = false)}
	title="Where may your agent test this app?"
	busy={targetsBusy}
>
	<div class="flex flex-col gap-4 text-sm">
		<p class="text-sm text-muted">
			The build preview at <span class="font-mono">{data.localPreview}</span> is always allowed and always
			read only, because it uses your real local data. Add a staging or demo address here. Turn on writes
			only for an address whose data can be thrown away.
		</p>
		{#each targetRows as t (t.id)}
			<div class="flex flex-col gap-2 rounded-lg border border-line p-3">
				<div class="flex items-end gap-2">
					<div class="min-w-0 flex-1">
						<TextField
							label="Which address?"
							placeholder="https://staging.example.com"
							bind:value={t.origin}
							class="text-sm"
						/>
					</div>
					<Button
						iconOnly
						onclick={() => (targetRows = targetRows.filter((x) => x.id !== t.id))}
						aria-label="Remove this address"
					>
						<Trash2 size={16} />
					</Button>
				</div>
				<Switch
					label="This address holds throwaway data, so a test may submit forms"
					bind:checked={t.writes}
				/>
			</div>
		{/each}
		<div>
			<Button onclick={addTarget}><Plus size={16} /> Add an address</Button>
		</div>
		{#if !targetsValid}
			<p class="text-sm text-danger">
				Use an address like https://staging.example.com, with no path.
			</p>
		{/if}
	</div>
	{#snippet footer()}
		<Button onclick={() => (targetsOpen = false)} disabled={targetsBusy}>Cancel</Button>
		<Button variant="primary" onclick={saveTargets} disabled={targetsBusy || !targetsValid}
			>{targetsBusy ? 'Saving…' : 'Save addresses'}</Button
		>
	{/snippet}
</ResponsiveModal>
