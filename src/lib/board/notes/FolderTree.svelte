<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';
	// -- TYPES -- //
	import type { Folder, TreeKey, TreeView } from '#lib/board/notes/tree.js';
	import type { MenuItem } from '#lib/ui/ActionMenu.svelte';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	// -- MODULES -- //
	import {
		hasChildren,
		indentClass,
		openTo,
		pastIndent,
		treeKey,
		visibleRows
	} from '#lib/board/notes/tree.js';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import NotebookText from '@lucide/svelte/icons/notebook-text';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Star from '@lucide/svelte/icons/star';
	import Trash from '@lucide/svelte/icons/trash';
	// -- COMPONENTS -- //
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Button from '#lib/ui/Button.svelte';

	// -- TYPES -- //

	type Dropped = { kind: 'note' | 'folder'; id: string };

	// -- REQUIRED PROPS -- //

	let {
		folders,
		active,
		hrefFor,
		total,
		canWrite = false,
		canDelete = false,
		onrename,
		onmove,
		ontrash,
		ondropped,
		onpick,
		onnewfolder,
		favourites
	}: {
		folders: Folder[];
		active: TreeView;
		/** The address of a view, so every row is a real link and the open folder lives in the address. */
		hrefFor: (view: TreeView) => string;
		/** Every note the person may see. */
		total: number;
		/** The notes the person starred, shown beside Favourites. */
		favourites?: number;
		/** Opens the New folder dialog, from the icon button beside the Folders heading. */
		onnewfolder?: () => void;
		canWrite?: boolean;
		canDelete?: boolean;
		onrename?: (folder: Folder) => void;
		onmove?: (folder: Folder) => void;
		ontrash?: (folder: Folder) => void;
		/** A note or a folder was dropped on a folder (desktop only; the Move to dialog does the same everywhere). */
		ondropped?: (what: Dropped, folderId: string) => void;
		/** A row was chosen, so a drawer that holds the tree can close. */
		onpick?: () => void;
	} = $props();

	// -- CONSTANTS -- //

	const NOTE_TYPE = 'application/x-afb-note';
	const FOLDER_TYPE = 'application/x-afb-folder';
	// The colours, active state and radius of a sidebar row, at the contents-card row of the Documents tab (40, and 44 in the drawer) (AFB-20261111-0805)
	const ROW =
		'group/row relative flex min-h-10 items-center rounded-lg text-sm text-ink transition-colors hover:bg-raised max-lg:min-h-11 motion-reduce:transition-none';
	const ROW_ON = 'bg-accent-soft font-medium text-accent-text hover:bg-accent-soft';
	// One leading slot for the icon, the caret or a folder icon, so every name starts on one edge
	const SLOT = 'inline-flex h-10 w-8 shrink-0 items-center justify-center max-lg:h-11 max-lg:w-11';
	const LINK =
		'flex min-h-10 min-w-0 flex-1 cursor-pointer items-center self-stretch rounded-md pl-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent max-lg:min-h-11';

	// -- STATES -- //

	const expanded = new SvelteSet<string>();
	let list = $state<HTMLElement>();
	/** The folder a drag is over, so it can show where the drop will land. */
	let over = $state<string | null>(null);

	// -- REACTIVE STATES -- //

	const rows = $derived(visibleRows(folders, expanded));

	// -- REACTIVE STATEMENTS -- //

	// The folders above the open one are opened, so the open folder is always in view. Folders a person opened stay open
	$effect(() => {
		const need = openTo(folders, active === 'all' || active === 'favourites' ? null : active);
		untrack(() => {
			for (const id of need) expanded.add(id);
		});
	});

	// -- FUNCTIONS -- //

	function toggle(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}

	function focusRow(id: string) {
		// The row may only exist after the tree opened, so the focus waits for the next frame
		requestAnimationFrame(() =>
			list?.querySelector<HTMLElement>(`[data-folder="${CSS.escape(id)}"]`)?.focus()
		);
	}

	function keydown(e: KeyboardEvent, id: string) {
		const keys: TreeKey[] = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
		if (!keys.includes(e.key as TreeKey) || e.altKey || e.ctrlKey || e.metaKey) return;
		const move = treeKey(folders, expanded, id, e.key as TreeKey);
		if (move.expand) expanded.add(move.expand);
		if (move.collapse) expanded.delete(move.collapse);
		if (move.focus) focusRow(move.focus);
		if (move.expand || move.collapse || move.focus) e.preventDefault();
	}

	function menuOf(f: Folder): MenuItem[] {
		const items: MenuItem[] = [];
		if (canWrite && onrename)
			items.push({ label: 'Rename', icon: Pencil, onselect: () => onrename(f) });
		if (canWrite && onmove)
			items.push({ label: 'Move to', icon: FolderInput, onselect: () => onmove(f) });
		if (canDelete && ontrash)
			items.push({
				label: 'Move to the trash',
				icon: Trash,
				danger: true,
				onselect: () => ontrash(f)
			});
		return items;
	}

	const carries = (e: DragEvent) =>
		!!e.dataTransfer &&
		(e.dataTransfer.types.includes(NOTE_TYPE) || e.dataTransfer.types.includes(FOLDER_TYPE));

	function dragover(e: DragEvent, id: string) {
		if (!canWrite || !ondropped || !carries(e)) return;
		e.preventDefault();
		over = id;
	}

	function drop(e: DragEvent, id: string) {
		over = null;
		if (!canWrite || !ondropped || !e.dataTransfer) return;
		e.preventDefault();
		const note = e.dataTransfer.getData(NOTE_TYPE);
		const folder = e.dataTransfer.getData(FOLDER_TYPE);
		if (note) ondropped({ kind: 'note', id: note }, id);
		else if (folder && folder !== id) ondropped({ kind: 'folder', id: folder }, id);
	}
