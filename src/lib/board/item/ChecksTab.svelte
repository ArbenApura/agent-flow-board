<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { itemChecks } from '#lib/server/ops/checks.js';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import {
		checkStatus,
		closedStep,
		failureSentence,
		resultStatus,
		seconds
	} from '#lib/shared/checksTab.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- COMPONENTS -- //
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';

	// -- TYPES -- //

	type View = Awaited<ReturnType<typeof itemChecks>>;

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- STATES -- //

	let view = $state<View | null>(null);
	let failed = $state(false);
	let busy = $state('');
	let notice = $state<Record<string, string>>({});

	// -- REACTIVE STATES -- //

	// Only checks the agent wrote a browser script for are listed
	const autoChecks = $derived(detail.manualChecks.filter((c) => c.auto));
	const runner = $derived(view?.targets.find((t) => t.target === 'preview'));
	const waiting = $derived(
		view?.checks.some((c) => c.runs.some((r) => r.result === 'queued' || r.result === 'running')) ??
			false
	);

	// -- REACTIVE STATEMENTS -- //

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

	// -- FUNCTIONS -- //

	async function load() {
		try {
			view = await api<View>(env.org, `/items/${detail.item.ref}/browser-checks`);
			failed = false;
			// A "could not run" notice is true only until a newer run exists
			for (const key of Object.keys(notice)) {
				const latest = view.checks.find((c) => c.key === key)?.runs[0];
				if (latest && latest.result !== 'unavailable' && latest.result !== 'timeout')
					notice[key] = '';
			}
		} catch {
			failed = true;
		}
	}

	const checkOf = (key: string) => view?.checks.find((c) => c.key === key);

	/** Asks for a run. It names no plan step: a pass closes this check and nothing else, and the card changes by itself to say it is waiting. */
	async function run(key: string) {
		busy = key;
		try {
			const asked = await api<{ unavailable: boolean; run: { reason: string | null } }>(
				env.org,
				`/items/${detail.item.ref}/browser-checks/runs`,
				{ body: { key } }
			);
			notice[key] = asked.unavailable ? (asked.run.reason ?? 'The check cannot run yet.') : '';
			await load();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The run was not asked for. Try again.');
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
</script>

<div class="flex flex-col gap-6" data-testid="checks-tab">
	{#if failed && !view}
		<ErrorState message="The browser checks did not load." onretry={load} />
	{:else if !view}
		<Skeleton lines={4} />
	{:else}
		<!-- THE RUNNER SHOWS ONLY WHEN IT NEEDS ATTENTION -->
		{#if !runner?.available}
			<Notice tone="warning" data-testid="runner-status">
				The check runner is not connected. Your agent connects it by itself the next time a check
				needs to run, so there is nothing to do here.
			</Notice>
		{/if}

		{#if autoChecks.length === 0}
			<EmptyState
				kind="checks"
				title="No browser checks on this item yet"
				text="Your agent adds a check when it needs to prove something on a screen. It appears here with its result."
			/>
		{/if}

		{#each autoChecks as mc (mc.id)}
			{@const c = checkOf(mc.key)}
			{@const latest = c?.runs[0]}
			{@const status = checkStatus(mc.state, c?.runs ?? [])}
			{@const problem = latest ? failureSentence(latest) : null}
			<TabCard role="region" aria-label={`${mc.key} ${mc.text}`} data-testid={`check-${mc.key}`}>
				{#snippet heading()}
					<span class="rounded-[6px] bg-raised px-2 py-0.5 font-mono text-xs font-medium text-muted"
						>{mc.key}</span
					>
					<span class="min-w-0 break-words">{mc.text}</span>
				{/snippet}
				{#snippet actions()}
					<Badge tone={status.tone}>{status.label}</Badge>
				{/snippet}
				<div class="flex flex-col gap-3 p-4 max-sm:p-3.5">
					{#if !c}
						<p class="text-sm text-muted">
							No browser check has been written for this yet. Your agent writes it when it needs to
							prove this.
						</p>
					{:else}
						<!-- THE NEWEST RUN ON ONE LINE -->
						{#if latest}
							{@const r = resultStatus(latest.result)}
							<div
								class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
								data-testid="check-run"
							>
								<Badge tone={r.tone}>{r.label}</Badge>
								<span class="text-xs text-muted">
									{ago(latest.createdAt)}{seconds(latest.durationMs)
										? `, ${seconds(latest.durationMs)}`
										: ''}
								</span>
								{#if closedStep(latest)}<span class="text-xs text-muted">{closedStep(latest)}</span
									>{/if}
								{#if latest.ran}
									<span class="text-xs text-muted">
										on {latest.ran.repo ?? latest.ran.registration}{latest.ran.branch
											? ` (${latest.ran.branch})`
											: ''}
									</span>
								{/if}
								{#each latest.evidence.slice(0, 3) as id, i (id)}
									<Button size="sm" variant="ghost" onclick={() => open(id)}
										>Screenshot {i + 1}</Button
									>
								{/each}
							</div>
							{#if problem}<p class="text-sm text-danger" role="status">{problem}</p>{/if}
						{:else}
							<p class="text-sm text-muted">It has not run yet.</p>
						{/if}

						{#if env.canWrite && view.canRun}
							<div class="flex flex-wrap items-center gap-2" data-testid={`run-controls-${mc.key}`}>
								<Button
									loading={busy === mc.key}
									onclick={() => run(mc.key)}
									data-testid={`run-${mc.key}`}
								>
									Run check
								</Button>
							</div>
							{#if notice[mc.key]}
								<p class="text-sm text-warning" role="status" data-testid={`unavailable-${mc.key}`}>
									{notice[mc.key]}
								</p>
							{/if}
						{/if}

						<!-- EARLIER RUNS AND THE SCRIPT, BOTH FOLDED AWAY UNTIL SOMEONE WANTS THEM -->
						{#if c.runs.length > 1}
							<details class="group text-sm">
								<summary class="cursor-pointer text-muted hover:text-ink">
									Earlier runs ({c.runs.length - 1})
								</summary>
								<ul class="mt-2 flex flex-col gap-1">
									{#each c.runs.slice(1) as r (r.id)}
										{@const rs = resultStatus(r.result)}
										<li
											class="flex flex-wrap items-center gap-x-3 gap-y-1"
											data-testid="check-earlier-run"
										>
											<Badge tone={rs.tone}>{rs.label}</Badge>
											<span class="text-xs text-muted">
												{ago(r.createdAt)}{seconds(r.durationMs)
													? `, ${seconds(r.durationMs)}`
													: ''}
											</span>
										</li>
									{/each}
								</ul>
							</details>
						{/if}
						<details class="text-sm">
							<summary class="cursor-pointer text-muted hover:text-ink">View the script</summary>
							<pre
								class="mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs whitespace-pre-wrap"
								data-testid={`script-${mc.key}`}>{c.script}</pre>
						</details>
					{/if}
				</div>
			</TabCard>
		{/each}
	{/if}
</div>
