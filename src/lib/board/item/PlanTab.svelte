<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- ENVS -- //
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { tick } from 'svelte';
	// -- MODULES -- //
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import StateMark from '#lib/board/item/StateMark.svelte';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import Plus from '@lucide/svelte/icons/plus';

	// -- TYPES -- //

	type Row = {
		id: string;
		key: string;
		text: string;
		state: string;
		reason?: string | null;
		auto?: boolean;
	};

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- CONSTANTS -- //

	// The Waive link is always there for keyboards and touch. On a wide screen with a pointer it fades in on hover and focus.
	const LINK =
		'relative mt-0.5 shrink-0 cursor-pointer px-1 py-0.5 text-xs text-muted before:absolute before:-inset-x-1 before:-inset-y-2.5 hover:text-ink hover:underline max-sm:before:-inset-y-3 [@media(hover:hover)_and_(min-width:48rem)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';
	const SHOW_OPTIONS = [
		{ value: 'all', label: 'All steps' },
		{ value: 'open', label: 'Open steps' }
	];

	// -- STATES -- //

	/** The state a click asked for, shown at once while the server answers (optimistic update). */
	let pending = $state<Record<string, string>>({});
	/** The open or closed choice of each phase card, by phase id, so "Jump to next step" can open one. */
	let collapsedBy = $state<Record<string, boolean>>({});
	let waiving = $state<{ key: string; text: string } | null>(null);
	let reason = $state('');
	let reasonError = $state('');
	let addingTo = $state<string | null>(null);
	let stepText = $state('');
	let addingPhase = $state(false);
	let phaseKey = $state('');
	let phaseTitle = $state('');
	let addingCheck = $state(false);
	let checkText = $state('');
	let checkAuto = $state(false);
	let busy = $state(false);
	let formError = $state('');

	// -- REACTIVE STATES -- //

	const ref = $derived(detail.item.ref);
	const nextPhaseKey = $derived(String(detail.phases.length + 1));
	const nextCheckKey = $derived(`M${detail.manualChecks.length + 1}`);
	const show = $derived(page.url.searchParams.get('show') === 'open' ? 'open' : 'all');
	// Every state comes from stateOf, so a click shows at once: the counts, the "Up next" row and the filter all follow it
	const phases = $derived(
		detail.phases.map((ph) => {
			const rows: Row[] = ph.steps.map((s) => ({ ...s, state: stateOf(s.key, s.state) }));
			const open = rows.filter((r) => r.state === 'open');
			// The filter follows what the server says is open, so ticking a step does not pull its row away under a keyboard user's focus; the tick shows in the row itself
			const openOnServer = new Set(ph.steps.filter((s) => s.state === 'open').map((s) => s.id));
			return {
				ph,
				rows,
				done: rows.filter((r) => r.state === 'done').length,
				// A phase is finished when it has steps and none of them is open
				finished: rows.length > 0 && open.length === 0,
				shown: show === 'open' ? rows.filter((r) => openOnServer.has(r.id)) : rows
			};
		})
	);
	const shownPhases = $derived(show === 'open' ? phases.filter((p) => p.shown.length > 0) : phases);
	const next = $derived(phases.flatMap((p) => p.rows).find((r) => r.state === 'open') ?? null);
	const totalSteps = $derived(phases.reduce((n, p) => n + p.rows.length, 0));
	const doneSteps = $derived(phases.reduce((n, p) => n + p.done, 0));
	const checkRows = $derived<Row[]>(
		detail.manualChecks.map((c) => ({ ...c, state: stateOf(c.key, c.state) }))
	);

	// -- FUNCTIONS -- //

	function stateOf(key: string, state: string) {
		return pending[key] ?? state;
	}

	async function mark(key: string, to: 'done' | 'open' | 'waived', why?: string) {
		pending[key] = to;
		try {
			await toast.promise(
				api<{ statusChanges?: { to: string }[] }>(env.org, `/items/${ref}/record`, {
					body: { marks: [{ key, mark: to, ...(why ? { reason: why } : {}) }] },
					key: newKey()
				}),
				{
					loading: 'Saving the step...',
					success: (r) => {
						const moved = r.statusChanges?.at(-1);
						return moved ? `Step saved. Status moved to ${moved.to.toLowerCase()}.` : 'Step saved.';
					},
					error: (e) => (e instanceof ApiError ? e.message : 'That change was not saved.')
				}
			);
			await env.onchanged();
		} catch {
			// The promise toast already shows the failure
		} finally {
			delete pending[key];
		}
	}

	const toggle = (key: string, state: string) =>
		mark(key, stateOf(key, state) === 'done' ? 'open' : 'done');

	async function waive() {
		if (!waiving) return;
		if (reason.trim().length < 3) {
			reasonError = 'Give a short reason, at least 3 characters.';
			return;
		}
		const key = waiving.key;
		const why = reason.trim();
		waiving = null;
		reason = '';
		reasonError = '';
		await mark(key, 'waived', why);
	}

	/** Runs one write from a dialog or inline form, and keeps the form open with the server's message when it fails. */
	async function write(path: string, body: unknown, ok: string, done: () => void) {
		formError = '';
		busy = true;
		try {
			await api(env.org, path, { body, key: newKey() });
			// The refusal shows on the field, so only the success is a toast
			toast.success(ok);
			done();
			await env.onchanged();
		} catch (e) {
			formError = e instanceof ApiError ? e.message : 'That was not saved.';
		} finally {
			busy = false;
		}
	}

	/** The filter lives in the address so a link keeps it, and it replaces the entry so Back does not step through it. */
	function setShow(value: string) {
		const url = new URL(page.url.href);
		if (value === 'open') url.searchParams.set('show', 'open');
		else url.searchParams.delete('show');
		void goto(url, { replace: true, reset: false });
	}

	/** Opens the phase that holds the next open step, then scrolls to it. */
	async function jump() {
		const target = next;
		if (!target) return;
		const owner = phases.find((p) => p.rows.some((r) => r.id === target.id));
		if (owner) collapsedBy[owner.ph.id] = false;
		await tick();
		document.getElementById(`step-${target.id}`)?.scrollIntoView({
			block: 'center',
			behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
		});
	}
