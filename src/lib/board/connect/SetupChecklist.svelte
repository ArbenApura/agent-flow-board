<script lang="ts">
	// IMPORTED TYPES
	import type { Marks, SetupInput, TileStatus } from '#lib/connect/setupChecklist.js';
	// IMPORTED DEP-MODULES
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	// IMPORTED MODULES
	import { connectHref } from '#lib/connect/hrefs.js';
	import { setupProgress, setupTiles } from '#lib/connect/setupChecklist.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Clock from '@lucide/svelte/icons/clock';
	import Minus from '@lucide/svelte/icons/minus';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';

	// -- REQUIRED PROPS -- //

	let {
		input,
		panel,
		orgSlug
	}: {
		/** What the board knows about the person's own setup. The marks in it are the ones saved on the server. */
		input: SetupInput;
		/** Whether the person folded or opened the checklist, or null when they never chose. */
		panel: 'open' | 'closed' | null;
		orgSlug: string;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const bodyId = `${uid}-body`;
	const MARK: Record<TileStatus, string> = {
		done: 'bg-success-soft text-success',
		attention: 'bg-warning-soft text-warning',
		skipped: 'border border-dashed border-line bg-raised text-muted',
		todo: 'bg-raised text-ink'
	};

	// -- STATES -- //

	let form = $state<HTMLFormElement>();
	let pendingKey = $state('');
	let pendingState = $state('');
	// What the person just did, shown at once while the server saves it. Cleared when the page data arrives.
	let local = $state<{
		marks: Record<string, 'done' | 'skipped' | null>;
		panel: 'open' | 'closed' | null;
	}>({
		marks: {},
		panel: null
	});

	// -- REACTIVE STATES -- //

	const marks = $derived.by((): Marks => {
		const merged: Record<string, 'done' | 'skipped'> = { ...input.marks };
		for (const [k, v] of Object.entries(local.marks)) {
			if (v === null) delete merged[k];
			else merged[k] = v;
		}
		return merged;
	});
	const tiles = $derived(setupTiles({ ...input, marks }));
	const progress = $derived(setupProgress(tiles));
	// The person's choice wins. With none, the checklist folds itself once every tile is done or skipped
	const choice = $derived(local.panel ?? panel);
	const shown = $derived(choice ? choice === 'open' : !progress.settled);
	const line = $derived(
		progress.settled
			? progress.skipped
				? `All settled. ${progress.skipped} skipped, and you can come back to them.`
				: 'Everything is set up.'
			: `${progress.done} of ${progress.total} done${progress.skipped ? `, ${progress.skipped} skipped` : ''}. Skip what you do not need.`
	);

	// -- FUNCTIONS -- //

	/** Saves one mark through the page action. The tile changes at once, and goes back if the save fails. */
	async function save(key: string, state: 'done' | 'skipped' | 'open' | 'closed' | null) {
		if (key === 'panel') local.panel = state === 'open' || state === 'closed' ? state : null;
		else local.marks[key] = state === 'done' || state === 'skipped' ? state : null;
		pendingKey = key;
		pendingState = state ?? '';
		await tick();
		form?.requestSubmit();
	}

	const onSave: SubmitFunction = ({ formData }) => {
		const key = String(formData.get('key') ?? '');
		return async ({ result }) => {
			if (result.type === 'failure' || result.type === 'error') {
				// Back to what the server holds
				if (key === 'panel') local.panel = null;
				else delete local.marks[key];
				toast.error('That mark could not be saved. Try again.');
				return;
			}
			// The result is not applied to the page form: it may hold the token that was just made, which is shown once. The saved marks come back with the page data
			await invalidateAll();
			// The page data now holds the saved marks, so what was shown in the meantime is let go
			if (key === 'panel') local.panel = null;
			else delete local.marks[key];
		};
	};
</script>

<!-- YOUR SETUP: WHAT IS DONE, WHAT IS LEFT AND WHAT YOU SKIPPED. ANYTHING CAN BE SKIPPED, AND A SKIP CAN BE UNDONE. IT IS THE PERSON'S OWN, IN THIS ORGANISATION -->
<section
	class="enter overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-[var(--elev-1)]"
	aria-label="Your setup"
	data-testid="setup-checklist"
>
	<!-- THE ONE FORM THAT SAVES A MARK. THE TILES SET ITS FIELDS AND SUBMIT IT -->
	<form bind:this={form} method="POST" action="?/mark" use:enhance={onSave} class="hidden">
		<input type="hidden" name="org" value={orgSlug} />
		<input type="hidden" name="key" value={pendingKey} />
		<input type="hidden" name="state" value={pendingState} />
	</form>

	<div class="flex items-center gap-3 px-4 py-3 max-sm:px-3.5">
		<ProgressRing
			value={progress.percent}
			label={`${progress.done} of ${progress.total} done`}
			size={36}
		/>
		<div class="min-w-0 flex-1">
			<h2 class="text-lg leading-6 font-semibold">Your setup</h2>
			<p class="text-sm text-muted" data-testid="setup-line">{line}</p>
		</div>
		<Button
			variant="secondary"
			iconOnly
			aria-label={shown ? 'Hide your setup' : 'Show your setup'}
			aria-expanded={shown}
			aria-controls={bodyId}
			data-testid="setup-toggle"
			onclick={() => save('panel', shown ? 'closed' : 'open')}
		>
			<ChevronDown
				size={20}
				class={cn('transition-transform motion-reduce:transition-none', !shown && 'rotate-180')}
			/>
		</Button>
	</div>
	<!-- THE TILES FOLD AWAY BY ANIMATING THEIR GRID ROW BETWEEN 1 AND 0 FRACTION. FOLDED, THEY ARE INVISIBLE AND INERT -->
	<div
		id={bodyId}
		inert={!shown}
		class={cn(
			'grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none',
			shown ? 'grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
		)}
	>
		<div class="min-h-0 overflow-hidden">
			<ul class="grid gap-px border-t border-line bg-line sm:grid-cols-2 xl:grid-cols-3">
				{#each tiles as t, i (t.key)}
					<li
						class="flex flex-col gap-3 bg-surface p-4 max-sm:p-3.5"
						data-check={t.key}
						data-status={t.status}
					>
						<div class="flex items-start gap-3">
							<span
								class={cn(
									'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
									MARK[t.status]
								)}
								aria-hidden="true"
							>
								{#if t.status === 'done'}<Check size={14} />
								{:else if t.status === 'attention'}<Clock size={14} />
								{:else if t.status === 'skipped'}<Minus size={14} />
								{:else}<span class="tabular-nums">{i + 1}</span>{/if}
							</span>
							<span class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span
									class={cn(
										'flex flex-wrap items-center gap-2 text-sm font-medium',
										t.status === 'skipped' ? 'text-muted' : 'text-ink'
									)}
								>
									{t.title}
									{#if t.optional}<Badge class="text-muted">Optional</Badge>{/if}
								</span>
								<span class="text-xs text-muted">{t.text}</span>
							</span>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							{#if t.status === 'done'}
								<a
									href={connectHref(orgSlug, t.go)}
									class="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
									>Review<ArrowRight size={16} aria-hidden="true" /></a
								>
								{#if t.manual}
									<button
										type="button"
										class="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center text-sm text-muted hover:text-ink"
										onclick={() => save(t.key, null)}>Undo</button
									>
								{/if}
							{:else if t.status === 'skipped'}
								<button
									type="button"
									class="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
									onclick={() => save(t.key, null)}
									><Undo2 size={16} aria-hidden="true" />Undo the skip</button
								>
							{:else}
								<Button href={connectHref(orgSlug, t.go)} size="sm"
									>{t.status === 'attention' ? 'Sign in again' : t.goLabel}<ArrowRight
										size={16}
										aria-hidden="true"
									/></Button
								>
								{#if t.manual}
									<Button size="sm" onclick={() => save(t.key, 'done')}>I did this</Button>
								{/if}
								<button
									type="button"
									class="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center px-1 text-sm text-muted hover:text-ink"
									onclick={() => save(t.key, 'skipped')}>Skip</button
								>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</div>
	</div>
</section>
