<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED TYPES
	import type { CaretProvider } from '#lib/board/notes/editorMarkdown.js';
	import type { LinkTarget, SlashId } from '#lib/board/notes/editorMenu.js';
	import type { MenuUpdate } from '#lib/board/notes/editorMenuPlugin.js';
	import type { MenuRow } from '#lib/board/notes/EditorMenu.svelte';
	import type { UploadedPicture } from '#lib/board/notes/pictureUpload.js';
	import type { Box } from '#lib/ui/position.js';
	// IMPORTED DEP-MODULES
	import { Editor } from '@tiptap/core';
	import { onMount } from 'svelte';
	import * as Y from 'yjs';
	// IMPORTED MODULES
	import { api, upload } from '#lib/board/api.js';
	import { TOOLS, applyLink, type Tool, type ToolId } from '#lib/board/notes/editorCommands.js';
	import {
		KIND_NAME,
		LinkSearch,
		filterSlash,
		insertLink,
		keyAction,
		optionId,
		runSlash,
		stepIndex
	} from '#lib/board/notes/editorMenu.js';
	import { editorExtensions } from '#lib/board/notes/editorMarkdown.js';
	import { EditorMenu, caretBox, dismissMenu } from '#lib/board/notes/editorMenuPlugin.js';
	import {
		PICTURE_ACCEPT,
		checkPicture,
		picturesOf,
		uploadPicture
	} from '#lib/board/notes/pictureUpload.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Bold from '@lucide/svelte/icons/bold';
	import Code from '@lucide/svelte/icons/square-code';
	import FileText from '@lucide/svelte/icons/file-text';
	import Heading1 from '@lucide/svelte/icons/heading-1';
	import Heading2 from '@lucide/svelte/icons/heading-2';
	import Heading3 from '@lucide/svelte/icons/heading-3';
	import Image from '@lucide/svelte/icons/image';
	import Italic from '@lucide/svelte/icons/italic';
	import LayoutTemplate from '@lucide/svelte/icons/layout-template';
	import LinkIcon from '@lucide/svelte/icons/link';
	import List from '@lucide/svelte/icons/list';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import ListOrdered from '@lucide/svelte/icons/list-ordered';
	import Minus from '@lucide/svelte/icons/minus';
	import Quote from '@lucide/svelte/icons/quote';
	import Redo from '@lucide/svelte/icons/redo-2';
	import SquareCheckBig from '@lucide/svelte/icons/square-check-big';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import TableIcon from '@lucide/svelte/icons/table';
	import Undo from '@lucide/svelte/icons/undo-2';
	import X from '@lucide/svelte/icons/x';
	// IMPORTED COMPONENTS
	import EditorMenuList from '#lib/board/notes/EditorMenu.svelte';
	import Button from '#lib/ui/Button.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		ydoc,
		provider,
		user,
		locked = false,
		org,
		project,
		note
	}: {
		/** The live Yjs document the editor is bound to. The page owns it (and the network provider on it) and destroys it. */
		ydoc: Y.Doc;
		/** Carries the cursors of the other windows. Only its awareness is used here. */
		provider: CaretProvider;
		/** Who this window is, shown to the others on the caret. The colour is always a token. */
		user: { name: string; color: string };
		/** True when the note takes no more typing (its live text is full). The text stays on screen and readable. */
		locked?: boolean;
		/** The org slug, for the link search and for showing stored pictures. */
		org: string;
		/** The project key. */
		project: string;
		/** The reference of this note (N-12), where its pictures are uploaded. */
		note: string;
	} = $props();

	// -- TYPES -- //

	interface UploadLine {
		id: number;
		state: 'waiting' | 'uploading' | 'error';
		text: string;
	}

	// -- CONSTANTS -- //

	const uid = $props.id();
	const menuId = `${uid}-menu`;

	const ICONS: Record<ToolId, Component<{ size?: number }>> = {
		undo: Undo,
		redo: Redo,
		h1: Heading1,
		h2: Heading2,
		h3: Heading3,
		bold: Bold,
		italic: Italic,
		bullet: List,
		ordered: ListOrdered,
		task: ListChecks,
		quote: Quote,
		code: Code,
		table: TableIcon,
		link: LinkIcon,
		picture: Image
	};

	const SLASH_ICONS: Record<SlashId, Component<{ size?: number }>> = {
		h1: Heading1,
		h2: Heading2,
		h3: Heading3,
		bullet: List,
		ordered: ListOrdered,
		task: ListChecks,
		quote: Quote,
		code: Code,
		table: TableIcon,
		picture: Image,
		divider: Minus
	};

	const KIND_ICONS: Record<LinkTarget['kind'], Component<{ size?: number }>> = {
		item: FileText,
		task: SquareCheckBig,
		mockup: LayoutTemplate,
		note: StickyNote
	};

	// -- STATES -- //

	let host = $state<HTMLDivElement>();
	let editor = $state.raw<Editor | null>(null);
	/** Counts editor transactions, so the toolbar reads the cursor and the undo stack again. */
	let tick = $state(0);
	let linkOpen = $state(false);
	let linkUrl = $state('');
	let linkError = $state('');
	// The open menu: what the typing asks for, where the caret is, which row is lit and what the link search found
	let trigger = $state.raw<MenuUpdate | null>(null);
	let anchor = $state.raw<Box | null>(null);
	let index = $state(0);
	let targets = $state.raw<LinkTarget[]>([]);
	let searching = $state(false);
	let searchFailed = $state(false);
	// Pictures on their way, and the lines that say so
	let lines = $state<UploadLine[]>([]);
	let picker = $state<HTMLInputElement>();

	// -- REACTIVE STATES -- //

	const slashRows = $derived(trigger?.kind === 'slash' ? filterSlash(trigger.query) : []);
	const rows = $derived.by<MenuRow[]>(() => {
		if (trigger?.kind === 'slash')
			return slashRows.map((s) => ({
				key: s.id,
				label: s.label,
				hint: s.hint,
				icon: SLASH_ICONS[s.id]
			}));
		if (trigger?.kind === 'link')
			return targets.map((t) => ({
				key: `${t.kind}:${t.id}`,
				label: t.title || t.ref || 'Untitled',
				ref: t.ref,
				tag: KIND_NAME[t.kind],
				icon: KIND_ICONS[t.kind]
			}));
		return [];
	});
	const status = $derived(
		trigger?.kind === 'link' && rows.length === 0
			? searchFailed
				? 'The search did not work. Keep typing to try again.'
				: searching
					? 'Searching...'
					: 'Nothing found.'
			: ''
	);
	const menuOpen = $derived(!!trigger && (rows.length > 0 || status !== ''));

	// -- REACTIVE STATEMENTS -- //

	// The editor names the open menu and its lit row, so a screen reader follows the list while focus stays in the text
	$effect(() => {
		const dom = editor?.view.dom;
		if (!dom) return;
		if (menuOpen && rows.length > 0) {
			dom.setAttribute('aria-controls', menuId);
			dom.setAttribute('aria-activedescendant', optionId(menuId, index));
		} else {
			dom.removeAttribute('aria-controls');
			dom.removeAttribute('aria-activedescendant');
		}
	});

	// A note over its live limit takes no more typing, and takes it again if the page says so
	$effect(() => {
		const e = editor;
		const off = locked;
		if (e && !e.isDestroyed && e.isEditable === off) e.setEditable(!off);
	});

	// The menu follows the caret when the page scrolls or the window changes size
	$effect(() => {
		const t = trigger;
		if (!t) return;
		const follow = () => {
			if (editor && !editor.isDestroyed) anchor = caretBox(editor.view, t.to);
		};
		addEventListener('scroll', follow, true);
		addEventListener('resize', follow);
		return () => {
			removeEventListener('scroll', follow, true);
			removeEventListener('resize', follow);
		};
	});

	// -- FUNCTIONS -- //

	/** One toolbar button's state, read from the editor. */
	function stateOf(tool: Tool) {
		void tick;
		const e = editor;
		if (!e || e.isDestroyed) return { active: false, enabled: false };
		return { active: tool.active?.(e) ?? false, enabled: tool.enabled ? tool.enabled(e) : true };
	}

	function press(tool: Tool) {
		const e = editor;
		if (!e) return;
		if (tool.id === 'link') {
			linkUrl = (e.getAttributes('link').href as string | undefined) ?? '';
			linkError = '';
			linkOpen = !linkOpen;
			return;
		}
		if (tool.id === 'picture') {
			openPicker();
			return;
		}
		tool.run(e);
	}

	function submitLink(event: SubmitEvent) {
		event.preventDefault();
		if (!editor) return;
		if (applyLink(editor, linkUrl)) {
			linkOpen = false;
			linkError = '';
		} else linkError = 'Use a web address, a mail address or a board link such as afb:note/N-12.';
	}

	// -- MENUS -- //

	const search = new LinkSearch(
		async (q) =>
			(
				await api<{ targets: LinkTarget[] }>(
					org,
					`/projects/${project}/notes/link-targets?q=${encodeURIComponent(q)}`
				)
			).targets,
		(result) => {
			if ('error' in result) {
				targets = [];
				searchFailed = true;
			} else {
				targets = result.targets;
				searchFailed = false;
			}
			searching = false;
			index = 0;
		}
	);

	/** The plugin reports what the typing asks for. A new link menu searches at once, a longer word after a short wait. */
	function onMenuUpdate(next: MenuUpdate | null) {
		const prev = trigger;
		trigger = next;
		if (!next) {
			search.cancel();
			searching = false;
			return;
		}
		anchor = next.box;
		if (next.kind === 'link') {
			const fresh = prev?.kind !== 'link';
			if (fresh) {
				targets = [];
				searchFailed = false;
			}
			if (fresh || prev?.query !== next.query) {
				searching = true;
				search.ask(next.query, fresh);
			}
		} else if (prev?.kind !== 'slash' || prev.query !== next.query) index = 0;
	}

	/** Every key goes to the menu first. It takes the arrows, Enter, Tab and Escape while a row can be picked or the menu can close. */
	function onMenuKey(event: KeyboardEvent): boolean {
		if (!menuOpen) return false;
		const action = keyAction(event, rows.length);
		if (!action) return false;
		if (action === 'next') index = stepIndex(index, rows.length, 1);
		else if (action === 'prev') index = stepIndex(index, rows.length, -1);
		else if (action === 'pick') pick(index);
		else dismiss();
		event.preventDefault();
		return true;
	}

	/** Closes the menu for this trigger. It stays closed until the person types a new one. */
	function dismiss() {
		const t = trigger;
		if (!t || !editor) return;
		dismissMenu(editor, t.from);
		trigger = null;
		search.cancel();
		searching = false;
	}

	function pick(i: number) {
		const t = trigger;
		const e = editor;
		if (!t || !e) return;
		const range = { from: t.from, to: t.to };
		trigger = null;
		search.cancel();
		searching = false;
		if (t.kind === 'slash') {
			const item = slashRows[i];
			if (item) runSlash(e, item.id, range, { pickPicture: openPicker });
		} else {
			const target = targets[i];
			if (target) insertLink(e, range, target);
		}
	}

	// -- PICTURES -- //

	let lineId = 0;
	/** Pictures go up one after another: the server allows two at once and a long list should not use them both. */
	let queue: Promise<void> = Promise.resolve();

	const openPicker = () => picker?.click();

	const nameOf = (file: File) => file.name || 'Picture';

	function setLine(id: number, patch: Partial<UploadLine>) {
		lines = lines.map((l) => (l.id === id ? { ...l, ...patch } : l));
	}

	/** Puts a stored picture into the text at a position, or at the cursor. */
	function insertPicture(fileId: string, at?: number) {
		const e = editor;
		if (!e || e.isDestroyed) return;
		const node = { type: 'image', attrs: { src: `afb:file/${fileId}`, alt: '' } };
		const chain = e.chain().focus();
		if (at === undefined) chain.insertContent(node);
		else chain.insertContentAt(Math.min(at, e.state.doc.content.size), node);
		chain.run();
	}

	async function sendOne(id: number, file: File, at: number | undefined) {
		setLine(id, { state: 'uploading', text: `Uploading ${nameOf(file)}...` });
		const outcome = await uploadPicture(file, (f) =>
			upload<UploadedPicture>(org, `/projects/${project}/notes/${note}/files`, f, {})
		);
		if (outcome.ok) {
			lines = lines.filter((l) => l.id !== id);
			insertPicture(outcome.id, at);
		} else setLine(id, { state: 'error', text: `${nameOf(file)}: ${outcome.line}` });
	}

	/** Checks each file at once, so a wrong one is named before anything is sent, then sends the rest in turn. */
	function addFiles(files: File[], at?: number) {
		for (const file of files) {
			const id = ++lineId;
			const refused = checkPicture(file);
			if (refused) {
				lines = [...lines, { id, state: 'error', text: `${nameOf(file)}: ${refused}` }];
				continue;
			}
			lines = [...lines, { id, state: 'waiting', text: `Waiting to upload ${nameOf(file)}...` }];
			queue = queue.then(() => sendOne(id, file, at));
		}
	}

	function pickedFiles(event: Event & { currentTarget: HTMLInputElement }) {
		const input = event.currentTarget;
		addFiles(Array.from(input.files ?? []));
		// Cleared, so choosing the same file again still fires
		input.value = '';
	}

	// -- LIFECYCLES -- //

	// The editor exists in the browser only and is destroyed when the person leaves. Its Yjs document belongs to the page and
	// already holds the note's text (the first open rule put it there), so opening a note is not something Undo can take back
	onMount(() => {
		if (!host) return;
		const instance = new Editor({
			element: host,
			editable: !locked,
			extensions: [
				...editorExtensions({
					ydoc,
					provider,
					user,
					org,
					placeholder:
						'Write something. Type / for blocks, @ to link a plan, task, mockup or note, # for a heading.'
				}),
				EditorMenu.configure({ onUpdate: onMenuUpdate, onKey: onMenuKey })
			],
			editorProps: {
				attributes: {
					class: 'md text-ink focus:outline-none',
					role: 'textbox',
					'aria-multiline': 'true',
					'aria-haspopup': 'listbox',
					'aria-label': 'Note text'
				},
				handlePaste: (_view, event) => {
					const data = event.clipboardData;
					const files = picturesOf(data?.files, { hasText: !!data?.getData('text/plain') });
					if (!files.length) return false;
					event.preventDefault();
					addFiles(files);
					return true;
				},
				handleDrop: (view, event, _slice, moved) => {
					const files = Array.from(event.dataTransfer?.files ?? []);
					if (moved || !files.length) return false;
					event.preventDefault();
					const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
					addFiles(files, at);
					return true;
				}
			},
			onTransaction: () => (tick += 1)
		});
		editor = instance;
		return () => {
			search.cancel();
			editor = null;
			instance.destroy();
		};
	});