</script>

<!-- ONE ROW FOR A STEP AND FOR A MANUAL CHECK -->
{#snippet row(s: Row, testid: string, isNext: boolean)}
	<li
		id={testid === 'step' ? `step-${s.id}` : undefined}
		class="group flex min-h-12 scroll-mt-32 items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 max-sm:px-3.5 {isNext
			? 'bg-raised'
			: ''}"
		data-row
		data-testid={testid}
		data-state={s.state}
	>
		<StateMark
			state={s.state}
			label={`${s.key} ${s.text}`}
			disabled={!env.canWrite || s.state === 'waived' || s.state === 'superseded'}
			onclick={() => toggle(s.key, s.state)}
			class="mt-0.5"
		/>
		<span
			class="min-w-10 shrink-0 rounded-[6px] px-2 py-0.5 text-center font-mono text-xs text-muted tabular-nums {isNext
				? 'bg-surface'
				: 'bg-raised'}">{s.key}</span
		>
		<span class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span
				class="text-sm break-words {s.state === 'done' || s.state === 'superseded'
					? 'text-muted'
					: 'text-ink'} {s.state === 'done' ? 'line-through' : ''} {isNext ? 'font-medium' : ''}"
				>{s.text}</span
			>
			<!-- A WAIVED STEP SAYS WHY UNDER ITS TEXT, SO A LONG REASON DOES NOT SQUEEZE THE ROW -->
			{#if s.state === 'waived'}
				<span class="text-xs break-words text-warning">waived{s.reason ? `, ${s.reason}` : ''}</span
				>
			{/if}
		</span>
		{#if isNext}<Badge class="bg-surface ring-1 ring-line">Up next</Badge>{/if}
		{#if s.auto}<Badge tone="info">auto</Badge>{/if}
		{#if s.state === 'superseded'}
			<Badge>superseded</Badge>
		{/if}
		{#if env.canWrite && s.state === 'open'}
			<button type="button" class={LINK} onclick={() => (waiving = { key: s.key, text: s.text })}
				>Waive</button
			>
		{/if}
	</li>
{/snippet}

<div class="flex flex-col gap-6" data-testid="plan-tab">
	{#if detail.phases.length === 0}
		<EmptyState
			kind="plan"
			title="This item has no phases yet"
			text="A plan is phases with steps. Add the first phase here, or let a connected tool write it."
		>
			{#snippet action()}
				{#if env.canWrite}
					<Button
						variant="primary"
						onclick={() => {
							phaseKey = nextPhaseKey;
							addingPhase = true;
						}}>Add a phase</Button
					>
				{/if}
			{/snippet}
		</EmptyState>
	{:else}
		<!-- WHAT TO SHOW AND WHERE TO GO NEXT -->
		<div class="flex flex-wrap items-center justify-between gap-3">
			<SegmentedControl
				label="Which steps to show"
				options={SHOW_OPTIONS}
				value={show}
				onchange={setShow}
			/>
			<div class="flex flex-wrap items-center gap-3">
				<span class="text-sm text-muted tabular-nums">{doneSteps} of {totalSteps} steps done</span>
				{#if next}
					<Button size="sm" onclick={jump} data-testid="jump-next"
						><ArrowDown size={14} aria-hidden="true" /> Jump to next step</Button
					>
				{/if}
			</div>
		</div>
	{/if}

	{#if show === 'open' && phases.length > 0 && shownPhases.length === 0}
		<EmptyState
			kind="plan"
			title="All steps are done"
			text="Nothing is open in this plan. Switch to all steps to see them."
		/>
	{/if}

	{#each shownPhases as p (p.ph.id)}
		{@const ph = p.ph}
		{@const phaseRunning = detail.running.filter((r) => r.phase === ph.key)}
		<TabCard
			collapsible
			startCollapsed={p.finished}
			storageKey={`afb:collapse:${env.org}:${detail.item.id}:phase-${ph.id}`}
			bind:collapsed={() => collapsedBy[ph.id] ?? false, (v) => (collapsedBy[ph.id] = v)}
			role="region"
			aria-label={`Phase ${ph.key}`}
			data-testid="phase"
		>
			{#snippet heading()}
				<span class="text-muted">Phase {ph.key}</span>
				<span class="text-ink">{ph.title}</span>
			{/snippet}
			{#snippet meta()}
				<ProgressRing
					value={ph.steps.length ? (p.done / ph.steps.length) * 100 : 0}
					label={`Phase ${ph.key} progress`}
					size={28}
				/>
				<span class="text-sm text-muted tabular-nums">{p.done} of {ph.steps.length}</span>
				{#each phaseRunning as r (r.sessionId)}
					<RunningBadge tool={r.tool} title={r.title} phase={ph.key} />
				{/each}
			{/snippet}
			<ul>
				{#each p.shown as s (s.id)}
					{@render row(s, 'step', next?.id === s.id)}
				{/each}
				{#if ph.steps.length === 0}
					<li class="px-4 py-3 text-sm text-muted">No steps in this phase.</li>
				{/if}
			</ul>
			{#if env.canWrite}
				<div class="border-t border-line px-2 py-1.5 max-sm:px-1.5">
					{#if addingTo === ph.key}
						<form
							class="flex items-end gap-2 p-2"
							onsubmit={(e) => {
								e.preventDefault();
								void write(
									`/items/${ref}/steps`,
									{ phase: ph.key, steps: [{ text: stepText.trim() }] },
									'Step added.',
									() => {
										stepText = '';
										addingTo = null;
									}
								);
							}}
						>
							<TextField
								label="New step"
								bind:value={stepText}
								error={formError}
								class="flex-1"
								required
								data-testid="new-step-text"
							/>
							<Button type="submit" variant="primary" loading={busy}>Add</Button>
							<Button onclick={() => (addingTo = null)}>Cancel</Button>
						</form>
					{:else}
						<Button
							variant="ghost"
							size="sm"
							onclick={() => {
								addingTo = ph.key;
								formError = '';
							}}><Plus size={14} aria-hidden="true" /> Add a step</Button
						>
					{/if}
				</div>
			{/if}
		</TabCard>
	{/each}

	{#if env.canWrite && detail.phases.length > 0}
		<div>
			<Button
				size="sm"
				onclick={() => {
					phaseKey = nextPhaseKey;
					phaseTitle = '';
					formError = '';
					addingPhase = true;
				}}><Plus size={14} aria-hidden="true" /> Add a phase</Button
			>
		</div>
	{/if}

	<TabCard
		collapsible
		storageKey={`afb:collapse:${env.org}:${detail.item.id}:manual-checks`}
		role="region"
		aria-label="Manual checks"
	>
		{#snippet heading()}Manual checks{/snippet}
		{#snippet meta()}
			<span class="text-sm text-muted tabular-nums">{checkRows.length}</span>
		{/snippet}
		<p class="border-b border-line px-4 py-2 text-xs text-muted max-sm:px-3.5">
			Checks a person or a tool does. They are not part of the percent.
		</p>
		<ul>
			{#each checkRows as c (c.id)}
				{@render row(c, 'manual-check', false)}
			{:else}
				<li class="px-4 py-3 text-sm text-muted">No manual checks.</li>
			{/each}
		</ul>
		{#if env.canWrite}
			<div class="border-t border-line px-2 py-1.5 max-sm:px-1.5">
				<Button
					variant="ghost"
					size="sm"
					onclick={() => {
						addingCheck = true;
						formError = '';
					}}><Plus size={14} aria-hidden="true" /> Add a manual check</Button
				>
			</div>
		{/if}
	</TabCard>
</div>

<ResponsiveModal
	open={waiving !== null}
	onclose={() => (waiving = null)}
	title="Waive this step"
	size="sm"
>
	<form
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void waive();
		}}
	>
		<p class="text-sm text-muted">{waiving?.key} {waiving?.text}</p>
		<TextField
			label="Why is it waived"
			bind:value={reason}
			error={reasonError}
			hint="A waived step is not counted, so the reason stays on record."
			data-testid="waive-reason"
		/>
		<div class="flex justify-end gap-2">
			<Button onclick={() => (waiving = null)}>Cancel</Button>
			<Button type="submit" variant="primary" data-testid="waive-submit">Waive</Button>
		</div>
	</form>
</ResponsiveModal>

<ResponsiveModal
	open={addingPhase}
	onclose={() => (addingPhase = false)}
	title="Add a phase"
	size="sm"
	{busy}
>
	<form
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void write(
				`/items/${ref}/phases`,
				{ key: phaseKey.trim(), title: phaseTitle.trim() },
				'Phase added.',
				() => (addingPhase = false)
			);
		}}
	>
		<TextField label="Phase number" bind:value={phaseKey} required />
		<TextField label="Phase title" bind:value={phaseTitle} error={formError} required />
		<div class="flex justify-end gap-2">
			<Button onclick={() => (addingPhase = false)} disabled={busy}>Cancel</Button>
			<Button type="submit" variant="primary" loading={busy}>Add phase</Button>
		</div>
	</form>
</ResponsiveModal>

<ResponsiveModal
	open={addingCheck}
	onclose={() => (addingCheck = false)}
	title="Add a manual check"
	size="sm"
	{busy}
>
	<form
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void write(
				`/items/${ref}/checks`,
				{ checks: [{ key: nextCheckKey, text: checkText.trim(), auto: checkAuto }] },
				'Check added.',
				() => {
					addingCheck = false;
					checkText = '';
				}
			);
		}}
	>
		<TextField label="What is checked" bind:value={checkText} error={formError} required />
		<Checkbox label="A tool can run this check" bind:checked={checkAuto} />
		<div class="flex justify-end gap-2">
			<Button onclick={() => (addingCheck = false)} disabled={busy}>Cancel</Button>
			<Button type="submit" variant="primary" loading={busy}>Add check</Button>
		</div>
	</form>
</ResponsiveModal>
