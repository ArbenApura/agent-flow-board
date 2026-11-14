// WHAT THE NOTES PAGE SHOWS, READ FROM AND WRITTEN TO THE ADDRESS, AND THE WORDS OF ITS EMPTY STATES
// The address is the one place the open folder, the favourites view and the search live, so a view can be shared and Back works.

// IMPORTED TYPES
import type { TreeView } from './tree';

export type NotesView = {
	/** Every note, the starred ones, or one folder. */
	view: 'all' | 'favourites' | 'folder';
	folderId: string | null;
	q: string;
};
export type NotesEmpty = { kind: 'items' | 'search'; title: string; text: string; create: boolean };

// -- CONSTANTS -- //

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -- FUNCTIONS -- //

/** The view an address asks for. Anything that is not a folder id falls back to every note. */
export function readNotesView(params: URLSearchParams): NotesView {
	const q = (params.get('q') ?? '').trim().slice(0, 200);
	const folder = params.get('folder');
	if (params.get('view') === 'favourites') return { view: 'favourites', folderId: null, q };
	if (folder && UUID.test(folder)) return { view: 'folder', folderId: folder, q };
	return { view: 'all', folderId: null, q };
}

/** The row of the tree that is open. */
export const activeOf = (v: NotesView): TreeView =>
	v.view === 'folder' && v.folderId ? v.folderId : v.view === 'favourites' ? 'favourites' : 'all';

/** How the notes are laid out: rows (the default) or cards (AFB-20261111-0805). */
export type NotesLayout = 'list' | 'cards';

/** The cookie that keeps the person's choice, so a reload, a new tab and a link without it open the same layout (AFB-20261111-1344). */
export const NOTES_LAYOUT_COOKIE = 'afb-notes-layout';

/** One of the two layouts, or null for anything else (a missing, empty or changed value is ignored). */
export const parseNotesLayout = (value: string | null | undefined): NotesLayout | null =>
	value === 'list' || value === 'cards' ? value : null;

/**
 * The layout to show. An explicit layout in the address wins, so a shared link shows what was shared; then the saved
 * choice (the cookie); then the list.
 */
export const readNotesLayout = (
	params: Pick<URLSearchParams, 'get'>,
	saved?: string | null
): NotesLayout => parseNotesLayout(params.get('layout')) ?? parseNotesLayout(saved) ?? 'list';

/** The cookie string that keeps a choice for a year. Not httpOnly: the page writes it when the switch is used, the server reads it. */
export const notesLayoutCookie = (layout: NotesLayout): string =>
	`${NOTES_LAYOUT_COOKIE}=${layout}; path=/; max-age=31536000; samesite=lax`;

/** The address of a view of the Notes page. A search is carried along when given. The layout is not: the cookie keeps it. */
export function notesHref(base: string, target: TreeView, q = ''): string {
	const params = new URLSearchParams();
	if (target === 'favourites') params.set('view', 'favourites');
	else if (target !== 'all') params.set('folder', target);
	if (q.trim()) params.set('q', q.trim());
	const query = params.toString();
	return `${base}/notes${query ? `?${query}` : ''}`;
}

/**
 * What to say when the list is empty. A folder whose notes the person cannot see reads exactly like an empty folder, so
 * the page never hints that private notes of other people are there.
 */
export function emptyNotes(v: NotesView, anyNotes: boolean, canWrite: boolean): NotesEmpty {
	if (v.q)
		return {
			kind: 'search',
			title: 'No notes match',
			text: 'Try a different word, or clear the search.',
			create: false
		};
	if (v.view === 'favourites')
		return {
			kind: 'items',
			title: 'No favourites yet',
			text: 'Star a note to keep it here, at the top, for yourself.',
			create: false
		};
	if (v.view === 'folder')
		return {
			kind: 'items',
			title: 'Nothing in this folder',
			text: canWrite
				? 'Make a note here, or move one in.'
				: 'Notes put in this folder will show here.',
			create: canWrite
		};
	return {
		kind: 'items',
		title: 'No notes yet',
		text: anyNotes
			? 'Notes put in this view will show here.'
			: canWrite
				? 'Write down what belongs to no single plan: how something works, an idea, what was said in a meeting. Your coding tool can read it too.'
				: 'Notes written for this project will show here.',
		create: canWrite
	};
}

// -- GROUPS AND MARKS (AFB-20261111-0805) -- //

export type WhenGroup = 'Today' | 'This week' | 'Earlier';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which group a note sits in by when it last changed, in the person's own time zone. */
export function whenGroup(changed: Date | string, now: Date = new Date()): WhenGroup {
	const at = new Date(changed);
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (at.getTime() >= today) return 'Today';
	if (at.getTime() >= today - 6 * DAY_MS) return 'This week';
	return 'Earlier';
}

/** The notes in groups, in the order they came (newest change first). Empty groups are left out. */
export function groupByWhen<T extends { updatedAt: Date | string }>(
	notes: T[],
	now: Date = new Date()
): { label: WhenGroup; notes: T[] }[] {
	const out: { label: WhenGroup; notes: T[] }[] = [];
	for (const n of notes) {
		const label = whenGroup(n.updatedAt, now);
		const last = out.at(-1);
		if (last?.label === label) last.notes.push(n);
		else out.push({ label, notes: [n] });
	}
	return out;
}

/** Plain text cut into parts at the marked ranges, so a component can wrap the matches in <mark> without any HTML. */
export function markedParts(
	text: string,
	marks: [number, number][]
): { text: string; mark: boolean }[] {
	const parts: { text: string; mark: boolean }[] = [];
	let at = 0;
	for (const [a, b] of [...marks].sort((x, y) => x[0] - y[0])) {
		if (a < at || b <= a || b > text.length) continue;
		if (a > at) parts.push({ text: text.slice(at, a), mark: false });
		parts.push({ text: text.slice(a, b), mark: true });
		at = b;
	}
	if (at < text.length) parts.push({ text: text.slice(at), mark: false });
	return parts;
}