</script>

<div class="flex flex-col gap-2">
	<div
		class="overflow-clip rounded-xl border border-line bg-surface shadow-[var(--elev-1)] focus-within:border-accent"
		data-testid="note-editor"
	>
		<!-- TOOLBAR. A SIDEWAYS ROW ON A PHONE, GROUPS SEPARATED BY A GAP. IT STAYS UNDER THE TOP BAR (65, 57 ON A PHONE) WHILE A LONG NOTE SCROLLS; THE CARD CLIPS INSTEAD OF HIDING SO THE STICKY WORKS -->
		<div
			role="toolbar"
			aria-label="Formatting"
			class="sticky top-[65px] z-10 flex [scrollbar-width:none]! items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-line bg-raised px-2 max-md:top-[57px] max-md:h-11 md:h-10 [&::-webkit-scrollbar]:hidden"
		>
			{#each TOOLS as tool, i (tool.id)}
				{@const s = stateOf(tool)}
				{@const Icon = ICONS[tool.id]}
				{#if i > 0 && TOOLS[i - 1].group !== tool.group}
					<span aria-hidden="true" class="mx-1 h-5 w-px shrink-0 bg-line"></span>
				{/if}
				<button
					type="button"
					aria-label={tool.label}
					title={tool.label}
					aria-pressed={tool.active ? s.active : undefined}
					disabled={!s.enabled}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => press(tool)}
					data-testid={`tool-${tool.id}`}
					class={cn(
						'inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 max-md:size-11',
						s.active &&
							'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text'
					)}
				>
					<Icon size={18} />
				</button>
			{/each}
		</div>

		<!-- THE LINK BAR OPENS UNDER THE TOOLBAR FROM THE LINK TOOL -->
		{#if linkOpen}
			<form
				onsubmit={submitLink}
				class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2"
				data-testid="link-bar"
			>
				<TextField
					label="Where should the link go?"
					hideLabel
					bind:value={linkUrl}
					placeholder="https://example.com or afb:note/N-12"
					class="min-w-48 flex-1"
				/>
				<Button type="submit" size="sm">Apply</Button>
				<Button type="button" size="sm" variant="ghost" onclick={() => (linkOpen = false)}
					>Cancel</Button
				>
				{#if linkError}<p class="w-full text-sm text-danger" role="alert">{linkError}</p>{/if}
			</form>
		{/if}

		<!-- THE EDITOR. THE LIBRARY MOUNTS ITS OWN ROOT, A .md, INSIDE THIS BOX -->
		<div bind:this={host} class="px-8 py-6 max-sm:p-4"></div>
	</div>

	<!-- THE PICTURE PICKER OF THE TOOLBAR AND THE SLASH MENU -->
	<input
		bind:this={picker}
		type="file"
		accept={PICTURE_ACCEPT}
		multiple
		hidden
		tabindex="-1"
		aria-hidden="true"
		onchange={pickedFiles}
		data-testid="picture-input"
	/>

	<!-- PICTURES ON THEIR WAY, AND THE ONES THAT DID NOT GO -->
	{#if lines.length}
		<ul class="flex flex-col gap-1 text-sm" aria-label="Pictures" data-testid="picture-lines">
			{#each lines as line (line.id)}
				<li
					role={line.state === 'error' ? 'alert' : 'status'}
					class={cn(
						'flex min-h-6 items-center gap-2',
						line.state === 'error' ? 'text-danger' : 'text-muted'
					)}
				>
					<span class="min-w-0 flex-1">{line.text}</span>
					{#if line.state === 'error'}
						<button
							type="button"
							aria-label="Dismiss this message"
							onclick={() => (lines = lines.filter((l) => l.id !== line.id))}
							class="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:size-11"
						>
							<X size={16} />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<!-- THE SLASH MENU AND THE LINK MENU. FOCUS STAYS IN THE TEXT; THE KEYS COME FROM THE EDITOR -->
{#if menuOpen}
	<EditorMenuList
		id={menuId}
		label={trigger?.kind === 'link' ? 'Link to' : 'Insert'}
		{rows}
		active={index}
		{anchor}
		{status}
		onpick={pick}
		onhover={(i) => (index = i)}
	/>
{/if}
