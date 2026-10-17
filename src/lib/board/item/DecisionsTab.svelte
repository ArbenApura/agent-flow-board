<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Plus from '@lucide/svelte/icons/plus';

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- STATES -- //

	let adding = $state(false);
	let kind = $state('adr');
	let title = $state('');
	let body = $state('');
	let answer = $state('');
	let source = $state('');
	let busy = $state(false);
	let error = $state('');

	// -- REACTIVE STATES -- //

	const adrs = $derived(detail.decisions.filter((d) => d.kind === 'adr'));
	const settled = $derived(detail.decisions.filter((d) => d.kind === 'settled'));

	// -- FUNCTIONS -- //

	async function save() {
		error = '';
		busy = true;
		try {
			await api(env.org, `/items/${detail.item.ref}/decisions`, {
				body:
					kind === 'adr'
						? { kind, title: title.trim(), decision: body.trim() }
						: { kind, title: title.trim(), answer: answer.trim(), source: source.trim() },
				key: newKey()
			});
			// The refusal shows in the dialog, so only the success is a toast
			toast.success('Decision saved.');
			adding = false;
			title = body = answer = source = '';
			await env.onchanged();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'That was not saved.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-6" data-testid="decisions-tab">
	{#if env.canWrite}
		<div>
			<Button
				size="sm"
				onclick={() => {
					adding = true;
					error = '';
				}}
				data-testid="add-decision"><Plus size={14} /> Add a decision</Button
			>
		</div>
	{/if}

	{#if detail.decisions.length === 0}
		<EmptyState
			kind="decisions"
			title="No decisions recorded"
			text="Decisions explain why the work is built the way it is. Choices made without asking go in the settled list, so they can be overruled."
		/>
	{/if}

	{#if adrs.length}
		<TabCard
			collapsible
			storageKey={`afb:collapse:${env.org}:${detail.item.id}:decisions`}
			role="region"
			aria-label="Decisions"
		>
			{#snippet heading()}Decisions{/snippet}
			{#snippet meta()}<span class="text-sm text-muted tabular-nums">{adrs.length}</span>{/snippet}
			<ul>
				{#each adrs as d (d.id)}
					<li class="border-b border-line last:border-b-0" data-testid="adr">
						<details class="group">
							<summary
								class="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-raised/60 max-sm:px-3.5 [&::-webkit-details-marker]:hidden"
							>
								<ChevronDown
									size={16}
									class="shrink-0 -rotate-90 text-muted transition-transform group-open:rotate-0 motion-reduce:transition-none"
									aria-hidden="true"
								/>
								<span
									class="min-w-10 shrink-0 rounded-[6px] bg-raised px-2 py-0.5 text-center font-mono text-xs text-muted tabular-nums"
									>ADR-{String(d.number).padStart(3, '0')}</span
								>
								<span class="min-w-0 flex-1 text-sm font-medium break-words">{d.title}</span>
							</summary>
							<div
								class="md mr-4 mb-3 ml-[27px] flex flex-col gap-2 border-l-2 border-line pl-4 max-sm:mr-3.5"
							>
								{#if d.context}<h3>Context</h3>
									<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
									{@html d.contextHtml}{/if}
								{#if d.decision}<h3>Decision</h3>
									<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
									{@html d.decisionHtml}{/if}
								{#if d.alternatives}<h3>Alternatives</h3>
									<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
									{@html d.alternativesHtml}{/if}
								{#if d.consequences}<h3>Consequences</h3>
									<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
									{@html d.consequencesHtml}{/if}
							</div>
						</details>
					</li>
				{/each}
			</ul>
		</TabCard>
	{/if}

	{#if settled.length}
		<TabCard
			collapsible
			storageKey={`afb:collapse:${env.org}:${detail.item.id}:settled`}
			role="region"
			aria-label="Settled without asking"
		>
			{#snippet heading()}Settled without asking{/snippet}
			{#snippet meta()}<span class="text-sm text-muted tabular-nums">{settled.length}</span
				>{/snippet}
			<p class="border-b border-line px-4 py-2 text-xs text-muted max-sm:px-3.5">
				Questions the builder answered from the documents and the code. Overrule any of them.
			</p>
			<ul data-testid="settled-list">
				{#each settled as d (d.id)}
					<li
						class="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0 max-sm:px-3.5 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-4"
					>
						<div class="flex min-w-0 flex-col gap-0.5">
							<span class="text-sm font-medium break-words text-ink">{d.title}</span>
							<span class="text-sm break-words text-muted">{d.answer}</span>
						</div>
						{#if d.source}
							<span
								class="max-w-[40ch] self-start rounded-[6px] bg-raised px-2 py-0.5 text-xs break-words text-muted"
								>Source: {d.source}</span
							>
						{/if}
					</li>
				{/each}
			</ul>
		</TabCard>
	{/if}
</div>

<ResponsiveModal open={adding} onclose={() => (adding = false)} title="Add a decision" {busy}>
	<form
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<SegmentedControl
			label="Kind of decision"
			bind:value={kind}
			options={[
				{ value: 'adr', label: 'Decision' },
				{ value: 'settled', label: 'Settled without asking' }
			]}
		/>
		<TextField
			label={kind === 'adr' ? 'Title of the decision' : 'The question that was settled'}
			bind:value={title}
			required
		/>
		{#if kind === 'adr'}
			<TextArea label="What was decided" bind:value={body} rows={4} />
		{:else}
			<TextField label="The answer" bind:value={answer} required />
			<TextField label="Where the answer came from" bind:value={source} />
		{/if}
		{#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
		<div class="flex justify-end gap-2">
			<Button onclick={() => (adding = false)} disabled={busy}>Cancel</Button>
			<Button type="submit" variant="primary" loading={busy}>Save</Button>
		</div>
	</form>
</ResponsiveModal>
