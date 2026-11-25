<script lang="ts">
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import SelectField from '#lib/ui/SelectField.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		org,
		projectKey,
		pitfalls,
		canWrite,
		onchanged
	}: {
		org: string;
		projectKey: string;
		/** The live pitfalls of the project, newest first. */
		pitfalls: {
			id: string;
			kind: string;
			text: string;
			path: string | null;
			itemRef: string | null;
			authorName: string | null;
			authorKind: string;
			createdAt: string | Date;
			canRemove: boolean;
		}[];
		/** True for a member, admin or owner: they may add a pitfall. */
		canWrite: boolean;
		/** Called after an add or a remove, so the page reads the list again. */
		onchanged: () => void | Promise<void>;
	} = $props();

	// -- CONSTANTS -- //

	/** The kinds a pitfall can be, in plain words. The values are unique, as Select needs. */
	const KINDS = [
		{ value: 'environment', label: 'Environment', hint: 'A quirk of the machine, shell or tools' },
		{
			value: 'known-red-test',
			label: 'Known failing test',
			hint: 'A test that fails for a reason of its own'
		},
		{ value: 'editing', label: 'Editing', hint: 'A trap when changing files' },
		{
			value: 'live-safety',
			label: 'Live safety',
			hint: 'A rule for anything that reaches a live site'
		}
	];
	const KIND_LABEL: Record<string, string> = Object.fromEntries(
		KINDS.map((k) => [k.value, k.label])
	);
	const MAX = 60;

	// -- STATES -- //

	let kind = $state('environment');
	let text = $state('');
	let path = $state('');
	let adding = $state(false);
	let removing = $state<string | null>(null);
	let error = $state('');

	// -- REACTIVE STATES -- //

	const full = $derived(pitfalls.length >= MAX);
	const tooShort = $derived(text.trim().length > 0 && text.trim().length < 10);

	// -- FUNCTIONS -- //

	/** Adds the typed pitfall and clears the form once it is saved. */
	async function add() {
		if (adding || full || text.trim().length < 10) return;
		adding = true;
		error = '';
		try {
			await toast.promise(
				api(org, `/projects/${projectKey}/pitfalls`, {
					method: 'POST',
					body: { kind, text: text.trim(), ...(path.trim() ? { path: path.trim() } : {}) },
					key: newKey()
				}),
				{
					loading: 'Adding the pitfall...',
					success: 'Pitfall added.',
					error: (e) => (e instanceof ApiError ? e.message : 'The pitfall was not added.')
				}
			);
			text = '';
			path = '';
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The pitfall was not added.';
			adding = false;
			return;
		}
		// The pitfall is saved: a failed refresh of the list never reports it as not added
		try {
			await onchanged();
		} finally {
			adding = false;
		}
	}

	/** Removes one pitfall after a confirmation that says who it affects. */
	async function remove(id: string, label: string) {
		if (
			!(await askConfirm({
				title: 'Remove this pitfall?',
				body: `Agents stop seeing "${label}" at the start of their work in this project.`,
				confirmLabel: 'Remove it',
				tone: 'danger'
			}))
		)
			return;
		removing = id;
		try {
			await toast.promise(
				api(org, `/projects/${projectKey}/pitfalls/${id}`, { method: 'DELETE', key: newKey() }),
				{
					loading: 'Removing...',
					success: 'Pitfall removed.',
					error: (e) => (e instanceof ApiError ? e.message : 'The pitfall was not removed.')
				}
			);
			await onchanged();
		} catch {
			// The promise toast already shows the failure
		} finally {
			removing = null;
		}
	}
</script>

<!-- KNOWN PITFALLS: ONE ROW PER FACT, THEN THE ADD FORM FOR MEMBERS -->
{#if pitfalls.length === 0}
	<!-- NOTHING LISTED YET: SAY WHERE PITFALLS COME FROM -->
	<div
		class="flex flex-col gap-1 rounded-lg border border-dashed border-line p-4"
		data-testid="pitfalls-empty"
	>
		<p class="text-sm font-medium text-ink">No pitfalls yet</p>
		<p class="text-sm text-muted">Agents add one when a lesson repeats.</p>
	</div>
{:else}
	<ul class="flex flex-col gap-2" data-testid="pitfalls">
		{#each pitfalls as p (p.id)}
			<li class="flex flex-col gap-2 rounded-lg border border-line p-3" data-testid="pitfall">
				<div class="flex items-start justify-between gap-2 max-sm:flex-col">
					<div class="flex min-w-0 flex-1 items-start gap-2 max-sm:flex-col">
						<Badge tone="info" class="shrink-0">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
						<p class="min-w-0 text-sm break-words text-ink">{p.text}</p>
					</div>
					{#if p.canRemove}
						<Button
							size="sm"
							variant="ghost"
							tone="danger"
							disabled={removing === p.id}
							aria-label={`Remove the pitfall ${p.text.slice(0, 60)}`}
							onclick={() => void remove(p.id, p.text.slice(0, 80))}>Remove</Button
						>
					{/if}
				</div>
				{#if p.path}
					<p class="font-mono text-xs break-all text-muted">{p.path}</p>
				{/if}
				<p class="text-xs text-muted">
					Added by {p.authorName ?? 'someone'}{p.authorKind === 'agent'
						? ' (an agent)'
						: ''}{#if p.itemRef}
						from <a
							class="cursor-pointer text-accent-text hover:underline"
							href={`/${org}/${projectKey}/${p.itemRef}`}>{p.itemRef}</a
						>{/if}, {ago(p.createdAt)}
				</p>
			</li>
		{/each}
	</ul>
{/if}

{#if canWrite}
	<!-- ADD A PITFALL: KIND, THE FACT, AN OPTIONAL PATH; ONE PLAIN BUTTON -->
	<form
		class="flex flex-col gap-3 rounded-lg border border-line p-3 text-sm"
		data-testid="pitfall-form"
		onsubmit={(e) => {
			e.preventDefault();
			void add();
		}}
	>
		<div class="grid grid-cols-[11rem_1fr] items-start gap-2 max-sm:grid-cols-1">
			<SelectField
				label="What kind of fact is it?"
				options={KINDS}
				bind:value={kind}
				disabled={full || adding}
			/>
			<TextField
				label="What should every plan know?"
				placeholder="svelte-check needs NODE_OPTIONS=--max-old-space-size=8192"
				bind:value={text}
				maxlength={500}
				disabled={full || adding}
				error={tooShort ? 'Write the fact in a few words (10 characters or more).' : error}
			/>
		</div>
		<TextField
			label="Which file or folder does it concern? (optional)"
			placeholder="tests/bridge/preview.test.ts"
			bind:value={path}
			maxlength={300}
			disabled={full || adding}
		/>
		<div class="flex flex-wrap items-center gap-3">
			<Button
				size="sm"
				type="submit"
				disabled={full || adding || text.trim().length < 10}
				data-testid="add-pitfall">Add pitfall</Button
			>
			{#if full}
				<span class="text-xs text-muted"
					>This project holds {MAX} pitfalls. Remove one that no longer holds first.</span
				>
			{/if}
		</div>
	</form>
{:else}
	<p class="text-sm text-muted" data-testid="pitfalls-reader">
		Members add pitfalls; an admin or the author removes one.
	</p>
{/if}
