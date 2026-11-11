// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	activeOf,
	emptyNotes,
	groupByWhen,
	markedParts,
	notesHref,
	readNotesLayout,
	readNotesView,
	whenGroup
} from './view';

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

describe('the redesigned list (AFB-20261111-0805)', () => {
	it('reads and writes the cards layout in the address, beside the view', () => {
		expect(readNotesLayout(new URLSearchParams('layout=cards'))).toBe('cards');
		expect(readNotesLayout(new URLSearchParams('layout=grid'))).toBe('list');
		expect(notesHref('/o/P', 'favourites', '', 'cards')).toBe(
			'/o/P/notes?view=favourites&layout=cards'
		);
		expect(notesHref('/o/P', 'all')).toBe('/o/P/notes');
	});

	it('groups notes by Today, This week and Earlier in their order', () => {
		const now = new Date(2026, 10, 11, 15, 0);
		const at = (d: number, h = 9) => ({ updatedAt: new Date(2026, 10, d, h) });
		const groups = groupByWhen([at(11, 14), at(11, 1), at(9), at(5), at(1)], now);
		expect(groups.map((g) => [g.label, g.notes.length])).toEqual([
			['Today', 2],
			['This week', 2],
			['Earlier', 1]
		]);
		expect(whenGroup(new Date(2026, 10, 10, 23, 59), now)).toBe('This week');
	});

	it('cuts text into marked and plain parts, ignoring a broken range', () => {
		expect(
			markedParts('a tribulation b', [
				[2, 13],
				[5, 3]
			])
		).toEqual([
			{ text: 'a ', mark: false },
			{ text: 'tribulation', mark: true },
			{ text: ' b', mark: false }
		]);
	});
});
