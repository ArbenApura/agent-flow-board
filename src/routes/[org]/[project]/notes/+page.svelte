<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- TYPES -- //
	import type { Folder } from '#lib/board/notes/tree.js';
	import type { MenuItem } from '#lib/ui/ActionMenu.svelte';
	// -- ENVS -- //
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { crumbs, moveRefusal } from '#lib/board/notes/tree.js';
	import { activeOf, emptyNotes, notesHref } from '#lib/board/notes/view.js';
	import { ago } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import Lock from '@lucide/svelte/icons/lock';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Star from '@lucide/svelte/icons/star';
	import Trash from '@lucide/svelte/icons/trash';
	// -- COMPONENTS -- //
	import FolderTree from '#lib/board/notes/FolderTree.svelte';
	import MoveDialog from '#lib/board/notes/MoveDialog.svelte';
	import NameDialog from '#lib/board/notes/NameDialog.svelte';
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- TYPES -- //

	type NoteRow = PageProps['data']['notes'][number];
	/** The dialog that is open. Its data is kept while it closes, so the words do not flash blank. */
	type Naming = { kind: 'note' } | { kind: 'folder' } | { kind: 'rename'; folder: Folder };
	type Moving = { kind: 'note'; note: NoteRow } | { kind: 'folder'; folder: Folder };

	// -- CONSTANTS -- //

	const NOTE_TYPE = 'application/x-afb-note';

	// -- STATES -- //

	// The search box shows what the address holds, so a shared or reloaded link does not look unfiltered
	let q = $state(untrack(() => page.url.searchParams.get('q') ?? ''));
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let drawer = $state(false);
	let naming = $state<Naming>({ kind: 'note' });
	let namingOpen = $state(false);
	let moving = $state<Moving | null>(null);
	let movingOpen = $state(false);

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const view = $derived(data.view);
	const active = $derived(activeOf(view));
	const folders = $derived(data.folders as Folder[]);
	const here = $derived(view.folderId ? folders.find((f) => f.id === view.folderId) : undefined);
	const trail = $derived(crumbs(folders, view.folderId));
	const empty = $derived(emptyNotes(view, data.total > 0, data.canWrite));
	const projectName = $derived(data.summary?.project.name ?? key);
	const heading = $derived(
		view.view === 'favourites'
			? 'Favourites'
			: view.view === 'folder'
				? (here?.name ?? 'Folder')
				: 'All notes'
	);
	const folderNameOf = $derived(new Map(folders.map((f) => [f.id, f.path])));
	const nameDialog = $derived(
		naming.kind === 'note'
			? {
					title: 'New note',
					label: 'What is the note called?',
					confirm: 'Create the note',
					hint: here ? `It goes in ${here.path}.` : 'It goes at the top, in no folder.',
					initial: '',
					max: 200
				}
			: naming.kind === 'folder'
				? {
						title: 'New folder',
						label: 'What is the folder called?',
						confirm: 'Create the folder',
						hint: here ? `It goes inside ${here.path}.` : 'It goes at the top.',
						initial: '',
						max: 80
					}
				: {
						title: 'Rename the folder',
						label: 'What should the folder be called?',
						confirm: 'Rename it',
						hint: undefined,
						initial: naming.folder.name,
						max: 80
					}
	);

	// -- FUNCTIONS -- //

	const hrefFor = (target: string) => notesHref(base, target, target === active ? view.q : '');
	const refresh = () => invalidate('afb:project');
	const said = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

	const typed = () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(
			() =>
				void goto(notesHref(base, active, q), {
					replace: true,
					// Typing must not jump the page or lose the cursor
					reset: false
				}),
			250
		);
	};

	function clearSearch() {
		q = '';
		void goto(notesHref(base, active), { replace: true });
	}

	function ask(what: Naming) {
		naming = what;
		namingOpen = true;
	}

	/** Saves what the name dialog asked for. A refusal comes back as the plain words the server gave. */
	async function saveName(name: string): Promise<string | null> {
		try {
			if (naming.kind === 'note') {
				const made = await api<{ ref: string }>(org, `/projects/${key}/notes`, {
					body: { title: name, folderId: view.folderId ?? undefined },
					key: newKey()
				});
				await goto(`${base}/notes/${made.ref}`);
			} else if (naming.kind === 'folder') {
				await api(org, `/projects/${key}/note-folders`, {
					body: { name, parentId: view.folderId ?? undefined },
					key: newKey()
				});
				await refresh();
			} else {
				await api(org, `/projects/${key}/note-folders/${naming.folder.id}`, {
					method: 'PATCH',
					body: { name }
				});
				await refresh();
			}
			return null;
		} catch (e) {
			return said(e, 'That could not be saved. Try again.');
		}
	}

	function askMove(what: Moving) {
		moving = what;
		movingOpen = true;
	}

	async function moveNote(ref: string, folderId: string | null): Promise<string | null> {
		try {
			await api(org, `/projects/${key}/notes/${ref}`, { method: 'PATCH', body: { folderId } });
			await refresh();
			return null;
		} catch (e) {
			return said(e, 'The note could not be moved. Try again.');
		}
	}

	async function moveFolder(folder: Folder, parentId: string | null): Promise<string | null> {
		const refused = moveRefusal(folders, folder.id, parentId);
		if (refused) return refused;
		try {
			await api(org, `/projects/${key}/note-folders/${folder.id}`, {
				method: 'PATCH',
				body: { parentId }
			});
			await refresh();
			return null;
		} catch (e) {
			return said(e, 'The folder could not be moved. Try again.');
		}
	}

	const saveMove = (folderId: string | null) =>
		!moving
			? Promise.resolve(null)
			: moving.kind === 'note'
				? moveNote(moving.note.ref, folderId)
				: moveFolder(moving.folder, folderId);

	/** A note or a folder dropped on a folder of the tree (desktop). The same moves as the dialog, with a toast for a refusal. */
	async function dropped(what: { kind: 'note' | 'folder'; id: string }, folderId: string) {
		const folder = what.kind === 'folder' ? folders.find((f) => f.id === what.id) : undefined;
		const refused =
			what.kind === 'note'
				? await moveNote(what.id, folderId)
				: folder
					? await moveFolder(folder, folderId)
					: null;
		if (refused) toast.error(refused);
	}

	async function trashFolder(folder: Folder) {
		const ok = await askConfirm({
			title: `Move "${folder.name}" to the trash?`,
			body: 'Every folder and note inside it is hidden with it, for everyone on the project. Public links of those notes stop. It can be restored from the Trash for 30 days.',
			confirmLabel: 'Move to the trash',
			tone: 'danger'
		});
		if (!ok) return;
		try {
			await api(org, `/projects/${key}/note-folders/${folder.id}`, { method: 'DELETE' });
			toast.success('The folder is in the trash.');
			if (view.folderId) await goto(notesHref(base, 'all'));
			else await refresh();
		} catch (e) {
			toast.error(said(e, 'The folder could not be moved to the trash.'));
		}
	}

	async function trashNote(n: NoteRow) {
		const ok = await askConfirm({
			title: `Move "${n.title}" to the trash?`,
			body: 'It is hidden for everyone who could see it, and its public link stops. It can be restored from the Trash for 30 days.',
			confirmLabel: 'Move to the trash',
			tone: 'danger'
		});
		if (!ok) return;
		try {
			await api(org, `/projects/${key}/notes/${n.ref}`, { method: 'DELETE' });
			toast.success('The note is in the trash.');
			await refresh();
		} catch (e) {
			toast.error(said(e, 'The note could not be moved to the trash.'));
		}
	}

	async function star(n: NoteRow) {
		try {
			await api(org, `/projects/${key}/notes/${n.ref}/favourite`, {
				method: 'PUT',
				body: { on: !n.favourite }
			});
			await refresh();
		} catch (e) {
			toast.error(said(e, 'The star could not be changed.'));
		}
	}

	function menuOf(n: NoteRow): MenuItem[] {
		const items: MenuItem[] = [];
		if (data.canWrite)
			items.push({
				label: 'Move to',
				icon: FolderInput,
				onselect: () => askMove({ kind: 'note', note: n })
			});
		if (data.canDelete)
			items.push({
				label: 'Move to the trash',
				icon: Trash,
				danger: true,
				onselect: () => trashNote(n)
			});
		return items;
	}
