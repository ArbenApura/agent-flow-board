<script lang="ts">
	// IMPORTED TYPES
	import type { Folder } from '#lib/board/notes/tree.js';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { indentClass, moveTargets, pastIndent } from '#lib/board/notes/tree.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import FolderIcon from '@lucide/svelte/icons/folder';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		folders,
		what,
		movingFolderId = null,
		current = null,
		onmove
	}: {
		open: boolean;
		onclose: () => void;
		folders: Folder[];
		/** The name of what is being moved, for the heading. */
		what: string;
		/** Set when a folder is moved: it cannot go into itself or a folder inside it, so those are not offered. */
		movingFolderId?: string | null;
		/** Where it is now (null for the top). */
		current?: string | null;
		/** Moves it. Returns a plain message when it could not, and nothing when it did. */
		onmove: (folderId: string | null) => Promise<string | null | void>;
	} = $props();

	// -- STATES -- //

	let picked = $state<string | null>(null);
	let error = $state('');
	let busy = $state(false);
	let prevOpen = false;

	// -- REACTIVE STATES -- //

	const targets = $derived(moveTargets(folders, movingFolderId));

	// -- REACTIVE STATEMENTS -- //

	// The choice starts from where the thing is now each time the dialog opens
	$effect(() => {
		if (open && !prevOpen)
			untrack(() => {
				picked = current;
				error = '';
			});
		prevOpen = open;
	});

	// -- FUNCTIONS -- //

	async function save() {
		if (busy || picked === current) return;
		busy = true;
		error = '';
		try {
			const refused = await onmove(picked);
			if (refused) error = refused;
			else onclose();
		} finally {
			busy = false;
		}
	}
</script>

{#snippet option(id: string | null, name: string, depth: number, path: string | null)}
	{@const on = picked === id}
	<button
		type="button"
		role="radio"
		aria-checked={on}
		onclick={() => (picked = id)}
		class={cn(
			'flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left text-sm text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-14',
			on && 'bg-accent-soft text-accent-text hover:bg-accent-soft'
		)}
	>
		<span class={cn('flex min-w-0 flex-1 items-center gap-2.5', indentClass(depth))}>
			<FolderIcon size={16} class="shrink-0 text-muted" />
			<span class="min-w-0 flex-1">
				<span class="block truncate">{name}</span>
				{#if path && pastIndent(depth)}
					<span class="block truncate text-xs text-muted">{path}</span>
				{/if}
			</span>
		</span>
		{#if on}<Check size={16} class="shrink-0 text-accent" />{/if}
	</button>
{/snippet}

<!-- WHERE SHOULD IT GO? THE SAME DIALOG MOVES A NOTE OR A FOLDER, ON EVERY SCREEN WIDTH -->
<ResponsiveModal {open} {onclose} title={`Move "${what}"`} size="md" {busy}>
	<div class="flex flex-col gap-2 text-sm">
		<p class="text-muted">Which folder should it go in?</p>
		<div role="radiogroup" aria-label="Folders" class="flex max-h-[50vh] flex-col overflow-y-auto">
			{@render option(null, 'Top level, in no folder', 1, null)}
			{#each targets as f (f.id)}
				{@render option(f.id, f.name, f.depth, f.path)}
			{/each}
		</div>
		{#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
	</div>
	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center justify-end gap-2">
			<Button disabled={busy} onclick={onclose} class="text-sm">Cancel</Button>
			<Button
				variant="primary"
				loading={busy}
				disabled={picked === current}
				onclick={save}
				class="text-sm">Move it here</Button
			>
		</div>
	{/snippet}
</ResponsiveModal>
