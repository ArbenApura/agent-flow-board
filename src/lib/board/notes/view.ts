// WHAT THE NOTES PAGE SHOWS, READ FROM AND WRITTEN TO THE ADDRESS, AND THE WORDS OF ITS EMPTY STATES
// The address is the one place the open folder, the favourites view and the search live, so a view can be shared and Back works.

// -- TYPES -- //
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

/** The address of a view of the Notes page. A search is carried along when given. */
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
