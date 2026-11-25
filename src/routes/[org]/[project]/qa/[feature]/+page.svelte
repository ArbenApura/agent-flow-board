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
	import { QA_SEVERITY_LABEL, qaCommand } from '#lib/board/qa/status.js';
	import { ago } from '#lib/board/status.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Copy from '@lucide/svelte/icons/copy';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	// IMPORTED COMPONENTS
	import QaStatusPill from '#lib/board/qa/QaStatusPill.svelte';
	import ScreenViewer from '#lib/board/ScreenViewer.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
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

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const f = $derived(data.detail?.feature ?? null);
	const journeys = $derived((f?.map.journeys ?? []).filter((j) => !j.removedAt));
	const main = $derived(journeys.filter((j) => !j.parent));
	const branches = (stepKey: string) => journeys.filter((j) => j.parent === stepKey);
	const sizeList = $derived(
		sizes
			.split(/[,\s]+/)
			.map((s) => Number(s))
			.filter((n) => Number.isInteger(n) && n > 0)
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

{#snippet stepBlock(
	j: { key: string; name: string },
	s: QaMap['journeys'][number]['steps'][number],
	n: number
)}
	<li
		class="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-b-0"
		data-testid="qa-step"
	>
		<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<span class="font-mono text-xs text-muted tabular-nums">{n}</span>
			<span class="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere] text-ink"
				>{s.action}</span
			>
			<span class="font-mono text-xs [overflow-wrap:anywhere] text-muted">{s.page}</span>
		</div>
		{#if s.expected.screen || s.expected.saved || s.expected.sent || s.expected.logged}
			<dl class="grid gap-1 text-sm text-muted sm:grid-cols-[96px_minmax(0,1fr)]">
				{#if s.expected.screen}<dt class="text-xs font-medium">Shows</dt>
					<dd class="text-ink">{s.expected.screen}</dd>{/if}
				{#if s.expected.saved}<dt class="text-xs font-medium">Saves</dt>
					<dd class="text-ink">{s.expected.saved}</dd>{/if}
				{#if s.expected.sent}<dt class="text-xs font-medium">Sends</dt>
					<dd class="text-ink">{s.expected.sent}</dd>{/if}
				{#if s.expected.logged}<dt class="text-xs font-medium">Logs</dt>
					<dd class="text-ink">{s.expected.logged}</dd>{/if}
			</dl>
		{/if}
		{#if s.cases.filter((c) => !c.removedAt).length > 0}
			<ul class="flex flex-col gap-2">
				{#each s.cases.filter((c) => !c.removedAt) as c (c.key)}
					{@const r = data.detail?.cases[`${j.key}/${s.key}/${c.key}`]}
					<li class="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3">
						<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span class="min-w-0 flex-1 text-sm [overflow-wrap:anywhere] text-ink"
								>{c.input || 'No input'}</span
							>
							<QaStatusPill status={r ? r.outcome : 'not_tested'} />
							{#if r?.severity}<Badge tone="danger">{QA_SEVERITY_LABEL[r.severity]}</Badge>{/if}
							{#if data.canWrite && !f?.removedAt}
								<Button
									iconOnly
									size="sm"
									onclick={() => begin({ kind: 'case', j: j.key, s: s.key, c: c.key })}
									aria-label="Change what should happen"><Pencil size={14} /></Button
								>
							{/if}
						</div>
						<p class="text-sm text-muted">Should: <span class="text-ink">{c.expected}</span></p>
						{#if r}
							<p class="text-sm text-muted">
								Saw: <span class="[overflow-wrap:anywhere] text-ink"
									>{r.observed || 'nothing written down'}</span
								>
								<span class="text-xs">
									· {r.width} px, {r.mode}{r.role ? `, as ${r.role}` : ''}, {ago(r.at)}</span
								>
							</p>
							{#if r.screen}
								<ScreenViewer
									image={r.screen.image}
									alt={`What the agent saw for ${c.input || c.key}, ${r.width} pixels wide, ${r.mode} mode`}
									annotations={r.screen.annotations}
									class="max-w-[560px]"
								/>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.canWrite && !f?.removedAt}
			<div>
				<Button size="sm" onclick={() => begin({ kind: 'add-case', j: j.key, s: s.key })}
					><Plus size={14} /> Add a case</Button
				>
			</div>
		{/if}
		{#each branches(s.key) as b (b.key)}
			<!-- AN ALTERNATIVE PATH SITS UNDER THE STEP IT BRANCHES FROM -->
			<div class="ml-4 border-l-2 border-line pl-4" data-testid="qa-branch">
				{@render journeyBlock(b, true)}
			</div>
		{/each}
	</li>
{/snippet}

{#snippet journeyBlock(j: QaMap['journeys'][number], nested: boolean)}
	<section class="flex flex-col gap-2" data-testid="qa-journey">
		<div class="flex flex-wrap items-center gap-2 px-1">
			<h2 class={nested ? 'text-sm font-semibold text-ink' : 'text-base font-semibold text-ink'}>
				{nested ? `Or: ${j.name}` : j.name}
			</h2>
			{#if data.canWrite && !f?.removedAt}
				<Button size="sm" class="ml-auto" onclick={() => begin({ kind: 'add-step', j: j.key })}
					><Plus size={14} /> Add a step</Button
				>
			{/if}
		</div>
		<ol class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
			{#each j.steps.filter((s) => !s.removedAt) as s, i (s.key)}
				{@render stepBlock(j, s, i + 1)}
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
					{#if f.sizes.length}<span class="font-mono text-xs tabular-nums"
							>{f.sizes.join(' · ')}</span
						>{/if}
				</span>
			{/snippet}
			{#snippet actions()}
				<Button onclick={copyCommand}><Copy size={16} /> Copy the test command</Button>
				{#if data.canWrite && !f.removedAt}
					<Button onclick={() => begin({ kind: 'feature' })} data-testid="qa-edit-feature"
						><Pencil size={16} /> Edit</Button
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
					{#each f.conflicts.slice(-5) as c, i (i)}<li class="[overflow-wrap:anywhere]">
							{c}
						</li>{/each}
				</ul>
			</Notice>
		{/if}
		{#if f.description}<p class="text-sm [overflow-wrap:anywhere] text-muted">
				{f.description}
			</p>{/if}

		{#if main.length === 0}
			<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
				<EmptyState
					kind="items"
					title="No journeys yet"
					text="Your agent adds this feature's journeys the next time it runs /flow-qa discover."
				/>
			</div>
		{:else}
			{#each main as j (j.key)}
				{@render journeyBlock(j, false)}
			{/each}
		{/if}

		{#if f.bugs.length > 0}
			<section class="flex flex-col gap-2">
				<h2 class="px-1 text-base font-semibold text-ink">Open bugs</h2>
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each f.bugs as b (b.id)}
						<li
							class="flex min-h-14 items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
						>
							<span class="w-14 shrink-0 font-mono text-xs text-muted">{b.ref}</span>
							<a
								href={`${base}/tasks?task=${encodeURIComponent(b.id)}`}
								class="min-h-11 min-w-0 flex-1 cursor-pointer content-center text-sm font-medium text-ink hover:underline"
								><span class="line-clamp-2 [overflow-wrap:anywhere]">{b.title}</span></a
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="flex flex-col gap-2">
			<h2 class="px-1 text-base font-semibold text-ink">Runs</h2>
			{#if (data.detail?.runs.length ?? 0) === 0}
				<p class="px-1 text-sm text-muted">No run has tested this feature yet.</p>
			{:else}
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each data.detail?.runs ?? [] as r (r.ref)}
						<li
							class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0"
						>
							<a
								href={`${base}/${r.ref}`}
								class="min-h-11 min-w-0 flex-1 cursor-pointer content-center text-sm font-medium text-ink hover:underline"
								>Run {r.runNo}</a
							>
							<span class="text-xs text-muted tabular-nums"
								>{r.works} work · {r.broken} broken · {r.couldNotTest} couldn't test</span
							>
							<span class="w-24 shrink-0 text-right text-xs text-muted max-sm:hidden"
								>{ago(r.at)}</span
							>
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
