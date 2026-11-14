// THE EDITOR'S EXTENSION SET AND THE MARKDOWN WAY IN AND OUT (AFB-20261111-0035, STEP 4.1)
// Pure TypeScript with no Svelte, so the same set runs in the browser editor and in the tests and the seed builder.

// IMPORTED DEP-TYPES
import type { Extensions } from '@tiptap/core';
// IMPORTED DEP-MODULES
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import StarterKit from '@tiptap/starter-kit';
import * as Y from 'yjs';
// IMPORTED MODULES
import { displaySrc, storedSrc } from './pictureUpload.js';

// -- TYPES -- //

/** What the collaboration caret needs from a provider: only an awareness object. */
export interface CaretProvider {
	awareness: unknown;
}

export interface EditorSetup {
	/** The local Yjs document the editor is bound to. A note is always edited through one, even with nobody else in it. Left out only for a schema-only editor. */
	ydoc?: Y.Doc;
	/** The hand written provider. Left out for a headless editor (the seed builder) and for a note with nobody else in it. */
	provider?: CaretProvider;
	/** Who this window is, drawn on the other windows as a coloured caret. The colour is a CSS value, always a token such as var(--accent). */
	user?: { name: string; color: string };
	placeholder?: string;
	/** The slug of the org the note is in. With it a stored afb:file/<id> picture is shown from its real address; the text keeps afb:file/<id>. */
	org?: string;
}

// -- CONSTANTS -- //

/** The name of the Yjs fragment the document lives in (the default of the collaboration extension). */
export const FRAGMENT = 'default';

/**
 * The link schemes a note may hold besides the usual web ones. afb: points at things on the board (afb:N-12, afb:AFB-20261111-0035)
 * and afb:file/<id> at a picture stored with the note. javascript: and data: are refused by the link extension itself.
 */
export const LINK_PROTOCOLS = ['afb'];

// -- FUNCTIONS -- //

/**
 * The serializer ends blocks with blank lines and puts an extra blank line before a table. One note body has no blank edges
 * and never more than one blank line between blocks. The inside of a fenced code block is left exactly as written.
 */
export function normalizeMarkdown(md: string): string {
	const out: string[] = [];
	let fenced = false;
	let blank = 0;
	for (const line of md.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (!fenced && line.trim() === '') {
			blank++;
			if (blank > 1) continue;
		} else blank = 0;
		out.push(line);
	}
	return out.join('\n').replace(/^\s+|\s+$/g, '');
}

/**
 * The picture node. The document and the Markdown hold afb:file/<id>; only the element in the page gets the real address,
 * and an element pasted back in is read as afb:file/<id> again, so the text never holds a site address.
 */
function pictureNode(org: string | undefined) {
	return Image.extend({
		addAttributes() {
			return {
				...this.parent?.(),
				src: {
					default: null,
					parseHTML: (el: HTMLElement) => storedSrc(el.getAttribute('src')),
					renderHTML: (attrs: Record<string, unknown>) =>
						typeof attrs.src === 'string' ? { src: displaySrc(attrs.src, org) } : {}
				}
			};
		}
	});
}

/**
 * Another person's caret with a name label. The library paints it with the person's colour as an inline style; here the
 * element carries classes only, and app.css gives every remote caret the same ink token. No colour is set at run time.
 */
export function caretOf(user: Record<string, unknown>): HTMLElement {
	const caret = document.createElement('span');
	caret.classList.add('collaboration-carets__caret');
	const label = document.createElement('div');
	label.classList.add('collaboration-carets__label');
	label.textContent = typeof user.name === 'string' ? user.name : 'Someone';
	caret.insertBefore(label, null);
	return caret;
}

/** The mark on another person's selected text: a class and their name, no colour. */
export function selectionOf(user: Record<string, unknown>) {
	return {
		nodeName: 'span',
		class: 'collaboration-carets__selection',
		'data-user': typeof user.name === 'string' ? user.name : 'Someone'
	};
}

/**
 * The extensions of the note editor. Undo and redo come from Yjs (the collaboration extension), never from ProseMirror's own
 * history, so a person only ever undoes their own typing. Underline is left out: Markdown has no way to write it, so it would be lost on save.
 */
export function editorExtensions(setup: EditorSetup): Extensions {
	const list: Extensions = [
		StarterKit.configure({
			undoRedo: false,
			underline: false,
			link: { openOnClick: false, autolink: true, protocols: LINK_PROTOCOLS }
		}),
		TableKit.configure({ table: { resizable: false } }),
		TaskList,
		TaskItem.configure({ nested: true }),
		pictureNode(setup.org).configure({ allowBase64: false }),
		Markdown
	];
	if (setup.placeholder) list.push(Placeholder.configure({ placeholder: setup.placeholder }));
	if (setup.ydoc) list.push(Collaboration.configure({ document: setup.ydoc, field: FRAGMENT }));
	if (setup.provider)
		list.push(
			CollaborationCaret.configure({
				provider: setup.provider,
				user: setup.user ?? { name: 'Someone', color: 'currentColor' },
				render: caretOf,
				selectionRender: selectionOf
			})
		);
	return list;
}

/** Turns an editor's document into Markdown. */
export const toMarkdown = (editor: Editor): string => normalizeMarkdown(editor.getMarkdown());

/** Writes Markdown into an editor as its document (into the Yjs document when one is bound). */
export function loadMarkdown(editor: Editor, markdown: string) {
	editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
}

/** A headless editor on a Yjs document, for work that needs the document model but no screen. Destroy it when done. */
export function headlessEditor(ydoc: Y.Doc): Editor {
	return new Editor({ element: null, extensions: editorExtensions({ ydoc }) });
}

/**
 * The Yjs update that holds exactly this Markdown, built on a scratch document. This is the seed of a note that has no
 * live updates yet. Two windows that build one each get two different updates for the same text, which is why only the
 * first one to reach the server may be kept (see seed.ts).
 */
export function seedUpdate(markdown: string): Uint8Array {
	const scratch = new Y.Doc();
	const editor = new Editor({ element: null, extensions: editorExtensions({}) });
	try {
		// Parsed with the editor's own schema and written straight into the fragment, so it needs no view and no timers
		const json = editor.markdown?.parse(markdown) ?? { type: 'doc', content: [] };
		prosemirrorToYXmlFragment(editor.schema.nodeFromJSON(json), scratch.getXmlFragment(FRAGMENT));
		return Y.encodeStateAsUpdate(scratch);
	} finally {
		editor.destroy();
		scratch.destroy();
	}
}

/** The Markdown a Yjs document holds, read straight from its fragment with no view and no timers. */
export function markdownOfDoc(ydoc: Y.Doc): string {
	const editor = new Editor({ element: null, extensions: editorExtensions({}) });
	try {
		const node = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT), editor.schema);
		return normalizeMarkdown(editor.markdown?.serialize(node.toJSON()) ?? '');
	} finally {
		editor.destroy();
	}
}
