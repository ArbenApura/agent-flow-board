<script lang="ts">
	// IMPORTED MODULES
	import { ago } from '#lib/board/status.js';
	// IMPORTED DEP-COMPONENTS
	import FolderIcon from '@lucide/svelte/icons/folder';
	// IMPORTED COMPONENTS
	import Avatar from '#lib/ui/Avatar.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Switch from '#lib/ui/Switch.svelte';

	// -- REQUIRED PROPS -- //

	let {
		folder,
		author,
		createdAt,
		lastEditor,
		updatedAt,
		words,
		canSwitch = false,
		private: isPrivate = false,
		busy = false,
		onprivate
	}: {
		/** The folder the note sits in, or null for a note at the top. */
		folder: { name: string; href: string } | null;
		author: { id: string | null; name: string } | null;
		createdAt: Date | string;
		lastEditor: string | null;
		updatedAt: Date | string;
		/** Words in the text, for the length line. */
		words: number;
		/** Only the person who wrote the note can make it private. */
		canSwitch?: boolean;
		private?: boolean;
		busy?: boolean;
		onprivate?: (next: boolean) => void;
	} = $props();

	// -- CONSTANTS -- //

	// About 220 words a minute, rounded up, never less than one minute
	const WORDS_PER_MINUTE = 220;

	// -- REACTIVE STATES -- //

	const created = $derived(
		new Date(createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
	);
	const minutes = $derived(Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)));
	const length = $derived(
		words === 0
			? 'No text yet'
			: `${words} ${words === 1 ? 'word' : 'words'}, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} to read`
	);
	const changed = $derived(`${ago(updatedAt)}${lastEditor ? `, by ${lastEditor}` : ''}`);
</script>

<!-- DETAILS OF THE NOTE, IN THE SIDE COLUMN (AFB-20261111-0805). THE ONLY ME SWITCH MOVED HERE FROM ITS OWN CARD -->
<Card data-testid="note-details">
	{#snippet header()}
		<h2 class="min-w-0 flex-1 text-lg leading-6 font-semibold">Details</h2>
	{/snippet}
	<dl class="flex flex-col gap-3 text-sm">
		<div class="flex flex-col gap-0.5">
			<dt class="text-xs font-medium text-muted">Folder</dt>
			<dd class="min-w-0 text-ink">
				{#if folder}
					<a
						href={folder.href}
						class="inline-flex max-w-full cursor-pointer items-center gap-1.5 text-accent-text hover:underline"
						><FolderIcon size={16} class="shrink-0" /><span class="truncate">{folder.name}</span></a
					>
				{:else}
					<span class="text-muted">In no folder</span>
				{/if}
			</dd>
		</div>
		{#if author}
			<div class="flex flex-col gap-0.5">
				<dt class="text-xs font-medium text-muted">Written by</dt>
				<dd class="flex min-w-0 items-center gap-2 text-ink">
					<Avatar name={author.name} userId={author.id} size={24} />
					<span class="truncate">{author.name}</span>
					<span class="shrink-0 text-muted">{created}</span>
				</dd>
			</div>
		{/if}
		<div class="flex flex-col gap-0.5">
			<dt class="text-xs font-medium text-muted">Last change</dt>
			<dd class="text-ink">{changed}</dd>
		</div>
		<div class="flex flex-col gap-0.5">
			<dt class="text-xs font-medium text-muted">Length</dt>
			<dd class="text-ink">{length}</dd>
		</div>
	</dl>
	{#if canSwitch}
		<div class="mt-3 border-t border-line">
			<Switch
				class="-mb-3"
				label="Only me"
				hint="Nobody else on the project can see or find this note."
				checked={isPrivate}
				disabled={busy}
				onchange={(next) => onprivate?.(next)}
			/>
		</div>
	{/if}
</Card>
