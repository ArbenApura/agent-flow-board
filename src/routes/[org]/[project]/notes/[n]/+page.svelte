<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type * as Y from 'yjs';
	// -- TYPES -- //
	import type { Folder } from '#lib/board/notes/tree.js';
	import type { CreateKind } from '#lib/shared/continue.js';
	import type { MenuItem } from '#lib/ui/ActionMenu.svelte';
	// -- ENVS -- //
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { onMount, untrack } from 'svelte';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { markdownOfDoc } from '#lib/board/notes/editorMarkdown.js';
	import {
		liveSnapshot,
		nextSession,
		sessionKey,
		type NoteSnapshot,
		type Session
	} from '#lib/board/notes/session.js';
	import { crumbs } from '#lib/board/notes/tree.js';
	import { notesHref } from '#lib/board/notes/view.js';
	import { ago } from '#lib/board/status.js';
	import { onNoteLive } from '#lib/realtime/stream.svelte.js';
	import {
		CARET_COLOUR,
		liveLine,
		openLiveNote,
		type LiveStatus,
		type NoteProvider,
		type Peer
	} from '#lib/realtime/noteProvider.js';
	import { httpTransport } from '#lib/realtime/noteTransport.js';
	import { parseMode, parseTool } from '#lib/shared/continue.js';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import ClipboardList from '@lucide/svelte/icons/clipboard-list';
	import FileClock from '@lucide/svelte/icons/file-clock';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Lock from '@lucide/svelte/icons/lock';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Star from '@lucide/svelte/icons/star';
	import Trash from '@lucide/svelte/icons/trash';
	// -- COMPONENTS -- //
	import ContinueDialog from '#lib/board/ContinueDialog.svelte';
	import LinksPanel from '#lib/board/notes/LinksPanel.svelte';
	import MoveDialog from '#lib/board/notes/MoveDialog.svelte';
	import NoteEditorSkeleton from '#lib/board/notes/NoteEditorSkeleton.svelte';
	import NoteHistoryDrawer from '#lib/board/notes/NoteHistoryDrawer.svelte';
	import NoteShareDrawer from '#lib/board/notes/NoteShareDrawer.svelte';
	import PresenceStack from '#lib/board/notes/PresenceStack.svelte';
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import OfflineBanner from '#lib/ui/OfflineBanner.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	/** Quiet time after the last keystroke in the title before it is saved. */
	const TITLE_MS = 800;

	// -- STATES -- //

	let movingOpen = $state(false);
	let historyOpen = $state(false);
	let shareOpen = $state(false);
	let turnOpen = $state(false);
	/** Which hand-over the dialog shows: a plan or tasks made from this note. It stays while the dialog slides out. */
	let turnKind = $state<CreateKind>('plan');
	let busy = $state(false);
	// The editing session and what it holds live here, apart from the page data, so reading the page data again never rewrites the screen
	let session = $state.raw<Session | null>(null);
	/** The live document of the open note and the network provider on it. Null until the first open rule has run. */
	let live = $state.raw<{ id: number; provider: NoteProvider; ydoc: Y.Doc } | null>(null);
	let liveStatus = $state<LiveStatus>('saved');
	/** The other people who have this note open. */
	let peers = $state.raw<Peer[]>([]);
	/** The words when the note could not be opened for live editing. */
	let openError = $state('');
	/** Someone changed the text from outside while it was open: who, and what the person had on screen. */
	let replaced = $state.raw<{ by: string; mine: string } | null>(null);
	/** The provider found the note trashed or closed to this person. */
	let lostAccess = $state(false);
	let titleDraft = $state('');
	// Plain bookkeeping that never draws anything: which open is the current one, the text kept from before a replacement, the title save
	let liveId = 0;
	let openToken = 0;
	let carried: string | null = null;
	let titleTimer: ReturnType<typeof setTimeout> | undefined;
	let titleSent = '';
	let titlePath = '';
	let editorLoad = $state.raw<Promise<typeof import('#lib/board/notes/NoteEditor.svelte')> | null>(
		null
	);

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const note = $derived(data.note);
	const folders = $derived(data.folders as Folder[]);
	const trail = $derived(crumbs(folders, note?.folderId ?? null));
	const projectName = $derived(data.summary?.project.name ?? key);
	const context = $derived(
		note
			? `${note.ref} · ${data.author ? `by ${data.author}, ` : ''}changed ${ago(note.updatedAt)}`
			: ''
	);

	/** What the page data says about the text, for a person who can write. Null for a reader or a note that is gone. */
	const snapshot = $derived<NoteSnapshot | null>(liveSnapshot(note, data.canWrite, data.markdown));
	const gone = $derived(data.gone || !note || lostAccess);
	/** Who this window is, for the other windows' cursors and the avatar row. */
	const me = $derived({
		id: data.me?.id ?? '',
		name: data.me?.name ?? 'Someone',
		...(data.me?.imageV ? { v: data.me.imageV } : {})
	});

	// -- REACTIVE STATEMENTS -- //

	// Fresh page data keeps the open session when the note and epoch are the same. Only another note or a new epoch opens a new one
	$effect(() => {
		const incoming = snapshot;
		untrack(() => {
			const step = nextSession(session, incoming);
			if (!step) closeSession();
			else if (step.kind === 'open') openSession(step.session);
		});
	});

	// A title changed elsewhere shows here when this person is not typing in the title and has no unsent edit
	$effect(() => {
		const fresh = note?.title;
		untrack(() => {
			if (fresh === undefined || !session || fresh === titleSent) return;
			if (titleTimer !== undefined || titleDraft.trim() !== titleSent) return;
			const field = document.querySelector('[data-testid="note-title"]');
			if (field && (field === document.activeElement || field.contains(document.activeElement)))
				return;
			titleDraft = fresh;
			titleSent = fresh;
		});
	});

	// -- FUNCTIONS -- //

	const refresh = () => invalidate('afb:project');
	const said = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
	const path = (suffix = '') => `/projects/${key}/notes/${note?.ref ?? ''}${suffix}`;

	// -- EDITOR SESSION -- //

	/** The editor code is loaded on demand, once, the first time a person who can write opens a note. */
	const loadEditor = () => import('#lib/board/notes/NoteEditor.svelte');

	/**
	 * Opens a note for live editing: the first open rule gives the document, a provider moves it over the network. `replacing`
	 * means the same note got new text from outside (a new epoch): what the person had on screen is kept as Markdown and the
	 * editor is rebuilt from the new text.
	 */
	async function startLive(next: Session, replacing: boolean) {
		const token = ++openToken;
		if (replacing && live) carried = markdownOfDoc(live.ydoc);
		flushTitle();
		closeLive();
		const s = next.snapshot;
		session = next;
		titleDraft = s.title;
		titleSent = s.title;
		liveStatus = 'saved';
		openError = '';
		lostAccess = false;
		if (!replacing) replaced = null;
		editorLoad ??= loadEditor();
		try {
			const made = await openLiveNote({
				noteId: s.noteId,
				transport: httpTransport(org, key, note?.ref ?? ''),
				listen: onNoteLive,
				markdown: markdownOfDoc,
				// Only a title this window changed rides on a checkpoint, so a rename made elsewhere is never put back
				title: () => {
					const draft = titleDraft.trim();
					return draft && draft !== titleSent ? draft : undefined;
				},
				user: me,
				onStatus: (st) => {
					if (token === openToken) liveStatus = st;
				},
				onPeers: (list) => {
					if (token === openToken) peers = list;
				},
				onEpoch: () => {
					// The text was replaced from outside: the same note opens again on the new text
					if (token === openToken && session) void startLive(session, true);
				},
				onGone: () => {
					if (token !== openToken) return;
					lostAccess = true;
					closeLive();
				}
			});
			if (token !== openToken) {
				made.provider.destroy();
				made.opened.ydoc.destroy();
				return;
			}
			live = { id: ++liveId, provider: made.provider, ydoc: made.opened.ydoc };
			// The name of the session follows the epoch the server really answered with
			session = {
				key: sessionKey({ noteId: s.noteId, epoch: made.opened.epoch }),
				snapshot: { ...s, epoch: made.opened.epoch }
			};
			if (carried !== null) {
				const mine = carried;
				carried = null;
				void announceReplaced(mine);
			}
		} catch (e) {
			if (token !== openToken) return;
			openError =
				e instanceof Error && e.message
					? e.message
					: 'The note could not be opened for editing. Try again.';
		}
	}

	function openSession(next: Session) {
		const same = !!session && session.snapshot.noteId === next.snapshot.noteId;
		if (!same) carried = null;
		// Page data that is older than what this window already holds is not a replacement
		if (same && live && next.snapshot.epoch <= live.provider.epoch) return;
		void startLive(next, same);
	}

	/** Tries to open the note again after it could not be opened. */
	function retryOpen() {
		if (session) void startLive(session, false);
	}

	/** Lets go of the live document: what waits is sent with calls that outlive the page, the others are told this window left. */
	function closeLive() {
		const current = live;
		live = null;
		peers = [];
		if (!current) return;
		current.provider.leave();
		current.provider.destroy();
		current.ydoc.destroy();
	}

	/** Ends the editing session: a pending title goes out and the live document is let go. */
	function closeSession() {
		openToken++;
		carried = null;
		flushTitle();
		closeLive();
		session = null;
		replaced = null;
		openError = '';
		liveStatus = 'saved';
	}

	// -- TITLE -- //

	/** The title is its own small save: a checkpoint is refused when no text changed, so a title never rides on one alone. */
	async function sendTitle(target: string, title: string) {
		if (!title || title === titleSent) return;
		try {
			await api(org, target, { method: 'PATCH', body: { title } });
			titleSent = title;
		} catch (e) {
			toast.error(said(e, 'The title could not be saved. Try again.'));
		}
	}

	function flushTitle() {
		if (titleTimer === undefined) return;
		clearTimeout(titleTimer);
		titleTimer = undefined;
		void sendTitle(titlePath, titleDraft.trim());
	}

	function titleTyped() {
		clearTimeout(titleTimer);
		titlePath = path();
		titleTimer = setTimeout(() => {
			titleTimer = undefined;
			void sendTitle(titlePath, titleDraft.trim());
		}, TITLE_MS);
	}

	/** Says who changed the text from outside, once the new text is open. Nothing is shown when the person's own text matches it. */
	async function announceReplaced(mine: string) {
		let by = data.lastEditor ?? 'Someone';
		try {
			const got = await api<{ lastEditor: string | null }>(org, path('?full=true'));
			by = got.lastEditor ?? by;
		} catch {
			// The name stays what the page data held
		}
		const now = live ? markdownOfDoc(live.ydoc) : '';
		if (mine.trim() !== now.trim()) replaced = { by, mine };
	}

	/** Puts the text the person had on screen on the clipboard. */
	async function copyMine() {
		if (!replaced) return;
		try {
			await navigator.clipboard.writeText(replaced.mine);
			toast.success('Your text is copied.');
		} catch {
			toast.error('Your text could not be copied. Select it in the box below and copy it by hand.');
		}
	}

	async function star() {
		if (!note) return;
		try {
			await api(org, path('/favourite'), { method: 'PUT', body: { on: !data.favourite } });
			await refresh();
		} catch (e) {
			toast.error(said(e, 'The star could not be changed.'));
		}
	}

	/** Only the creator may switch it; the server refuses anyone else with the same words. */
	async function setPrivate(next: boolean) {
		if (!note || busy) return;
		busy = true;
		try {
			await api(org, path(), {
				method: 'PATCH',
				body: { visibility: next ? 'private' : 'public' }
			});
			toast.success(
				next ? 'Only you can see this note now.' : 'Everyone on the project can see it.'
			);
		} catch (e) {
			toast.error(said(e, 'The note could not be changed. Try again.'));
		} finally {
			busy = false;
			await refresh();
		}
	}

	async function moveTo(folderId: string | null): Promise<string | null> {
		try {
			await api(org, path(), { method: 'PATCH', body: { folderId } });
			await refresh();
			return null;
		} catch (e) {
			return said(e, 'The note could not be moved. Try again.');
		}
	}

	async function trash() {
		if (!note) return;
		const ok = await askConfirm({
			title: `Move "${note.title}" to the trash?`,
			body: 'It is hidden for everyone who could see it, and its public link stops. It can be restored from the Trash for 30 days.',
			confirmLabel: 'Move to the trash',
			tone: 'danger'
		});
		if (!ok) return;
		try {
			await api(org, path(), { method: 'DELETE' });
			toast.success('The note is in the trash.');
			await goto(notesHref(base, note.folderId ?? 'all'));
		} catch (e) {
			toast.error(said(e, 'The note could not be moved to the trash.'));
		}
	}

	function turnInto(kind: CreateKind) {
		turnKind = kind;
		turnOpen = true;
	}

	function menu(): MenuItem[] {
		const items: MenuItem[] = [];
		if (data.canWrite)
			items.push({ label: 'Move to', icon: FolderInput, onselect: () => (movingOpen = true) });
		items.push({ label: 'History', icon: FileClock, onselect: () => (historyOpen = true) });
		if (data.canManage)
			items.push({ label: 'Share', icon: Share2, onselect: () => (shareOpen = true) });
		if (data.canWrite) {
			items.push({
				label: 'Turn into a plan',
				icon: ClipboardList,
				onselect: () => turnInto('plan')
			});
			items.push({
				label: 'Turn into tasks',
				icon: ListChecks,
				onselect: () => turnInto('task')
			});
		}
		if (data.canDelete)
			items.push({ label: 'Move to the trash', icon: Trash, danger: true, onselect: trash });
		return items;
	}

	// -- LIFECYCLES -- //

	// Leaving the page sends what is unsent with calls that outlive it, and a closing tab asks first while something is unsent
	onMount(() => {
		const beforeUnload = (e: BeforeUnloadEvent) => {
			if (!live?.provider.unsent) return;
			// Only the prompt: the send belongs to pagehide, which runs when the person really leaves
			e.preventDefault();
		};
		// A page that goes away without asking (a phone tab closed) still gets a last checkpoint, best effort
		const pageHide = () => live?.provider.leave();
		addEventListener('beforeunload', beforeUnload);
		addEventListener('pagehide', pageHide);
		return () => {
			removeEventListener('beforeunload', beforeUnload);
			removeEventListener('pagehide', pageHide);
			closeSession();
		};
	});
