<script lang="ts">
	// IMPORTED TYPES
	import type { Device, Status } from '#lib/board/testing/status.js';
	// IMPORTED ENVS
	import { page } from '$app/state';
	// IMPORTED CONSTANTS
	import { STATUS_LABEL, retestPrompt } from '#lib/board/testing/status.js';
	// IMPORTED MODULES
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Clock from '@lucide/svelte/icons/clock';
	import Copy from '@lucide/svelte/icons/copy';
	import Info from '@lucide/svelte/icons/info';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	// IMPORTED COMPONENTS
	import DeviceBar from '#lib/board/testing/DeviceBar.svelte';
	import TestStatus from '#lib/board/testing/TestStatus.svelte';
	import Button from '#lib/ui/Button.svelte';
	import TabCard from './TabCard.svelte';

	// -- TYPES -- //

	type PlanCase = {
		key: string;
		title: string;
		kind: string;
		role: string;
		baseline: string;
		now: string;
		regression: boolean;
		devices: { device: string; width: number; height: number; status: string }[];
	};
	type View = {
		cases: PlanCase[];
		waiver: string | null;
		owed: { key: string; note: string; done: boolean }[];
		live: { runNo: number } | null;
		block: { reason: string; message: string; cases: string[] } | null;
	};

	// -- REQUIRED PROPS -- //

	let { testing }: { testing: { shown: boolean; count: number; view: View | null } } = $props();

	// -- CONSTANTS -- //

	const GROUPS: { role: string; name: string; meaning: string }[] = [
		{ role: 'new', name: 'New', meaning: 'written by this plan' },
		{ role: 'update', name: 'Updated', meaning: 'behaviour changed, new version' },
		{ role: 'reuse', name: 'Re-run', meaning: 'regression checks, least recently run first' },
		{ role: 'retire', name: 'Retired', meaning: 'behaviour removed by this plan' }
	];
	const TONE = {
		danger: ['border-danger/30 bg-danger-soft', 'text-danger'],
		info: ['border-info/30 bg-info-soft', 'text-info'],
		success: ['border-success/30 bg-success-soft', 'text-success'],
		neutral: ['border-line bg-raised/60', 'text-muted']
	};
	const COLS = 'sm:grid-cols-[112px_minmax(0,1fr)_132px_176px]';

	// -- REACTIVE STATES -- //

	const view = $derived(testing.view);
	const base = $derived(`/${page.params.org ?? ''}/${page.params.project ?? ''}`);
	const ref = $derived(page.params.item ?? '');
	const live = $derived((view?.cases ?? []).filter((c) => c.now !== 'retired'));
	const passing = $derived(live.filter((c) => c.now === 'pass').length);
	const verdict = $derived.by(() => {
		if (!view) return null;
		if (view.cases.length === 0 && view.waiver)
			return {
				tone: 'neutral' as const,
				title: 'No test cases: waiver recorded',
				line: `${view.waiver[0].toUpperCase()}${view.waiver.slice(1)}. Nothing blocks Completed.`
			};
		if (view.live)
			return {
				tone: 'info' as const,
				title: `Run ${view.live.runNo} is running`,
				line: `${live.filter((c) => c.now !== 'not_run').length} of ${live.length} cases have a result. Results appear here as they come in.`
			};
		if (view.block?.reason === 'tests-regression')
			return {
				tone: 'danger' as const,
				title: 'A regression blocks Completed',
				line: `${view.block.message} An agent cannot mark the plan Completed; you still can.`
			};
		if (view.block?.reason === 'tests-failed')
			return {
				tone: 'danger' as const,
				title: 'A failing case blocks Completed',
				line: `${view.block.message} An agent cannot mark the plan Completed; you still can.`
			};
		if (view.block?.reason === 'tests-not-run')
			return {
				tone: 'neutral' as const,
				title: 'Adopted but not run yet',
				line: view.block.message
			};
		if (live.length > 0 && passing === live.length)
			return {
				tone: 'success' as const,
				title: `All ${live.length} cases pass`,
				line: 'Nothing blocks Completed.'
			};
		return null;
	});
	const tiles = $derived(
		GROUPS.map((g) => {
			const list = (view?.cases ?? []).filter((c) => c.role === g.role);
			const bad = list.filter((c) => c.now === 'fail' || c.now === 'blocked').length;
			return {
				...g,
				count: list.length,
				bad,
				running: !!view?.live && list.some((c) => c.now === 'not_run')
			};
		})
	);
	const owedOpen = $derived((view?.owed ?? []).filter((o) => !o.done));

	// -- FUNCTIONS -- //

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied. Paste it into your coding tool, in this project’s folder.');
		} catch {
			toast.error('The browser did not let the page copy. Select the text and copy it yourself.');
		}
	}

	const asStatus = (s: string): Status =>
		['pass', 'fail', 'blocked', 'not_run'].includes(s) ? (s as Status) : 'not_run';
</script>

