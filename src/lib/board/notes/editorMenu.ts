// THE SLASH MENU AND THE LINK MENU OF THE NOTE EDITOR AS PLAIN LOGIC (AFB-20261111-0035, STEP 4.4)
// What typed text opens a menu, which rows it shows, what each key does, and the link a picked result writes. No Svelte and
// no ProseMirror view, so all of it runs in the tests. The screen only draws the rows and forwards the keys.

// -- DEP-TYPES -- //
import type { Editor } from '@tiptap/core';

// -- TYPES -- //

export type MenuKind = 'slash' | 'link';

/** What the text before the cursor asks for: the kind of menu, what was typed after the trigger, and where the trigger starts in the text block. */
export interface ParsedTrigger {
	kind: MenuKind;
	query: string;
	/** Offset of the first trigger character (the slash, the at sign or the first bracket) inside the text before the cursor. */
	start: number;
}

export type SlashId =
	| 'h1'
	| 'h2'
	| 'h3'
	| 'bullet'
	| 'ordered'
	| 'task'
	| 'quote'
	| 'code'
	| 'table'
	| 'picture'
	| 'divider';

export interface SlashItem {
	id: SlashId;
	label: string;
	hint: string;
	/** Other words that find the row, besides its label. */
	keywords: string[];
}

/** One thing a note can link to, as the link-targets endpoint answers it. */
export interface LinkTarget {
	kind: 'item' | 'task' | 'mockup' | 'note';
	id: string;
	/** N-12, T-12 or the plan reference; null for a mockup. */
	ref: string | null;
	title: string;
}

export type MenuKeyAction = 'next' | 'prev' | 'pick' | 'close';

export interface Range {
	from: number;
	to: number;
}

// -- CONSTANTS -- //

