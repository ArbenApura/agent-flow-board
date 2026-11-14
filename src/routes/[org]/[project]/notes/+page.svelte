<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED TYPES
	import type { Folder } from '#lib/board/notes/tree.js';
	import type { MenuItem } from '#lib/ui/ActionMenu.svelte';
	// IMPORTED ENVS
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { crumbs, moveRefusal } from '#lib/board/notes/tree.js';
	import {
		activeOf,
		emptyNotes,
		groupByWhen,
		notesHref,
		notesLayoutCookie,
		readNotesLayout,
		type NotesLayout
	} from '#lib/board/notes/view.js';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import List from '@lucide/svelte/icons/list';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Trash from '@lucide/svelte/icons/trash';
	// IMPORTED COMPONENTS
	import FolderTree from '#lib/board/notes/FolderTree.svelte';
	import MoveDialog from '#lib/board/notes/MoveDialog.svelte';
	import NameDialog from '#lib/board/notes/NameDialog.svelte';
	import NoteCard from '#lib/board/notes/NoteCard.svelte';
	import NoteRow from '#lib/board/notes/NoteRow.svelte';
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- TYPES -- //

	type NoteRowData = PageProps['data']['notes'][number];
	/** The dialog that is open. Its data is kept while it closes, so the words do not flash blank. */
	type Naming = { kind: 'note' } | { kind: 'folder' } | { kind: 'rename'; folder: Folder };
	type Moving = { kind: 'note'; note: NoteRowData } | { kind: 'folder'; folder: Folder };

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
	/** The layout the person chose on this page, which shows at once while the cookie is on its way to the server. */
	let chosen = $state<NotesLayout | null>(null);

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
	// The choice made on this page wins at once, then an explicit layout in the address (a shared link), then the cookie the server read, then the list
	const layout = $derived(chosen ?? readNotesLayout(page.url.searchParams, data.savedLayout));
	// A search is one list; every other view is grouped by when the notes changed
	const groups = $derived(view.q ? [{ label: '', notes: data.notes }] : groupByWhen(data.notes));
	const count = $derived(
		view.q
			? data.notes.length
			: view.view === 'favourites'
				? data.favourites
				: view.view === 'folder'
					? (here?.notes ?? data.notes.length)
					: data.total
	);
	const context = $derived(
		`${data.total} ${data.total === 1 ? 'note' : 'notes'} in ${folders.length} ${folders.length === 1 ? 'folder' : 'folders'}. Ideas, research and how things work, outside any one plan. Your coding tools can read them.`
	);
	const folderMenu = $derived<MenuItem[]>(here ? folderMenuOf(here) : []);
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

	// -- REACTIVE STATEMENTS -- //

	// A link that changes the search (a tree row, Back) shows its words in the box, unless the person is typing
	$effect(() => {
		const fromAddress = view.q;
		untrack(() => {
			if (searchTimer === undefined && fromAddress !== q.trim()) q = fromAddress;
		});
	});

	// -- FUNCTIONS -- //

	const hrefFor = (target: string) => notesHref(base, target, target === active ? view.q : '');

	/** Keeps the choice in the cookie, shows it at once and drops layout from the address so the cookie decides from now on. */
	function chooseLayout(next: NotesLayout) {
		chosen = next;
		try {
			document.cookie = notesLayoutCookie(next);
		} catch {
			// A page that may not set cookies (a sandboxed frame) still switches the view for this visit
		}
		if (page.url.searchParams.has('layout'))
			void goto(notesHref(base, active, view.q), { replace: true, reset: false });
	}
	/** The folder a note sits in, shown in the views that hold more than one folder. */
	const folderOf = (n: NoteRowData) =>
		view.view !== 'folder' && n.folderId ? (folderNameOf.get(n.folderId) ?? '') : '';

	/** The actions of the open folder, the same as its row in the tree. */
	function folderMenuOf(f: Folder): MenuItem[] {
		const items: MenuItem[] = [];
		if (data.canWrite) {
			items.push({
				label: 'Rename',
				icon: Pencil,
				onselect: () => ask({ kind: 'rename', folder: f })
			});
			items.push({
				label: 'Move to',
				icon: FolderInput,
				onselect: () => askMove({ kind: 'folder', folder: f })
			});
		}
		if (data.canDelete)
			items.push({
				label: 'Move to the trash',
				icon: Trash,
				danger: true,
				onselect: () => trashFolder(f)
			});
		return items;
	}
	const refresh = () => invalidate('afb:project');
	const said = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

	const typed = () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchTimer = undefined;
			void goto(notesHref(base, active, q), {
				replace: true,
				// Typing must not jump the page or lose the cursor
				reset: false
			});
		}, 250);
	};

	function clearSearch() {
		q = '';
		void goto(notesHref(base, active, ''), { replace: true });
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

	async function trashNote(n: NoteRowData) {
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

	async function star(n: NoteRowData) {
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

	function menuOf(n: NoteRowData): MenuItem[] {
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
		favourites={data.favourites}
		canWrite={data.canWrite}
		canDelete={data.canDelete}
		onrename={(folder) => ask({ kind: 'rename', folder })}
		onmove={(folder) => askMove({ kind: 'folder', folder })}
		ontrash={trashFolder}
		ondropped={dropped}
		onpick={pick}
		onnewfolder={() => {
			pick?.();
			ask({ kind: 'folder' });
		}}
	/>
{/snippet}

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader class="mb-2!" title="Notes" {context}>
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
		<!-- THE TREE CARD BESIDE THE LIST FROM lg: 288 FROM lg AND 320 FROM xl, SO A FOLDER NAME STAYS ON ONE LINE (WAS 256) (AFB-20261111-1344). BELOW lg THE TREE OPENS FROM THE FOLDERS BUTTON -->
		<div class="grid gap-6 lg:grid-cols-[288px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
			<aside
				class="min-w-0 max-lg:hidden lg:sticky lg:top-[73px] lg:max-h-[calc(100dvh-89px)] lg:self-start lg:overflow-y-auto"
				data-testid="notes-tree"
			>
				{@render tree()}
			</aside>

			<section class="flex min-w-0 flex-col gap-4" aria-label={heading}>
				<!-- ONE TOOLBAR CARD, AS ON THE TASKS AND MOCKUPS PAGES: FOLDERS, SEARCH AND THE LIST OR CARDS SWITCH -->
				<div
					class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5"
				>
					<Button
						class="max-sm:w-11 max-sm:px-0 lg:hidden"
						onclick={() => (drawer = true)}
						aria-label="Folders"
						data-testid="folders-button"
					>
						<FolderTreeIcon size={16} /><span class="max-sm:sr-only">Folders</span>
					</Button>
					<div class="min-w-40 flex-1 sm:max-w-80">
						<TextField
							label="Search notes"
							icon={Search}
							hideLabel
							placeholder="Search notes"
							type="search"
							bind:value={q}
							oninput={typed}
							data-testid="notes-q"
						/>
					</div>
					<span class="ml-auto flex items-center">
						<SegmentedControl
							label="View"
							value={layout}
							compactOnPhone
							options={[
								{ value: 'list', label: 'List', icon: List },
								{ value: 'cards', label: 'Cards', icon: LayoutGrid }
							]}
							onchange={(v) => chooseLayout(v === 'cards' ? 'cards' : 'list')}
						/>
					</span>
				</div>

				<!-- THE HEADING ROW: THE WAY TO THE FOLDER AS LINKS, ITS NAME AND COUNT, AND ITS ACTIONS -->
				<div class="flex min-h-10 min-w-0 items-end justify-between gap-3">
					<div class="flex min-w-0 flex-col">
						{#if view.view === 'folder' && here}
							<nav
								aria-label="Folder path"
								class="flex min-w-0 items-center gap-1 text-xs text-muted"
							>
								<a
									href={hrefFor('all')}
									class="shrink-0 cursor-pointer hover:text-ink hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
									>Notes</a
								>
								<span aria-hidden="true">/</span>
								{#each trail.slice(0, -1) as c (c.id)}
									<a
										href={hrefFor(c.id)}
										class="max-w-48 cursor-pointer truncate hover:text-ink hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
										>{c.name}</a
									>
									<span aria-hidden="true">/</span>
								{/each}
							</nav>
						{/if}
						<h2
							class="flex min-w-0 items-baseline gap-2 text-lg leading-7 font-semibold text-ink"
							data-testid="notes-heading"
						>
							<span class="truncate">{heading}</span>
							<span class="shrink-0 font-sans text-sm font-normal text-muted tabular-nums"
								>{count}</span
							>
						</h2>
					</div>
					{#if here && folderMenu.length}
						<ActionMenu items={folderMenu} label={`Actions for ${here.name}`} />
					{/if}
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
				{:else if layout === 'cards'}
					<!-- CARDS, ON THE MOCKUPS PAGE GRID -->
					<div
						class="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3"
						data-testid="note-cards"
					>
						{#each data.notes as n (n.id)}
							<NoteCard
								note={n}
								href={`${base}/notes/${n.ref}`}
								folder={folderOf(n)}
								onstar={() => star(n)}
							/>
						{/each}
					</div>
				{:else}
					<!-- ONE LIST CARD. A SEARCH IS ONE LIST; OTHERWISE THE ROWS ARE GROUPED BY WHEN THEY CHANGED -->
					<div
						class="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
						data-testid="note-list"
					>
						{#each groups as g, i (g.label)}
							<section aria-labelledby={g.label === '' ? undefined : `notes-group-${i}`}>
								{#if g.label}
									<h3
										id={`notes-group-${i}`}
										class={cn(
											'border-b border-line bg-raised/50 px-4 py-1.5 text-xs font-medium text-muted max-sm:px-3.5',
											i > 0 && 'border-t'
										)}
									>
										{g.label}
									</h3>
								{/if}
								<ul>
									{#each g.notes as n (n.id)}
										<NoteRow
											note={n}
											href={`${base}/notes/${n.ref}`}
											folder={folderOf(n)}
											menu={menuOf(n)}
											onstar={() => star(n)}
											draggable={data.canWrite}
											ondragstart={(e) => e.dataTransfer?.setData(NOTE_TYPE, n.ref)}
										/>
									{/each}
								</ul>
							</section>
						{/each}
					</div>
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
