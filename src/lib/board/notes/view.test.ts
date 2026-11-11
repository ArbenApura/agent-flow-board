// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { activeOf, emptyNotes, notesHref, readNotesView } from './view';

// -- CONSTANTS -- //

const FOLDER = '00000000-0000-4000-8000-000000000001';
const read = (query: string) => readNotesView(new URLSearchParams(query));

describe('the view of the Notes page', () => {
	it('reads every note, the favourites or one folder from the address', () => {
		expect(read('')).toEqual({ view: 'all', folderId: null, q: '' });
		expect(read('view=favourites')).toEqual({ view: 'favourites', folderId: null, q: '' });
		expect(read(`folder=${FOLDER}&q=  seat `)).toEqual({
			view: 'folder',
			folderId: FOLDER,
			q: 'seat'
		});
		// Anything that is not a folder id is every note, never an error
		expect(read('folder=top').view).toBe('all');
		expect(read("folder=' or 1=1").view).toBe('all');
		expect(read(`q=${'a'.repeat(500)}`).q).toHaveLength(200);
	});

	it('names the open row of the tree', () => {
		expect(activeOf(read(''))).toBe('all');
		expect(activeOf(read('view=favourites'))).toBe('favourites');
		expect(activeOf(read(`folder=${FOLDER}`))).toBe(FOLDER);
	});

	it('builds the address of a view and reads it back the same', () => {
		expect(notesHref('/acme/AFB', 'all')).toBe('/acme/AFB/notes');
		expect(notesHref('/acme/AFB', 'favourites')).toBe('/acme/AFB/notes?view=favourites');
		expect(notesHref('/acme/AFB', FOLDER, ' seat ')).toBe(
			`/acme/AFB/notes?folder=${FOLDER}&q=seat`
		);
		const back = readNotesView(new URL(`http://x${notesHref('/a/B', FOLDER, 'x y')}`).searchParams);
		expect(back).toEqual({ view: 'folder', folderId: FOLDER, q: 'x y' });
	});

	it('says the right thing when a list is empty', () => {
		expect(emptyNotes(read('q=zzz'), true, true)).toMatchObject({ kind: 'search', create: false });
		expect(emptyNotes(read('view=favourites'), true, true).title).toBe('No favourites yet');
		expect(emptyNotes(read(''), false, true)).toMatchObject({
			title: 'No notes yet',
			create: true
		});
		expect(emptyNotes(read(''), false, false).create).toBe(false);
	});

	it('an empty folder and a folder of notes the person cannot see read the same', () => {
		// The page is told only how many notes it may show: nothing here can tell the two apart
		const empty = emptyNotes(read(`folder=${FOLDER}`), true, true);
		expect(empty.title).toBe('Nothing in this folder');
		expect(emptyNotes(read(`folder=${FOLDER}`), false, true)).toEqual(empty);
		expect(emptyNotes(read(`folder=${FOLDER}`), true, false).create).toBe(false);
	});
});
