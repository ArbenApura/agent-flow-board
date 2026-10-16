<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	// -- DEP-COMPONENTS -- //
	import Plus from 'phosphor-svelte/lib/Plus';

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
			title="No decisions recorded"
			text="Decisions explain why the work is built the way it is. Choices made without asking go in the settled list, so they can be overruled."
		/>
	{/if}

	{#if adrs.length}
		<section class="flex flex-col gap-2" aria-label="Decisions">
			<h2 class="text-lg font-semibold">Decisions</h2>
			<ul class="rounded-xl border border-line bg-surface">
				{#each adrs as d (d.id)}
					<li class="border-b border-line last:border-b-0" data-testid="adr">
						<details class="group">
							<summary
								class="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium"
							>
								<span class="font-mono text-xs text-muted"
									>ADR-{String(d.number).padStart(3, '0')}</span
								>
								{d.title}
							</summary>
							<div class="md flex flex-col gap-2 px-3 pt-1 pb-3">
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
		</section>
	{/if}

	{#if settled.length}
		<section class="flex flex-col gap-2" aria-label="Settled without asking">
			<h2 class="text-lg font-semibold">Settled without asking</h2>
			<div class="text-xs text-muted">
				Questions the builder answered from the documents and the code. Overrule any of them.
			</div>
			<ul class="rounded-xl border border-line bg-surface" data-testid="settled-list">
				{#each settled as d (d.id)}
					<li class="flex flex-col gap-0.5 border-b border-line px-3 py-2 last:border-b-0">
						<span class="text-sm font-medium text-ink">{d.title}</span>
						<span class="text-sm text-ink">{d.answer}</span>
						{#if d.source}<span class="text-xs text-muted">Source: {d.source}</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
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
