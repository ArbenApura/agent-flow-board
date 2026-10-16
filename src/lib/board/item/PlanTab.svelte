<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import Plus from '@lucide/svelte/icons/plus';

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- CONSTANTS -- //

	// A 44 px touch target around the 20 px box, without growing the row
	const BOX =
		'relative mt-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-[1.5px] border-muted bg-surface before:absolute before:-inset-3 aria-checked:border-accent aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-60';
	const LINK =
		'min-h-9 cursor-pointer px-1 text-xs text-muted hover:text-ink hover:underline max-sm:min-h-11';

	// -- STATES -- //

	/** The state a click asked for, shown at once while the server answers (optimistic update). */
	let pending = $state<Record<string, string>>({});
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

	// -- FUNCTIONS -- //

	const stateOf = (key: string, state: string) => pending[key] ?? state;

	async function mark(key: string, to: 'done' | 'open' | 'waived', why?: string) {
		pending[key] = to;
		try {
			const r = await api<{ statusChanges?: { to: string }[] }>(env.org, `/items/${ref}/record`, {
				body: { marks: [{ key, mark: to, ...(why ? { reason: why } : {}) }] },
				key: newKey()
			});
			const moved = r.statusChanges?.at(-1);
			if (moved) toast.info(`Status moved to ${moved.to.toLowerCase()}.`);
			await env.onchanged();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'That change was not saved.');
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
	async function write(path: string, body: unknown, done: () => void) {
		formError = '';
		busy = true;
		try {
			await api(env.org, path, { body, key: newKey() });
			done();
			await env.onchanged();
		} catch (e) {
			formError = e instanceof ApiError ? e.message : 'That was not saved.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-6" data-testid="plan-tab">
	{#if detail.phases.length === 0}
		<EmptyState
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
	{/if}

	{#each detail.phases as ph (ph.id)}
		{@const done = ph.steps.filter((s) => stateOf(s.key, s.state) === 'done').length}
		{@const phaseRunning = detail.running.filter((r) => r.phase === ph.key)}
		<section class="flex flex-col gap-1" aria-label={`Phase ${ph.key}`} data-testid="phase">
			<h2 class="flex flex-wrap items-center gap-2 text-lg font-semibold">
				Phase {ph.key} <span class="text-ink">{ph.title}</span>
				<ProgressRing
					value={ph.steps.length ? (done / ph.steps.length) * 100 : 0}
					label={`Phase ${ph.key} progress`}
					size={28}
				/>
				<span class="text-sm font-normal text-muted tabular-nums">{done} of {ph.steps.length}</span>
				{#each phaseRunning as r (r.sessionId)}
					<RunningBadge tool={r.tool} title={r.title} phase={ph.key} />
				{/each}
			</h2>
			<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
				{#each ph.steps as s (s.id)}
					{@const st = stateOf(s.key, s.state)}
					<li
						class="flex min-h-12 items-start gap-4 border-b border-line px-4 py-3 last:border-b-0"
						data-row
						data-testid="step"
						data-state={st}
					>
						<button
							type="button"
							role="checkbox"
							aria-checked={st === 'done'}
							aria-label={`${s.key} ${s.text}`}
							disabled={!env.canWrite || st === 'waived' || st === 'superseded'}
							onclick={() => toggle(s.key, s.state)}
							class={BOX}
						>
							{#if st === 'done'}<Check size={14} strokeWidth={3} class="text-accent-ink" />{/if}
						</button>
						<span class="w-10 shrink-0 pt-0.5 font-mono text-xs text-muted">{s.key}</span>
						<span
							class="min-w-0 flex-1 text-sm {st === 'done'
								? 'text-muted line-through'
								: 'text-ink'}">{s.text}</span
						>
						{#if st === 'waived'}
							<Badge tone="warning">waived{s.reason ? `, ${s.reason}` : ''}</Badge>
						{:else if st === 'superseded'}
							<Badge>superseded</Badge>
						{:else if env.canWrite && st === 'open'}
							<button
								type="button"
								class={LINK}
								onclick={() => (waiving = { key: s.key, text: s.text })}>Waive</button
							>
						{/if}
					</li>
				{/each}
				{#if ph.steps.length === 0}
					<li class="px-3 py-3 text-sm text-muted">No steps in this phase.</li>
				{/if}
			</ul>
			{#if env.canWrite}
				{#if addingTo === ph.key}
					<form
						class="mt-1 flex items-end gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							void write(
								`/items/${ref}/steps`,
								{ phase: ph.key, steps: [{ text: stepText.trim() }] },
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
					<div>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => {
								addingTo = ph.key;
								formError = '';
							}}><Plus size={14} /> Add a step</Button
						>
					</div>
				{/if}
			{/if}
		</section>
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
				}}><Plus size={14} /> Add a phase</Button
			>
		</div>
	{/if}

	<section class="flex flex-col gap-1" aria-label="Manual checks">
		<h2 class="text-lg font-semibold">Manual checks</h2>
		<div class="text-xs text-muted">
			Checks a person or a tool does. They are not part of the percent.
		</div>
		<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
			{#each detail.manualChecks as c (c.id)}
				{@const st = stateOf(c.key, c.state)}
				<li
					class="flex min-h-12 items-start gap-4 border-b border-line px-4 py-3 last:border-b-0"
					data-row
					data-testid="manual-check"
					data-state={st}
				>
					<button
						type="button"
						role="checkbox"
						aria-checked={st === 'done'}
						aria-label={`${c.key} ${c.text}`}
						disabled={!env.canWrite || st === 'waived' || st === 'superseded'}
						onclick={() => toggle(c.key, c.state)}
						class={BOX}
					>
						{#if st === 'done'}<Check size={14} strokeWidth={3} class="text-accent-ink" />{/if}
					</button>
					<span class="w-10 shrink-0 pt-0.5 font-mono text-xs text-muted">{c.key}</span>
					<span class="min-w-0 flex-1 text-sm text-ink">{c.text}</span>
					{#if c.auto}<Badge tone="info">auto</Badge>{/if}
					{#if st === 'waived'}
						<Badge tone="warning">waived{c.reason ? `, ${c.reason}` : ''}</Badge>
					{/if}
					{#if env.canWrite && st === 'open'}
						<button
							type="button"
							class={LINK}
							onclick={() => (waiving = { key: c.key, text: c.text })}>Waive</button
						>
					{/if}
				</li>
			{:else}
				<li class="px-3 py-3 text-sm text-muted">No manual checks.</li>
			{/each}
		</ul>
		{#if env.canWrite}
			<div>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => {
						addingCheck = true;
						formError = '';
					}}><Plus size={14} /> Add a manual check</Button
				>
			</div>
		{/if}
	</section>
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
