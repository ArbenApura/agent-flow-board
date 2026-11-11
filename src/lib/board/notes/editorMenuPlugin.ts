// THE EDITOR EXTENSION THAT WATCHES THE TEXT BEFORE THE CURSOR FOR A SLASH, AN AT SIGN OR [[ (AFB-20261111-0035, STEP 4.4)
// Focus never leaves the editor: the person keeps typing into it, and this plugin reports what the typing asks for and hands
// the menu keys to the screen first. The Tiptap suggestion package is not installed, so this is the small plugin it would be.

// -- DEP-TYPES -- //
import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
// -- TYPES -- //
import type { Box } from '#lib/ui/position.js';
import type { MenuKind } from './editorMenu.js';
// -- DEP-MODULES -- //
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
// -- MODULES -- //
import { parseTrigger } from './editorMenu.js';

// -- TYPES -- //

/** An open trigger: what it asks for, the typed word, and the document range (trigger and word) a pick replaces. */
export interface MenuUpdate {
	kind: MenuKind;
	query: string;
	from: number;
	to: number;
	/** The caret in viewport coordinates, or null when the editor cannot say. */
	box: Box | null;
}

export interface EditorMenuOptions {
	/** Called when the trigger appears, changes or goes away (null). */
	onUpdate: (update: MenuUpdate | null) => void;
	/** Gets every key before the editor. True means the menu used it. */
	onKey: (event: KeyboardEvent) => boolean;
}

export interface EditorMenuStorage {
	/** The start of a trigger the person closed with Escape. It stays closed until that trigger is gone. */
	dismissed: number | null;
}

// -- CONSTANTS -- //

const KEY = new PluginKey('afbEditorMenu');

// -- FUNCTIONS -- //

/** The box of the caret in viewport coordinates, or null when the editor cannot say (not shown yet). */
export function caretBox(view: EditorView, pos: number): Box | null {
	try {
		const c = view.coordsAtPos(pos);
		return { left: c.left, top: c.top, width: 0, height: c.bottom - c.top };
	} catch {
		return null;
	}
}

/** Closes the menu of the trigger that starts at from. It stays closed until that trigger is gone. */
export function dismissMenu(editor: Editor, from: number | null) {
	(editor.storage as unknown as Record<string, EditorMenuStorage>).editorMenu.dismissed = from;
}

/** The trigger the cursor is in right now, or null. Code (a block or inline code) and a selected range never trigger. */
export function triggerAt(view: EditorView): MenuUpdate | null {
	const { selection } = view.state;
	if (!selection.empty || !view.editable) return null;
	const $from = selection.$from;
	if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
	if ($from.marks().some((m) => m.type.name === 'code')) return null;
	// A leaf (a picture) inside the block is one placeholder character, so offsets stay the same as document positions
	const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
	const parsed = parseTrigger(before);
	if (!parsed) return null;
	return {
		kind: parsed.kind,
		query: parsed.query,
		from: $from.start() + parsed.start,
		to: selection.from,
		box: caretBox(view, selection.from)
	};
}

export const EditorMenu = Extension.create<EditorMenuOptions, EditorMenuStorage>({
	name: 'editorMenu',
	// Before the list and table keymaps, so Enter and Tab pick a row while a menu is open
	priority: 1000,

	addOptions() {
		return { onUpdate: () => {}, onKey: () => false };
	},

	addStorage() {
		return { dismissed: null };
	},

	addProseMirrorPlugins() {
		const options = this.options;
		const storage = this.storage;
		// What was last reported, so a transaction that changes nothing about the trigger says nothing
		let last = '';
		const report = (update: MenuUpdate | null) => {
			const sig = update ? `${update.kind}|${update.from}|${update.to}|${update.query}` : '';
			if (sig === last) return;
			last = sig;
			options.onUpdate(update);
		};
		return [
			new Plugin({
				key: KEY,
				view: () => ({
					update: (view) => {
						let found = triggerAt(view);
						if (found && storage.dismissed === found.from) found = null;
						else if (!found) storage.dismissed = null;
						report(found);
					},
					destroy: () => report(null)
				}),
				props: {
					handleKeyDown: (_view, event) => !event.isComposing && options.onKey(event),
					handleDOMEvents: {
						// The menu is for the person who is typing. Leaving the editor closes it
						blur: () => {
							report(null);
							return false;
						}
					}
				}
			})
		];
	}
});