<!-- THE TESTING TAB OF A PLAN: THE CASES IT WROTE, UPDATED, RE-RAN AND RETIRED, BEFORE AND NOW, AND WHAT IT STILL OWES (AFB-20261127-0438) -->
<TabCard title="Testing" stack>
	{#snippet meta()}<span class="text-xs text-muted"
			>{testing.count} {testing.count === 1 ? 'case' : 'cases'}</span
		>{/snippet}
	{#snippet actions()}
		{#if testing.count > 0}
			<Button size="sm" onclick={() => copy(retestPrompt(ref))}
				><Copy size={16} aria-hidden="true" /> Copy retest command</Button
			>
		{/if}
	{/snippet}
	{#if view}
		<div class="flex flex-col gap-4 p-5 max-sm:p-4" data-testid="testing-tab">
			{#if verdict}
				<div
					class={['flex items-start gap-3 rounded-xl border p-4', TONE[verdict.tone][0]]}
					role={verdict.tone === 'danger' ? 'alert' : 'status'}
				>
					<span class={['mt-0.5 shrink-0', TONE[verdict.tone][1]]}>
						{#if verdict.tone === 'danger'}<CircleX
								size={18}
								aria-hidden="true"
							/>{:else if verdict.tone === 'success'}<CircleCheck
								size={18}
								aria-hidden="true"
							/>{:else if verdict.tone === 'info'}<LoaderCircle
								size={18}
								class="motion-safe:animate-spin"
								aria-hidden="true"
							/>{:else}<Info size={18} aria-hidden="true" />{/if}
					</span>
					<div class="min-w-0">
						<p class="text-base font-semibold text-ink">{verdict.title}</p>
						<p class="mt-0.5 text-sm text-muted">{verdict.line}</p>
					</div>
				</div>
			{/if}
			{#if view.cases.length > 0}
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
					{#each tiles as t (t.role)}
						<div class="flex flex-col gap-0.5 rounded-lg border border-line px-4 py-3">
							<span class="text-xs text-muted">{t.name}</span>
							<span class="text-lg font-semibold text-ink tabular-nums">{t.count}</span>
							<span class="text-xs">
								{#if t.role === 'retire'}<span class="text-muted">left the suite</span
									>{:else if t.bad > 0}<span class="font-semibold text-danger">{t.bad} failing</span
									>{:else if t.running}<span class="font-semibold text-info">running</span
									>{:else if t.count === 0}<span class="text-muted">none</span>{:else}<span
										class="text-muted">all pass</span
									>{/if}
							</span>
						</div>
					{/each}
				</div>
			{:else if !view.waiver}
				<p class="text-sm text-muted">
					This plan has no test cases yet. Its coding tool adopts or writes them, or records a tests
					waiver.
				</p>
			{/if}
		</div>
		{#if view.cases.length > 0}
			<div
				class={['hidden gap-x-6 px-5 pb-2 text-xs font-medium text-muted sm:grid', COLS]}
				aria-hidden="true"
			>
				<span>ID</span><span>Test case</span><span>Devices</span><span>Before → now</span>
			</div>
			{#each GROUPS as g (g.role)}
				{@const list = view.cases.filter((c) => c.role === g.role)}
				{#if list.length > 0}
					<section>
						<div
							class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-y border-line bg-raised/50 px-5 py-2 max-sm:px-4"
						>
							<h3 class="text-sm font-semibold text-ink">{g.name}</h3>
							<span class="text-xs text-muted tabular-nums">{list.length}</span>
							<span class="text-xs text-muted">· {g.meaning}</span>
						</div>
						<ul>
							{#each list as c (c.key)}
								{@const now = c.now === 'retired' ? null : asStatus(c.now)}
								{@const loud = now === 'fail' || now === 'blocked'}
								<li class="relative border-b border-line last:border-b-0">
									{#if c.regression}<span
											class="absolute inset-y-0 left-0 w-[3px] bg-danger"
											aria-hidden="true"
										></span>{/if}
									<a
										href={`${base}/testing?case=${c.key}`}
										class={[
											'grid min-h-14 w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-5 py-3 text-left hover:bg-raised/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-sm:px-4',
											COLS
										]}
									>
										<span
											class={['font-mono text-xs max-sm:hidden', loud ? 'text-ink' : 'text-muted']}
											>{c.key}</span
										>
										<span class="flex min-w-0 flex-col gap-0.5 max-sm:col-span-2">
											<span class="font-mono text-xs text-muted sm:hidden">{c.key}</span>
											<span class="line-clamp-2 text-sm font-medium text-ink">{c.title}</span>
											{#if c.regression}<span class="text-xs font-semibold text-danger"
													>Regression: passed before this plan</span
												>{/if}
										</span>
										<span>
											<DeviceBar
												kind={c.kind}
												results={c.devices.map((x) => ({
													device: x.device as Device,
													width: x.width,
													height: x.height,
													status: asStatus(x.status)
												}))}
											/>
										</span>
										<span class="justify-self-end sm:justify-self-start">
											{#if now === null}
												<span class="text-sm text-muted">Retired</span>
											{:else if c.baseline === now}
												<TestStatus status={now} />
												{#if now === 'fail'}<span class="block pl-3.5 text-xs text-muted"
														>failing before too</span
													>{/if}
											{:else}
												<span class="flex items-center gap-2">
													<span class="text-xs text-muted"
														>{c.baseline === 'none'
															? 'New'
															: STATUS_LABEL[asStatus(c.baseline)]}</span
													>
													<ArrowRight size={14} class="shrink-0 text-muted" aria-hidden="true" />
													<TestStatus status={now} />
												</span>
											{/if}
										</span>
									</a>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/each}
		{/if}
		{#if owedOpen.length > 0}
			<div
				class="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 text-sm max-sm:px-4"
			>
				<Clock size={16} class="text-muted" aria-hidden="true" />
				<span class="text-muted">Owed to the next deploy:</span>
				{#each owedOpen as o (o.key)}
					<span
						class="rounded-md bg-raised px-2 py-0.5 font-mono text-xs text-muted tabular-nums"
						title={o.note}>{o.key}</span
					>
				{/each}
			</div>
		{/if}
	{:else}
		<p class="p-5 text-sm text-muted max-sm:p-4">Loading the test cases…</p>
	{/if}
</TabCard>