</script>

<svelte:head><title>{note?.title ?? 'Note'}, {projectName}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	{#if data.denied}
		<PageHeader
			class="mb-2!"
			title="Note"
			back={{ href: `${base}/notes`, label: 'Back to Notes' }}
		/>
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="the notes" />
	{:else if gone || !note}
		<PageHeader
			class="mb-2!"
			title="Note"
			back={{ href: `${base}/notes`, label: 'Back to Notes' }}
		/>
		<div
			class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
			data-testid="note-gone"
		>
			<EmptyState
				kind="items"
				title="This note is no longer available"
				text="It was moved to the trash, or it was made private by the person who wrote it."
			>
				{#snippet action()}
					<Button href={`${base}/notes`}>Back to Notes</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<!-- NO PRIMARY BUTTON ON A NOTE PAGE. THE STAR, THE PRIVATE SWITCH AND THE MENU ARE PLAIN CONTROLS -->
		<PageHeader
			class="mb-2!"
			title={note.title}
			{context}
			back={{ href: notesHref(base, note.folderId ?? 'all'), label: 'Back to Notes' }}
		>
			{#snippet actions()}
				<div class="flex items-center gap-1">
					<!-- WHO ELSE HAS THE NOTE OPEN. ONLY A WINDOW THAT EDITS LIVE HAS ANY -->
					<PresenceStack {peers} />
					{#if note.private}
						<Badge><Lock size={12} /> Private</Badge>
					{/if}
					<button
						type="button"
						aria-label={data.favourite ? 'Remove the star' : 'Star this note'}
						aria-pressed={data.favourite}
						onclick={star}
						data-testid="note-star"
						class="inline-flex size-10 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:size-11"
					>
						<Star size={18} class={cn(data.favourite && 'fill-current text-warning')} />
					</button>
					{#if menu().length}
						<ActionMenu items={menu()} label="Actions for this note" />
					{/if}
				</div>
			{/snippet}
		</PageHeader>

		<!-- THE FOLDER THE NOTE LIVES IN, AS LINKS BACK UP THE TREE -->
		<nav aria-label="Folder" class="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted">
			<a href={notesHref(base, 'all')} class="cursor-pointer text-accent-text hover:underline"
				>Notes</a
			>
			{#each trail as c (c.id)}
				<span aria-hidden="true">/</span>
				<a
					href={notesHref(base, c.id)}
					class="max-w-48 cursor-pointer truncate text-accent-text hover:underline">{c.name}</a
				>
			{/each}
		</nav>

		{#if data.mine && data.canWrite}
			<div class="rounded-xl border border-line bg-surface px-4 shadow-[var(--elev-1)]">
				<Switch
					label="Only me"
					hint="Nobody else on the project can see or find this note."
					checked={note.private}
					disabled={busy}
					onchange={setPrivate}
				/>
			</div>
		{/if}

		{#if data.canWrite}
			<!-- A PERSON WHO CAN WRITE EDITS IN PLACE. THE EDITOR CODE LOADS ON DEMAND BEHIND A SKELETON OF ITS REAL SIZE -->
			{#if session}
				<!-- THE EDITOR SENDS ITS CHANGES ITSELF. COMING BACK ONLINE SENDS WHAT WAS KEPT AND READS WHAT WAS MISSED -->
				<OfflineBanner onreconnect={() => live?.provider.reconnect()} />
				<TextField
					label="Title"
					bind:value={titleDraft}
					maxlength={200}
					oninput={titleTyped}
					data-testid="note-title"
				/>
				{#if replaced}
					<!-- THE TEXT WAS CHANGED FROM OUTSIDE THE EDITOR. WHAT THE PERSON HAD ON SCREEN IS KEPT HERE UNTIL THEY LEAVE -->
					<Notice tone="warning" data-testid="note-replaced">
						<p class="font-medium">{replaced.by} changed the text of this note.</p>
						<p class="mt-1">
							The editor now shows the new text. The text saved before it is in History, and what
							you had on screen can be copied.
						</p>
						<div class="mt-2 flex flex-wrap gap-2">
							<Button size="sm" variant="secondary" onclick={() => (historyOpen = true)}
								>Open History</Button
							>
							<Button size="sm" variant="secondary" onclick={copyMine}>Copy my text</Button>
							<Button size="sm" variant="ghost" onclick={() => (replaced = null)}>Dismiss</Button>
						</div>
					</Notice>
				{/if}
				{#if live}
					{#key live.id}
						{#if editorLoad}
							{#await editorLoad}
								<NoteEditorSkeleton />
							{:then loaded}
								<loaded.default
									ydoc={live.ydoc}
									provider={live.provider.live}
									user={{ name: me.name, color: CARET_COLOUR }}
									locked={liveStatus === 'full' || liveStatus === 'toolarge'}
									{org}
									project={key}
									note={note.ref}
								/>
							{:catch}
								<Notice tone="danger"
									>The editor could not be loaded. Reload the page to try again.</Notice
								>
							{/await}
						{:else}
							<NoteEditorSkeleton />
						{/if}
					{/key}
					{#if liveStatus === 'full' || liveStatus === 'toolarge'}
						<Notice tone="danger" data-testid="note-full">{liveLine(liveStatus)}.</Notice>
					{/if}
					<p
						role="status"
						aria-live="polite"
						data-testid="note-save-line"
						class={cn(
							'text-sm',
							liveStatus === 'error' || liveStatus === 'full' || liveStatus === 'toolarge'
								? 'text-danger'
								: 'text-muted'
						)}
					>
						{liveLine(liveStatus)}
					</p>
				{:else if openError}
					<Notice tone="danger" data-testid="note-open-error">
						<p>{openError}</p>
						<div class="mt-2">
							<Button size="sm" variant="secondary" onclick={retryOpen}>Try again</Button>
						</div>
					</Notice>
				{:else}
					<NoteEditorSkeleton />
				{/if}
			{:else}
				<NoteEditorSkeleton />
			{/if}
		{:else}
			<article
				class="rounded-xl border border-line bg-surface p-5 shadow-[var(--elev-1)] max-sm:p-4"
				data-testid="note-body"
			>
				{#if data.empty}
					<p class="text-sm text-muted">This note has no text yet.</p>
				{:else}
					<!-- THE BODY IS MARKDOWN, SANITISED ON THE SERVER -->
					<div class="md flex flex-col gap-2 text-sm text-ink">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
						{@html data.html}
					</div>
				{/if}
			</article>
		{/if}

		<!-- WHAT THE NOTE LINKS TO AND WHICH NOTES MENTION IT. A GUEST SEES NO NOTES, SO NO PANEL -->
		<LinksPanel
			{org}
			project={key}
			note={{ id: note.id, ref: note.ref }}
			version={note.version}
			role={data.summary?.role}
			canWrite={data.canWrite}
		/>
	{/if}
</PageFrame>

<MoveDialog
	open={movingOpen}
	onclose={() => (movingOpen = false)}
	{folders}
	what={note?.title ?? ''}
	current={note?.folderId ?? null}
	onmove={moveTo}
/>

<!-- HISTORY: EARLIER TEXTS OF THE NOTE. A RESTORE READS THE PAGE AGAIN, AND A NEW EPOCH OPENS A FRESH EDITOR SESSION -->
<NoteHistoryDrawer
	open={historyOpen}
	onclose={() => (historyOpen = false)}
	{org}
	project={key}
	note={note?.ref ?? ''}
	canWrite={data.canWrite}
	onrestore={refresh}
/>

<!-- SHARE: THE PUBLIC LINK, FOR PEOPLE WHO MANAGE THE PROJECT -->
<NoteShareDrawer
	open={shareOpen}
	onclose={() => (shareOpen = false)}
	{org}
	project={key}
	note={note?.ref ?? ''}
	linkOn={data.publicEnabled}
	blocked={!!note?.private}
	canManage={data.canManage}
	onchange={refresh}
/>

<!-- TURN INTO A PLAN OR TASKS: THE SAME HAND-OFF AS NEW PLAN AND NEW TASK, STARTED FROM THIS NOTE -->
<ContinueDialog
	open={turnOpen}
	onclose={() => (turnOpen = false)}
	item={null}
	create={{ kind: turnKind, key, note: note?.ref }}
	tool={parseTool(data.continueTool)}
	mode={parseMode(data.continueMode)}
/>