/** A slash or an at sign opens a menu only at the start of a block or after a space, so a path or a mail address never does. */
const SLASH = /(?:^|\s)\/([A-Za-z0-9-]{0,24})$/;
const AT = /(?:^|\s)@([^\s@[\]]{0,60})$/;
/** [[ takes a phrase, spaces included, until a bracket closes it. */
const BRACKETS = /\[\[([^[\]\n]{0,60})$/;

export const SLASH_ITEMS: SlashItem[] = [
	{ id: 'h1', label: 'Heading 1', hint: 'A big section title', keywords: ['title', 'h1'] },
	{ id: 'h2', label: 'Heading 2', hint: 'A medium section title', keywords: ['subtitle', 'h2'] },
	{ id: 'h3', label: 'Heading 3', hint: 'A small section title', keywords: ['h3'] },
	{ id: 'bullet', label: 'Bulleted list', hint: 'A list with dots', keywords: ['ul', 'list'] },
	{ id: 'ordered', label: 'Numbered list', hint: 'A list with numbers', keywords: ['ol', 'list'] },
	{
		id: 'task',
		label: 'Checklist',
		hint: 'A list you can tick off',
		keywords: ['todo', 'task', 'checkbox']
	},
	{ id: 'quote', label: 'Quote', hint: 'Set a passage apart', keywords: ['blockquote'] },
	{ id: 'code', label: 'Code block', hint: 'Code in a fixed-width font', keywords: ['pre'] },
	{ id: 'table', label: 'Table', hint: 'Rows and columns', keywords: ['grid'] },
	{
		id: 'picture',
		label: 'Picture',
		hint: 'Add a picture from this device',
		keywords: ['image', 'photo', 'upload']
	},
	{
		id: 'divider',
		label: 'Divider',
		hint: 'A line across the page',
		keywords: ['rule', 'line', 'hr']
	}
];

/** The longest a link search waits for the person to stop typing. */
export const SEARCH_DELAY_MS = 200;

// -- FUNCTIONS -- //

/** Reads the text before the cursor and says which menu it asks for, if any. */
export function parseTrigger(before: string): ParsedTrigger | null {
	const br = BRACKETS.exec(before);
	if (br) return { kind: 'link', query: br[1], start: br.index };
	const at = AT.exec(before);
	if (at) return { kind: 'link', query: at[1], start: at.index + at[0].length - at[1].length - 1 };
	const sl = SLASH.exec(before);
	if (sl) return { kind: 'slash', query: sl[1], start: sl.index + sl[0].length - sl[1].length - 1 };
	return null;
}

/** The slash rows a typed word leaves: the ones whose name or keywords start with it first, then the ones that contain it. */
export function filterSlash(query: string): SlashItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return SLASH_ITEMS;
	const rank = (item: SlashItem) => {
		const words = [item.label.toLowerCase(), ...item.keywords];
		if (words.some((w) => w.startsWith(q))) return 0;
		if (words.some((w) => w.includes(q))) return 1;
		return 2;
	};
	return SLASH_ITEMS.map((item, i) => ({ item, i, r: rank(item) }))
		.filter((x) => x.r < 2)
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.map((x) => x.item);
}

/** The next row after an arrow key, wrapping at both ends. */
export function stepIndex(index: number, count: number, delta: 1 | -1): number {
	if (count <= 0) return 0;
	return (((index + delta) % count) + count) % count;
}

/**
 * What a key does to an open menu, or null when the editor should have it. Enter and Tab pick only when there is a row, so
 * Enter on an empty result is a new line. Keys held with Ctrl, Alt or Meta are never the menu's.
 */
export function keyAction(
	event: {
		key: string;
		ctrlKey?: boolean;
		altKey?: boolean;
		metaKey?: boolean;
		shiftKey?: boolean;
	},
	count: number
): MenuKeyAction | null {
	if (event.ctrlKey || event.altKey || event.metaKey) return null;
	switch (event.key) {
		case 'Escape':
			return 'close';
		case 'ArrowDown':
			return count > 0 ? 'next' : null;
		case 'ArrowUp':
			return count > 0 ? 'prev' : null;
		case 'Enter':
			return count > 0 && !event.shiftKey ? 'pick' : null;
		case 'Tab':
			return count > 0 && !event.shiftKey ? 'pick' : null;
		default:
			return null;
	}
}

/** The afb: address of a target, in the forms the renderer and the link extension know. */
export function hrefOf(target: LinkTarget): string {
	const key = target.ref ?? target.id;
	switch (target.kind) {
		case 'note':
			return `afb:note/${key}`;
		case 'task':
			return `afb:task/${key}`;
		case 'mockup':
			return `afb:mockup/${target.id}`;
		default:
			return `afb:item/${key}`;
	}
}

/** The words a link shows: the title of the target, or its reference when the title is empty. */
export const labelOf = (target: LinkTarget): string =>
	target.title.replace(/\s+/g, ' ').trim() || target.ref || 'Untitled';

/** The Markdown a picked target writes into the note, for example [Plan title](afb:item/AFB-20261111-0035). */
export function linkMarkdown(target: LinkTarget): string {
	const text = labelOf(target).replace(/[\\[\]]/g, (c) => `\\${c}`);
	return `[${text}](${hrefOf(target)})`;
}

/** The plain name of a kind, for the tag on a result row. */
export const KIND_NAME: Record<LinkTarget['kind'], string> = {
	item: 'Plan',
	task: 'Task',
	mockup: 'Mockup',
	note: 'Note'
};

/** The id of one option of a menu, which the editor names in aria-activedescendant. */
export const optionId = (menuId: string, index: number) => `${menuId}-opt-${index}`;

/** Replaces the typed trigger and query with a link to the target, then a plain space so typing carries on outside the link. */
export function insertLink(editor: Editor, range: Range, target: LinkTarget): boolean {
	return editor
		.chain()
		.focus()
		.insertContentAt(range, [
			{
				type: 'text',
				text: labelOf(target),
				marks: [{ type: 'link', attrs: { href: hrefOf(target) } }]
			},
			{ type: 'text', text: ' ' }
		])
		.run();
}

/** Removes the typed trigger and query, then runs the block the row stands for. The picture row hands over to the file picker. */
export function runSlash(
	editor: Editor,
	id: SlashId,
	range: Range,
	context: { pickPicture: () => void }
): boolean {
	const chain = editor.chain().focus().deleteRange(range);
	switch (id) {
		case 'h1':
			return chain.setHeading({ level: 1 }).run();
		case 'h2':
			return chain.setHeading({ level: 2 }).run();
		case 'h3':
			return chain.setHeading({ level: 3 }).run();
		case 'bullet':
			return chain.toggleBulletList().run();
		case 'ordered':
			return chain.toggleOrderedList().run();
		case 'task':
			return chain.toggleTaskList().run();
		case 'quote':
			return chain.setBlockquote().run();
		case 'code':
			return chain.setCodeBlock().run();
		case 'table':
			return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
		case 'divider':
			return chain.setHorizontalRule().run();
		case 'picture': {
			const ok = chain.run();
			context.pickPicture();
			return ok;
		}
	}
}

/**
 * Asks for link targets after the person stops typing. Only the newest question's answer is passed on, so a slow answer to
 * an old word never replaces a fast answer to the current one.
 */
export class LinkSearch {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private latest = 0;

	constructor(
		private readonly load: (query: string) => Promise<LinkTarget[]>,
		private readonly onResult: (
			result: { query: string; targets: LinkTarget[] } | { error: true }
		) => void,
		private readonly delay = SEARCH_DELAY_MS
	) {}

	/** Asks for the word. With immediate set (the menu just opened) there is no wait. */
	ask(query: string, immediate = false) {
		this.cancel();
		const turn = ++this.latest;
		const go = () => {
			this.timer = null;
			this.load(query.trim()).then(
				(targets) => {
					if (turn === this.latest) this.onResult({ query, targets });
				},
				() => {
					if (turn === this.latest) this.onResult({ error: true });
				}
			);
		};
		if (immediate || this.delay <= 0) go();
		else this.timer = setTimeout(go, this.delay);
	}

	/** Forgets the waiting question and ignores any answer still on its way. */
	cancel() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.latest++;
	}
}