</script>

<svelte:head><title>Notes, {projectName}</title></svelte:head>

{#snippet tree(pick?: () => void)}
	<FolderTree
		{folders}
		{active}
		{hrefFor}
		total={data.total}
		canWrite={data.canWrite}
		canDelete={data.canDelete}
		onrename={(folder) => ask({ kind: 'rename', folder })}
		onmove={(folder) => askMove({ kind: 'folder', folder })}
		ontrash={trashFolder}
		ondropped={dropped}
		onpick={pick}
	/>
	{#if data.canWrite}
		<Button
			class="mt-3 w-full justify-start"
			onclick={() => ask({ kind: 'folder' })}
			data-testid="new-folder"
		>
			<FolderPlus size={16} /> New folder
		</Button>
	{/if}
{/snippet}

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title="Notes"
		context={`${data.total} ${data.total === 1 ? 'note' : 'notes'}. What belongs to no single plan: how things work, ideas, research. Your coding tools can read them.`}
	>
		{#snippet actions()}
			{#if data.canWrite}
				<Button variant="primary" onclick={() => ask({ kind: 'note' })} data-testid="new-note">
					<Plus size={16} /> New note
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.denied}
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="the notes" />
	{:else}
		<!-- THE TREE BESIDE THE LIST, WITH THE GRID OF THE SETTINGS PAGES. BELOW md THE TREE OPENS FROM THE FOLDERS BUTTON -->
		<div class="grid gap-6 md:grid-cols-[240px_minmax(0,1fr)] md:gap-10">
			<aside
				class="min-w-0 max-md:hidden md:sticky md:top-24 md:self-start"
				data-testid="notes-tree"
			>
				{@render tree()}
			</aside>

			<section class="flex min-w-0 flex-col gap-4" aria-label={heading}>
				<!-- ONE TOOLBAR CARD, AS ON THE TASKS AND MOCKUPS PAGES -->
				<div
					class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5"
				>
					<Button class="md:hidden" onclick={() => (drawer = true)} data-testid="folders-button">
						<FolderTreeIcon size={16} /> Folders
					</Button>
					<div class="min-w-56 flex-1 sm:max-w-80">
						<TextField
							label="Search notes"
							icon={Search}
							hideLabel
							placeholder="Search titles and text"
							type="search"
							bind:value={q}
							oninput={typed}
							data-testid="notes-q"
						/>
					</div>
				</div>

				<div class="flex min-w-0 flex-col gap-0.5">
					<!-- A folder deep in the tree shows the way to it as words -->
					{#if trail.length > 1}
						<p class="truncate text-xs text-muted">
							{trail
								.slice(0, -1)
								.map((c) => c.name)
								.join(' / ')}
						</p>
					{/if}
					<h2 class="truncate text-lg leading-7 font-semibold text-ink">{heading}</h2>
				</div>

				{#if data.notes.length === 0}
					<div
						class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
						data-testid="notes-empty"
					>
						<EmptyState kind={empty.kind} title={empty.title} text={empty.text}>
							{#snippet action()}
								{#if view.q}
									<Button onclick={clearSearch}>Clear the search</Button>
								{:else if empty.create}
									<!-- The page's one primary button is in the header; this one is plain -->
									<Button onclick={() => ask({ kind: 'note' })}><Plus size={16} /> New note</Button>
								{/if}
							{/snippet}
						</EmptyState>
					</div>
				{:else}
					<ul
						class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
						data-testid="note-list"
					>
						{#each data.notes as n (n.id)}
							{@const menu = menuOf(n)}
							<li
								class="flex min-h-14 items-center gap-x-3 border-b border-line px-4 py-2 last:border-b-0"
								data-row
								data-testid="note"
								draggable={data.canWrite}
								ondragstart={(e) => e.dataTransfer?.setData(NOTE_TYPE, n.ref)}
							>
								<a
									href={`${base}/notes/${n.ref}`}
									class="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center focus-visible:outline-2 focus-visible:outline-accent"
								>
									<span class="flex min-w-0 items-center gap-2">
										<span class="truncate text-sm font-medium text-ink hover:underline"
											>{n.title}</span
										>
										{#if n.private}
											<Badge><Lock size={12} /> Private</Badge>
										{/if}
									</span>
									<span class="truncate text-xs text-muted">
										<span class="font-mono">{n.ref}</span>
										{#if view.view !== 'folder' && n.folderId}
											· {folderNameOf.get(n.folderId) ?? ''}
										{/if}
										{#if n.preview.trim()}
											· {n.preview.replace(/\s+/g, ' ').trim()}
										{/if}
									</span>
								</a>
								<span class="w-20 shrink-0 text-right text-xs text-muted tabular-nums max-sm:hidden"
									>{ago(n.updatedAt)}</span
								>
								<button
									type="button"
									aria-label={n.favourite ? `Remove the star from ${n.title}` : `Star ${n.title}`}
									aria-pressed={n.favourite}
									onclick={() => star(n)}
									class="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:size-11"
								>
									<Star size={18} class={cn(n.favourite && 'fill-current text-warning')} />
								</button>
								{#if menu.length}
									<ActionMenu items={menu} label={`Actions for ${n.title}`} size="sm" />
								{/if}
							</li>
						{/each}
					</ul>
					{#if data.more}
						<p class="text-sm text-muted">
							Only the 200 newest are shown. Search, or open a folder, to see the rest.
						</p>
					{/if}
				{/if}
			</section>
		</div>
	{/if}
</PageFrame>

<!-- THE TREE ON A PHONE -->
<ResponsiveModal open={drawer} onclose={() => (drawer = false)} title="Folders" variant="drawer">
	{@render tree(() => (drawer = false))}
</ResponsiveModal>

<NameDialog
	open={namingOpen}
	onclose={() => (namingOpen = false)}
	title={nameDialog.title}
	label={nameDialog.label}
	confirm={nameDialog.confirm}
	hint={nameDialog.hint}
	initial={nameDialog.initial}
	maxlength={nameDialog.max}
	onsave={saveName}
/>

<MoveDialog
	open={movingOpen}
	onclose={() => (movingOpen = false)}
	{folders}
	what={moving?.kind === 'note' ? moving.note.title : (moving?.folder.name ?? '')}
	movingFolderId={moving?.kind === 'folder' ? moving.folder.id : null}
	current={moving?.kind === 'note' ? moving.note.folderId : (moving?.folder.parentId ?? null)}
	onmove={saveMove}
/>
