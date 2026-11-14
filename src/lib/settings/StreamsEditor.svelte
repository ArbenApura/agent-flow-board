<script lang="ts">
	// IMPORTED TYPES
	import type { StreamRow } from '#lib/board/streams.js';
	// IMPORTED MODULES
	import {
		MAX_NAME,
		MAX_SCOPES,
		MAX_STREAMS,
		nameKey,
		standardStreams,
		withIds
	} from '#lib/board/streams.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import TagInput from '#lib/ui/TagInput.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		rows = $bindable(),
		usage,
		can
	}: {
		rows: StreamRow[];
		/** How many items the person can see under each stream and scope, already counted by the project page. */
		usage: { stream: string; scope: string; n: number }[];
		/** Only a person who manages the project changes the list. */
		can: boolean;
	} = $props();

	// -- REACTIVE STATES -- //

	// The first stream that has a scope shows how an item displays them. Before any exists, the default shows
	const example = $derived.by(() => {
		const first = rows.find((r) => r.stream.trim() && r.scopes.length);
		return first ? `${first.stream.trim()}/${first.scopes[0]}` : 'features/core';
	});

	// -- FUNCTIONS -- //

	const countStream = (stream: string) =>
		usage.filter((u) => u.stream === stream.trim()).reduce((sum, u) => sum + u.n, 0);

	const countScope = (stream: string, scope: string) =>
		usage
			.filter((u) => u.stream === stream.trim() && u.scope === scope)
			.reduce((s, u) => s + u.n, 0);

	const items = (n: number) => (n === 1 ? '1 item is' : `${n} items are`);

	const usedText = (n: number) => (n ? `${items(n)} filed here.` : 'No item is filed here yet.');

	function addRow() {
		rows = [...rows, ...withIds([{ stream: '', scopes: [] }])];
	}

	function useStandard() {
		rows = withIds(standardStreams());
	}

	// Replacing a list that already has streams drops the person's own edits, so it asks first
	async function resetToStandard() {
		const yes = await askConfirm({
			title: 'Replace the list with the standard set?',
			body: 'The streams and scopes below are replaced by the standard set. Nothing is saved until you press Save, and items keep the stream and scope they have.',
			confirmLabel: 'Replace the list'
		});
		if (yes) useStandard();
	}

	async function removeRow(row: StreamRow) {
		const n = countStream(row.stream);
		if (n > 0) {
			const yes = await askConfirm({
				title: `Remove ${row.stream.trim()} from the list?`,
				body: `${items(n)} filed under ${row.stream.trim()}. They keep it and it still shows on them and in the filters. Only this list changes, and only after you press Save.`,
				confirmLabel: 'Remove',
				tone: 'danger'
			});
			if (!yes) return;
		}
		rows = rows.filter((r) => r.id !== row.id);
	}

	async function confirmScope(row: StreamRow, scope: string) {
		const n = countScope(row.stream, scope);
		if (n === 0) return true;
		return askConfirm({
			title: `Remove ${scope} from ${row.stream.trim()}?`,
			body: `${items(n)} filed under ${row.stream.trim()}/${scope}. They keep it and it still shows on them. Only this list changes, and only after you press Save.`,
			confirmLabel: 'Remove',
			tone: 'danger'
		});
	}

	// A stream name that clashes with another row or is too long says so on its own row
	function nameProblem(row: StreamRow) {
		const name = row.stream.trim();
		if (name.length > MAX_NAME) return `At most ${MAX_NAME} characters`;
		if (name && rows.some((r) => r.id !== row.id && nameKey(r.stream) === nameKey(name)))
			return 'Another stream has this name';
		return undefined;
	}

	function scopeProblem(tag: string, current: string[]) {
		if (tag.length > MAX_NAME) return `At most ${MAX_NAME} characters`;
		if (current.some((c) => nameKey(c) === nameKey(tag))) return 'Already in this stream';
		if (current.length >= MAX_SCOPES) return `At most ${MAX_SCOPES} scopes in a stream`;
		return null;
	}
</script>

<!-- WHAT STREAMS AND SCOPES ARE, WITH ONE EXAMPLE OF HOW AN ITEM SHOWS THEM -->
<div class="flex flex-col gap-1 text-sm text-muted">
	<p>
		Every item is filed under a stream, the kind of work (features, fixes), and a scope, the part it
		touches (core, routes).
	</p>
	<p>
		An item shows them as stream/scope, for example
		<span class="rounded-md bg-raised px-1.5 font-medium text-ink" data-testid="stream-example"
			>{example}</span
		>.
	</p>
</div>

{#if rows.length === 0}
	<!-- NOTHING LISTED YET: SAY WHAT HAPPENS NOW AND OFFER THE STANDARD SET AS THE FIRST STEP -->
	<div class="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line p-4">
		<div class="flex flex-col gap-1">
			<p class="text-sm font-medium text-ink">No streams yet</p>
			<p class="text-sm text-muted">
				Until you list some, new items are filed as features/core. Start from the standard set and
				change it, or add your own.
			</p>
		</div>
		{#if can}
			<div class="flex flex-wrap gap-2">
				<Button size="sm" onclick={useStandard} data-testid="use-standard"
					>Use the standard set</Button
				>
				<Button size="sm" variant="ghost" onclick={addRow} data-testid="add-stream"
					>Add a stream</Button
				>
			</div>
		{/if}
	</div>
{:else}
	{#each rows as row (row.id)}
		<div class="flex flex-col gap-2 rounded-lg border border-line p-3" data-testid="stream">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<span class="text-xs text-muted">{usedText(countStream(row.stream))}</span>
				{#if can}
					<Button
						size="sm"
						variant="ghost"
						tone="danger"
						aria-label={`Remove the stream ${row.stream.trim() || 'with no name'}`}
						onclick={() => void removeRow(row)}>Remove</Button
					>
				{/if}
			</div>
			<div class="grid grid-cols-[11rem_1fr] items-start gap-2 max-sm:grid-cols-1">
				<TextField
					label="Stream"
					bind:value={row.stream}
					disabled={!can}
					error={nameProblem(row)}
				/>
				<TagInput
					label="Scopes"
					bind:tags={row.scopes}
					disabled={!can}
					validate={scopeProblem}
					onremove={(tag) => confirmScope(row, tag)}
					removeLabel={(tag) => `Remove ${tag} from ${row.stream.trim() || 'this stream'}`}
				/>
			</div>
		</div>
	{/each}
	{#if can}
		<div class="flex flex-wrap gap-2">
			<Button
				size="sm"
				onclick={addRow}
				disabled={rows.length >= MAX_STREAMS}
				data-testid="add-stream">Add a stream</Button
			>
			<Button
				size="sm"
				variant="ghost"
				onclick={() => void resetToStandard()}
				data-testid="reset-standard">Reset to the standard set</Button
			>
		</div>
	{/if}
{/if}
