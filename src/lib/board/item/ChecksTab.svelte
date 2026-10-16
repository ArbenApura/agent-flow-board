<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { itemChecks } from '#lib/server/ops/checks.js';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
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
	const TARGET_OPTIONS = [
		{ value: '', label: 'Choose for me', hint: 'The check, your preference, then the project' },
		{ value: 'preview', label: 'Build preview' },
		{ value: 'dev', label: 'Dev server' },
		{ value: 'deployed', label: 'Deployed site' }
	];
	const REQUIRED_OPTIONS = TARGET_OPTIONS.slice(1);
	const PIN_OPTIONS = [{ value: '', label: 'No pin' }, ...REQUIRED_OPTIONS];

	// -- STATES -- //

	let view = $state<View | null>(null);
	let failed = $state(false);
	let target = $state<Record<string, string>>({});
	let stepFor = $state<Record<string, string>>({});
	let editing = $state<string | null>(null);
	let script = $state('');
	let paths = $state('');
	let required = $state('preview');
	let pinned = $state('');
	let busy = $state('');
	let notice = $state<Record<string, { text: string; offer: string[] }>>({});

	// -- REACTIVE STATES -- //

	const autoChecks = $derived(detail.manualChecks.filter((c) => c.auto));
	const openSteps = $derived(
		detail.phases.flatMap((p) => p.steps).filter((s) => s.state === 'open')
	);
	const stepOptions = $derived([
		{ value: '', label: 'None' },
		...openSteps.map((s) => ({ value: s.key, label: `${s.key} ${s.text.slice(0, 48)}` }))
	]);
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
		required = c?.requiredTarget ?? 'preview';
		pinned = c?.pinnedTarget ?? '';
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
						requiredTarget: required,
						pinnedTarget: pinned || null,
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

	async function run(key: string, chosen?: string) {
		busy = `run-${key}`;
		try {
			const asked = await toast.promise(
				api<{
					unavailable: boolean;
					offer: string[];
					run: { reason: string | null };
				}>(env.org, `/items/${detail.item.ref}/browser-checks/runs`, {
					body: {
						key,
						target: (chosen ?? target[key]) || undefined,
						step: stepFor[key] || undefined
					}
				}),
				{
					loading: 'Asking for a run...',
					success: (r) => (r.unavailable ? 'That target is not available.' : 'Run requested.'),
					error: (e) => (e instanceof ApiError ? e.message : 'The run was not asked for.')
				}
			);
			notice[key] = asked.unavailable
				? { text: asked.run.reason ?? 'That target is not available.', offer: asked.offer }
				: { text: '', offer: [] };
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

<div class="flex flex-col gap-4" data-testid="checks-tab">
	{#if failed && !view}
		<ErrorState message="The browser checks did not load." onretry={load} />
	{:else if !view}
		<Skeleton lines={4} />
	{:else}
		<section
			class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
			data-card
			aria-labelledby="targets-title"
		>
			<div>
				<h2 id="targets-title" class="text-lg font-semibold">Where checks can run</h2>
				<p class="text-sm text-muted">
					The build preview is the usual choice. A target is ready when the project has an
					environment for it and a runner that can reach it is online.
				</p>
			</div>
			<ul class="flex flex-col" data-testid="targets">
				{#each view.targets as t (t.target)}
					<li
						class="flex min-h-11 flex-wrap items-center gap-2 border-b border-line py-2 last:border-b-0"
						data-item
						data-testid={`target-${t.target}`}
					>
						<span class="w-32 text-sm font-medium">{TARGET_LABEL[t.target]}</span>
						<Badge tone={t.available ? 'success' : 'warning'}>
							{t.available ? 'Ready' : 'Not ready'}
						</Badge>
						{#if t.reason}<span class="min-w-0 flex-1 text-xs text-muted">{t.reason}</span>{/if}
					</li>
				{/each}
			</ul>
		</section>

		{#if autoChecks.length === 0}
			<EmptyState
				title="No automatic checks on this item"
				text="A manual check marked [auto] can have a browser check. Add one to the plan first, then write its script here."
			/>
		{/if}

		{#each autoChecks as mc (mc.id)}
			{@const c = checkOf(mc.key)}
			<section
				class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
				data-card
				data-testid={`check-${mc.key}`}
				aria-labelledby={`check-${mc.key}-title`}
			>
				<div class="flex flex-wrap items-start gap-2">
					<div class="min-w-0 flex-1">
						<h2 id={`check-${mc.key}-title`} class="text-lg font-semibold">
							{mc.key}
							{mc.text}
						</h2>
						<p class="text-sm text-muted">
							{#if c}
								Counts when it passes on the {TARGET_LABEL[c.requiredTarget]}
								{#if c.pinnedTarget}, always run on the {TARGET_LABEL[c.pinnedTarget]}{/if}.
							{:else}
								No browser check is saved for this yet.
							{/if}
						</p>
					</div>
					<Badge tone={mc.state === 'open' ? 'neutral' : 'success'}>
						{mc.state === 'open' ? 'Open' : mc.state === 'waived' ? 'Closed by a pass' : mc.state}
					</Badge>
				</div>

				{#if c && env.canWrite && view.canRun}
					<div class="flex flex-wrap items-end gap-2" data-testid={`run-controls-${mc.key}`}>
						<Select
							label="Target"
							options={TARGET_OPTIONS}
							value={target[mc.key] ?? ''}
							onchange={(v) => (target[mc.key] = v)}
							class="w-48"
						/>
						<Select
							label="Step to close when it passes"
							options={stepOptions}
							value={stepFor[mc.key] ?? ''}
							onchange={(v) => (stepFor[mc.key] = v)}
							class="w-56"
						/>
						<Button
							variant="primary"
							loading={busy === `run-${mc.key}`}
							onclick={() => run(mc.key)}
							data-testid={`run-${mc.key}`}
						>
							Run check
						</Button>
					</div>
					{#if notice[mc.key]?.text}
						<div
							class="flex flex-col gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning"
							role="status"
							data-testid={`unavailable-${mc.key}`}
						>
							<span>{notice[mc.key].text}</span>
							<span class="flex flex-wrap gap-2">
								{#each notice[mc.key].offer as t (t)}
									<Button size="sm" onclick={() => run(mc.key, t)}>
										Run on the {TARGET_LABEL[t]}
									</Button>
								{/each}
							</span>
						</div>
					{/if}
				{/if}

				{#if c && c.runs.length > 0}
					<ul class="rounded-lg border border-line" data-testid={`runs-${mc.key}`}>
						{#each c.runs as r (r.id)}
							<li
								class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
								data-item
								data-testid="check-run"
							>
								<Badge tone={RESULT[r.result]?.tone ?? 'neutral'}>
									{RESULT[r.result]?.label ?? r.result}
								</Badge>
								{#if r.flaky}<Badge tone="warning">Flaky</Badge>{/if}
								<span class="text-sm">{TARGET_LABEL[r.target] ?? r.target}</span>
								<span class="text-xs text-muted">
									{ago(r.createdAt)}{r.durationMs ? `, ${secs(r.durationMs)}` : ''}{r.commit
										? `, ${r.commit.slice(0, 7)}`
										: ''}{r.stepKey ? `, for step ${r.stepKey}` : ''}
								</span>
								<span class="flex-1"></span>
								{#each r.evidence.slice(0, 3) as id, i (id)}
									<Button size="sm" variant="ghost" onclick={() => open(id)}
										>Evidence {i + 1}</Button
									>
								{/each}
								{#if r.reason}
									<span class="w-full text-xs text-muted">{r.reason}</span>
								{/if}
							</li>
						{/each}
					</ul>
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
							<div class="flex flex-wrap gap-2">
								<Select
									label="Counts on"
									options={REQUIRED_OPTIONS}
									bind:value={required}
									class="w-48"
								/>
								<Select
									label="Always run on"
									options={PIN_OPTIONS}
									bind:value={pinned}
									class="w-48"
								/>
							</div>
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
									loading={busy === `remove-${mc.key}`}
									onclick={() => removeCheck(mc.key)}
								>
									Remove the check
								</Button>
							{/if}
						</div>
					{/if}
				{/if}
			</section>
		{/each}
	{/if}
</div>
