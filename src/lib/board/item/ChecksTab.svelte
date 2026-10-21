<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { itemChecks } from '#lib/server/ops/checks.js';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';

	// -- TYPES -- //

	type View = Awaited<ReturnType<typeof itemChecks>>;
	type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'running';

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- CONSTANTS -- //

	const TARGET_LABEL: Record<string, string> = {
		dev: 'Dev server',
		preview: 'Build preview',
		deployed: 'Deployed site'
	};
	const RESULT: Record<string, { label: string; tone: Tone }> = {
		pass: { label: 'Passed', tone: 'success' },
		fail: { label: 'Failed', tone: 'danger' },
		error: { label: 'Could not run', tone: 'danger' },
		timeout: { label: 'Stuck', tone: 'warning' },
		unavailable: { label: 'Not available', tone: 'warning' },
		queued: { label: 'Waiting for a runner', tone: 'info' },
		running: { label: 'Running', tone: 'running' }
	};

	// -- STATES -- //

	let view = $state<View | null>(null);
	let failed = $state(false);
	let stepFor = $state<Record<string, string>>({});
	let editing = $state<string | null>(null);
	let script = $state('');
	let paths = $state('');
	let busy = $state('');
	let notice = $state<Record<string, string>>({});

	// -- REACTIVE STATES -- //

	const autoChecks = $derived(detail.manualChecks.filter((c) => c.auto));
	const openSteps = $derived(
		detail.phases.flatMap((p) => p.steps).filter((s) => s.state === 'open')
	);
	const stepOptions = $derived([
		{ value: '', label: 'None' },
		...openSteps.map((s) => ({ value: s.key, label: `${s.key} ${s.text.slice(0, 48)}` }))
	]);
	const runner = $derived(view?.targets.find((t) => t.target === 'preview'));
	const waiting = $derived(
		view?.checks.some((c) => c.runs.some((r) => r.result === 'queued' || r.result === 'running')) ??
			false
	);

	// -- FUNCTIONS -- //

	async function load() {
		try {
			view = await api<View>(env.org, `/items/${detail.item.ref}/browser-checks`);
			failed = false;
		} catch {
			failed = true;
		}
	}

	$effect(() => {
		void detail.item.ref;
		void load();
	});

	// A run in progress is looked at again every few seconds, and nothing is asked while nothing is waiting
	$effect(() => {
		if (!waiting) return;
		const t = setInterval(() => void load(), 3000);
		return () => clearInterval(t);
	});

	const checkOf = (key: string) => view?.checks.find((c) => c.key === key);

	function edit(key: string) {
		const c = checkOf(key);
		editing = key;
		script = c ? '' : 'await page.goto("/");\nawait expect(page.locator("h1")).toBeVisible();\n';
		paths = c?.coveredPaths.join('\n') ?? '';
		if (c) script = c.script ?? '';
	}

	async function saveCheck(key: string) {
		busy = `save-${key}`;
		try {
			await toast.promise(
				api(env.org, `/items/${detail.item.ref}/browser-checks`, {
					method: 'PUT',
					body: {
						key,
						script,
						// Checks run on the build preview only; an older check keeps the target it was saved with
						requiredTarget: checkOf(key)?.requiredTarget ?? 'preview',
						pinnedTarget: checkOf(key)?.pinnedTarget ?? null,
						coveredPaths: paths
							.split('\n')
							.map((p) => p.trim())
							.filter(Boolean)
					}
				}),
				{
					loading: 'Saving the check...',
					success: 'Browser check saved.',
					error: (e) => (e instanceof ApiError ? e.message : 'The check was not saved.')
				}
			);
			editing = null;
			await load();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = '';
		}
	}

	async function removeCheck(key: string) {
		if (
			!(await askConfirm({
				title: 'Remove this browser check?',
				body: 'Its script and its run history are deleted.',
				confirmLabel: 'Remove the check'
			}))
		)
			return;
		busy = `remove-${key}`;
		try {
			await toast.promise(
				api(env.org, `/items/${detail.item.ref}/browser-checks/${key}`, { method: 'DELETE' }),
				{
					loading: 'Removing the check...',
					success: 'Browser check removed.',
					error: (e) => (e instanceof ApiError ? e.message : 'The check was not removed.')
				}
			);
			await load();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = '';
		}
	}

	async function run(key: string) {
		busy = `run-${key}`;
		try {
			const asked = await toast.promise(
				api<{
					unavailable: boolean;
					run: { reason: string | null };
				}>(env.org, `/items/${detail.item.ref}/browser-checks/runs`, {
					body: { key, step: stepFor[key] || undefined }
				}),
				{
					loading: 'Asking for a run...',
					success: (r) => (r.unavailable ? 'The check cannot run yet.' : 'Run requested.'),
					error: (e) => (e instanceof ApiError ? e.message : 'The run was not asked for.')
				}
			);
			notice[key] = asked.unavailable ? (asked.run.reason ?? 'The check cannot run yet.') : '';
			await load();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = '';
		}
	}

	async function open(id: string) {
		try {
			const link = await api<{ url: string }>(env.org, `/attachments/${id}/link`);
			window.open(link.url, '_blank', 'noopener');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The link could not be made.');
		}
	}

	const secs = (ms: number | null) => (ms == null ? '' : `${(ms / 1000).toFixed(1)} s`);