</script>

{#snippet fixed(
	view: TreeView,
	label: string,
	Icon: Component<{ size?: number; class?: string }>,
	count?: number
)}
	{@const on = active === view}
	<li>
		<a
			href={hrefFor(view)}
			onclick={onpick}
			aria-current={on ? 'page' : undefined}
			class={cn(
				ROW,
				'cursor-pointer pr-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
				on && ROW_ON
			)}
		>
			<span class={cn(SLOT, !on && 'text-muted')}><Icon size={18} /></span>
			<span class="min-w-0 flex-1 truncate pl-1">{label}</span>
			{#if count !== undefined}
				<span
					data-count
					class={cn(
						'w-8 shrink-0 text-center text-badge font-semibold tabular-nums',
						!on && 'text-muted'
					)}>{count}</span
				>
			{/if}
		</a>
	</li>
{/snippet}

<!-- THE FOLDER TREE OF THE NOTES PAGE. EVERY ROW IS A LINK, THE CARET AND THE NAME ARE TWO SEPARATE CONTROLS -->
<nav
	aria-label="Note folders"
	class="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)]"
>
	<ul class="flex flex-col gap-0.5">
		{@render fixed('all', 'All notes', NotebookText, total)}
		{@render fixed('favourites', 'Favourites', Star, favourites)}
	</ul>
	{#if folders.length || (canWrite && onnewfolder)}
		<div class="mx-1 my-2 border-t border-line"></div>
		<div class="flex min-h-8 items-center justify-between pl-2.5">
			<h2 class="text-xs font-medium text-muted">Folders</h2>
			{#if canWrite && onnewfolder}
				<Button
					variant="subtle"
					size="sm"
					iconOnly
					aria-label="New folder"
					title="New folder"
					onclick={onnewfolder}
					data-testid="new-folder"
				>
					<FolderPlus size={16} />
				</Button>
			{/if}
		</div>
	{/if}
	{#if folders.length}
		<ul bind:this={list} class="mt-1 flex flex-col gap-0.5">
			{#each rows as f (f.id)}
				{@const on = active === f.id}
				{@const parent = hasChildren(folders, f.id)}
				{@const open = expanded.has(f.id)}
				{@const menu = menuOf(f)}
				<li>
					<div
						role="presentation"
						class={cn(
							ROW,
							indentClass(f.depth),
							on && ROW_ON,
							over === f.id && 'outline-2 outline-accent'
						)}
						draggable={canWrite && !!ondropped}
						ondragstart={(e) => e.dataTransfer?.setData(FOLDER_TYPE, f.id)}
						ondragover={(e) => dragover(e, f.id)}
						ondragleave={() => (over = over === f.id ? null : over)}
						ondrop={(e) => drop(e, f.id)}
					>
						<!-- THE LEADING SLOT: THE CARET FOR A FOLDER WITH FOLDERS INSIDE, A FOLDER ICON FOR ANY OTHER -->
						{#if parent}
							<button
								type="button"
								aria-label={open ? `Close ${f.name}` : `Open ${f.name}`}
								aria-expanded={open}
								onclick={() => toggle(f.id)}
								class={cn(
									SLOT,
									'cursor-pointer rounded-md hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
									!on && 'text-muted'
								)}
							>
								<ChevronRight
									size={16}
									class={cn(
										'transition-transform motion-reduce:transition-none',
										open && 'rotate-90'
									)}
								/>
							</button>
						{:else}
							<span class={cn(SLOT, !on && 'text-muted')} aria-hidden="true"
								><FolderIcon size={16} /></span
							>
						{/if}
						<a
							href={hrefFor(f.id)}
							data-folder={f.id}
							onclick={onpick}
							onkeydown={(e) => keydown(e, f.id)}
							aria-current={on ? 'page' : undefined}
							title={f.name}
							class={LINK}
						>
							<span class="min-w-0 flex-1 py-2 break-words">
								<span class="block">{f.name}</span>
								<!-- A folder deeper than the indent goes shows its place as words -->
								{#if pastIndent(f.depth)}
									<span class="block truncate text-xs font-normal text-muted">{f.path}</span>
								{/if}
							</span>
						</a>
						<!-- THE COUNT, AND THE ACTIONS IN ITS PLACE ON HOVER OR FOCUS. ON A TOUCH SCREEN BOTH SHOW SIDE BY SIDE -->
						<span
							class="relative flex shrink-0 items-center pr-1 pointer-fine:w-8 pointer-fine:justify-center"
						>
							{#if f.notes}
								<span
									data-count
									class={cn(
										'px-1 text-badge font-semibold tabular-nums',
										!on && 'text-muted',
										menu.length > 0 &&
											'pointer-fine:group-focus-within/row:opacity-0 pointer-fine:group-hover/row:opacity-0'
									)}>{f.notes}</span
								>
							{/if}
							{#if menu.length}
								<span
									class="pointer-fine:absolute pointer-fine:inset-0 pointer-fine:flex pointer-fine:items-center pointer-fine:justify-center pointer-fine:opacity-0 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:group-hover/row:opacity-100"
									><ActionMenu items={menu} label={`Actions for ${f.name}`} size="sm" /></span
								>
							{/if}
						</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</nav>
