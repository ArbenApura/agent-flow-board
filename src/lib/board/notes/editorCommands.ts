// THE TOOLBAR OF THE NOTE EDITOR AS DATA (AFB-20261111-0035, STEP 4.2)
// Each tool is one command on the editor and one test of the Markdown it writes. The screen only draws them.

// -- DEP-TYPES -- //
import type { Editor } from '@tiptap/core';

// -- MODULES -- //
import { parseAfbLink } from '../../markdown';

// -- TYPES -- //

export type ToolId =
	| 'undo'
	| 'redo'
	| 'h1'
	| 'h2'
	| 'h3'
	| 'bold'
	| 'italic'
	| 'bullet'
	| 'ordered'
	| 'task'
	| 'quote'
	| 'code'
	| 'table'
	| 'link'
	| 'picture';

export interface Tool {
	id: ToolId;
	/** The plain name, also the aria-label and the tooltip. */
	label: string;
	/** Tools of one group sit together, with a gap between groups. */
	group: 'history' | 'heading' | 'text' | 'block' | 'insert';
	run: (editor: Editor) => boolean;
	active?: (editor: Editor) => boolean;
	enabled?: (editor: Editor) => boolean;
}

// -- CONSTANTS -- //

/** Schemes a link may use. A bare word like example.com gets https:// in front. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const ALLOWED = new Set(['http', 'https', 'mailto', 'tel', 'afb']);

// -- FUNCTIONS -- //

/**
 * The address a link will point at, or null when the text is empty or its scheme is not allowed.
 * A bare domain becomes https; afb:N-12 and afb:file/<id> stay as typed.
 */
export function normalizeLinkUrl(raw: string): string | null {
	const text = raw.trim();
	if (!text || /\s/.test(text)) return null;
	const scheme = SCHEME.exec(text);
	// An afb: address must be one the renderer knows, so a link the editor writes is a link the board draws
	if (scheme && scheme[1].toLowerCase() === 'afb') return parseAfbLink(text) ? text : null;
	if (scheme) return ALLOWED.has(scheme[1].toLowerCase()) ? text : null;
	return /^[^/?#]+\.[^/?#]+/.test(text) ? `https://${text}` : null;
}

/** Puts a link on the selection, or takes it off with an empty address. False when the address is refused. */
export function applyLink(editor: Editor, raw: string): boolean {
	if (!raw.trim()) return editor.chain().focus().extendMarkRange('link').unsetLink().run();
	const href = normalizeLinkUrl(raw);
	if (!href) return false;
	return editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

const chain = (editor: Editor) => editor.chain().focus();

export const TOOLS: Tool[] = [
	{
		id: 'undo',
		label: 'Undo',
		group: 'history',
		run: (e) => e.commands.undo(),
		enabled: (e) => e.can().undo()
	},
	{
		id: 'redo',
		label: 'Redo',
		group: 'history',
		run: (e) => e.commands.redo(),
		enabled: (e) => e.can().redo()
	},
	{
		id: 'h1',
		label: 'Heading 1',
		group: 'heading',
		run: (e) => chain(e).toggleHeading({ level: 1 }).run(),
		active: (e) => e.isActive('heading', { level: 1 })
	},
	{
		id: 'h2',
		label: 'Heading 2',
		group: 'heading',
		run: (e) => chain(e).toggleHeading({ level: 2 }).run(),
		active: (e) => e.isActive('heading', { level: 2 })
	},
	{
		id: 'h3',
		label: 'Heading 3',
		group: 'heading',
		run: (e) => chain(e).toggleHeading({ level: 3 }).run(),
		active: (e) => e.isActive('heading', { level: 3 })
	},
	{
		id: 'bold',
		label: 'Bold',
		group: 'text',
		run: (e) => chain(e).toggleBold().run(),
		active: (e) => e.isActive('bold')
	},
	{
		id: 'italic',
		label: 'Italic',
		group: 'text',
		run: (e) => chain(e).toggleItalic().run(),
		active: (e) => e.isActive('italic')
	},
	{
		id: 'bullet',
		label: 'Bulleted list',
		group: 'block',
		run: (e) => chain(e).toggleBulletList().run(),
		active: (e) => e.isActive('bulletList')
	},
	{
		id: 'ordered',
		label: 'Numbered list',
		group: 'block',
		run: (e) => chain(e).toggleOrderedList().run(),
		active: (e) => e.isActive('orderedList')
	},
	{
		id: 'task',
		label: 'Checklist',
		group: 'block',
		run: (e) => chain(e).toggleTaskList().run(),
		active: (e) => e.isActive('taskList')
	},
	{
		id: 'quote',
		label: 'Quote',
		group: 'block',
		run: (e) => chain(e).toggleBlockquote().run(),
		active: (e) => e.isActive('blockquote')
	},
	{
		id: 'code',
		label: 'Code block',
		group: 'block',
		run: (e) => chain(e).toggleCodeBlock().run(),
		active: (e) => e.isActive('codeBlock')
	},
	{
		id: 'table',
		label: 'Table',
		group: 'insert',
		run: (e) => chain(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
		enabled: (e) => e.can().insertTable()
	},
	{
		// The address comes from the link bar of the screen; this only reports whether a link is under the cursor
		id: 'link',
		label: 'Link',
		group: 'insert',
		run: () => true,
		active: (e) => e.isActive('link')
	},
	{
		// The file picker and the upload belong to the screen (step 4.5); this only gives the button its place in the toolbar
		id: 'picture',
		label: 'Picture',
		group: 'insert',
		run: () => true
	}
];

export const toolById = (id: ToolId): Tool => {
	const tool = TOOLS.find((t) => t.id === id);
	if (!tool) throw new Error(`No tool ${id}`);
	return tool;
};