</script>

<div class="flex flex-col gap-6" data-testid="checks-tab">
	{#if failed && !view}
		<ErrorState message="The browser checks did not load." onretry={load} />
	{:else if !view}
		<Skeleton lines={4} />
	{:else}
		<!-- CHECK RUNNER STATUS -->
		<TabCard role="region" aria-label="Check runner" data-testid="runner-status">
			{#snippet heading()}Check runner{/snippet}
			{#snippet meta()}
				<Badge tone={runner?.available ? 'success' : 'warning'} dot>
					{runner?.available ? 'Ready' : 'Not connected'}
				</Badge>
			{/snippet}
			<p class="px-4 py-2 text-sm text-muted max-sm:px-3.5">
				{runner?.available
					? 'Checks run on a build preview of the project, on this computer.'
					: 'Your agent connects the check runner by itself the next time a check needs to run. Nothing to do here.'}
			</p>
		</TabCard>

		{#if autoChecks.length === 0}
			<EmptyState
				kind="checks"
				title="No automatic checks on this item"
				text="A manual check marked [auto] can have a browser check. Add one to the plan first, then write its script here."
			/>
		{/if}

		{#each autoChecks as mc (mc.id)}
			{@const c = checkOf(mc.key)}
			<TabCard
				collapsible
				storageKey={`afb:collapse:${env.org}:${detail.item.id}:check-${mc.key}`}
				role="region"
				aria-label={`${mc.key} ${mc.text}`}
				data-testid={`check-${mc.key}`}
			>
				{#snippet heading()}
					<span class="rounded-[6px] bg-raised px-2 py-0.5 font-mono text-xs font-medium text-muted"
						>{mc.key}</span
					>
					<span class="min-w-0 break-words">{mc.text}</span>
				{/snippet}
				{#snippet actions()}
					<Badge tone={mc.state === 'open' ? 'neutral' : 'success'}>
						{mc.state === 'open' ? 'Open' : mc.state === 'waived' ? 'Closed by a pass' : mc.state}
					</Badge>
				{/snippet}
				<div class="flex flex-col gap-4 p-4 max-sm:p-3.5">
					<p class="text-sm text-muted">
						{#if c}
							Counts when it passes on a build preview.
						{:else}
							No browser check is saved for this yet.
						{/if}
					</p>

					{#if c && env.canWrite && view.canRun}
						<div class="flex flex-wrap items-end gap-2" data-testid={`run-controls-${mc.key}`}>
							<Select
								label="Step to close when it passes"
								options={stepOptions}
								value={stepFor[mc.key] ?? ''}
								onchange={(v) => (stepFor[mc.key] = v)}
								class="w-56"
							/>
							<Button
								loading={busy === `run-${mc.key}`}
								onclick={() => run(mc.key)}
								data-testid={`run-${mc.key}`}
							>
								Run check
							</Button>
						</div>
						{#if notice[mc.key]}
							<div
								class="flex flex-col gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning"
								role="status"
								data-testid={`unavailable-${mc.key}`}
							>
								<span>{notice[mc.key]}</span>
							</div>
						{/if}
					{/if}

					<!-- THE RUN HISTORY: ONE ROW PER RUN, COLUMNS ON A WIDE SCREEN AND STACKED ON A PHONE -->
					{#if c && c.runs.length > 0}
						<div
							class="overflow-hidden rounded-lg border border-line"
							data-testid={`runs-${mc.key}`}
						>
							<div
								class="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_72px_72px_minmax(0,1.6fr)] items-center gap-3 border-b border-line bg-raised px-3 py-2 text-xs font-medium text-muted sm:grid"
								aria-hidden="true"
							>
								<span>Result</span>
								<span>Where</span>
								<span>When</span>
								<span>Took</span>
								<span>Commit</span>
								<span>Evidence</span>
							</div>
							<ul>
								{#each c.runs as r (r.id)}
									<li
										class="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0 sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_72px_72px_minmax(0,1.6fr)] sm:items-center sm:gap-3"
										data-item
										data-testid="check-run"
									>
										<span class="flex flex-wrap items-center gap-1.5">
											<Badge tone={RESULT[r.result]?.tone ?? 'neutral'}>
												{RESULT[r.result]?.label ?? r.result}
											</Badge>
											{#if r.flaky}<Badge tone="warning">Flaky</Badge>{/if}
										</span>
										<span class="text-sm">{TARGET_LABEL[r.target] ?? r.target}</span>
										<span class="text-xs text-muted">
											{ago(r.createdAt)}{r.stepKey ? `, for step ${r.stepKey}` : ''}
										</span>
										<span class="text-xs text-muted tabular-nums">{secs(r.durationMs)}</span>
										<span class="font-mono text-xs text-muted"
											>{r.commit ? r.commit.slice(0, 7) : ''}</span
										>
										<span class="flex flex-wrap gap-1">
											{#each r.evidence.slice(0, 3) as id, i (id)}
												<Button size="sm" variant="ghost" onclick={() => open(id)}
													>Evidence {i + 1}</Button
												>
											{/each}
										</span>
										{#if r.reason}
											<span class="text-xs break-words text-muted sm:col-span-6">{r.reason}</span>
										{/if}
									</li>
								{/each}
							</ul>
						</div>
					{:else if c}
						<div class="text-sm text-muted">It has not run yet.</div>
					{/if}

					{#if env.canWrite}
						{#if editing === mc.key}
							<div class="flex flex-col gap-3 rounded-lg border border-line p-3">
								<TextArea
									label="Script"
									bind:value={script}
									rows={9}
									class="font-mono"
									spellcheck="false"
									hint="Runs in a signed-in browser. You have page, context, expect, baseUrl and log. You never see a password."
								/>
								<TextArea
									label="Code this check covers (one path per line)"
									bind:value={paths}
									rows={3}
									hint="A change under these paths means the check should run again."
								/>
								<div class="flex gap-2">
									<Button
										variant="primary"
										loading={busy === `save-${mc.key}`}
										onclick={() => saveCheck(mc.key)}
									>
										Save check
									</Button>
									<Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
								</div>
							</div>
						{:else}
							<div class="flex flex-wrap gap-2">
								<Button size="sm" onclick={() => edit(mc.key)} data-testid={`edit-${mc.key}`}>
									{c ? 'Edit the check' : 'Add a check'}
								</Button>
								{#if c}
									<Button
										size="sm"
										variant="ghost"
										tone="danger"
										loading={busy === `remove-${mc.key}`}
										onclick={() => removeCheck(mc.key)}
									>
										Remove the check
									</Button>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			</TabCard>
		{/each}
	{/if}
</div>
