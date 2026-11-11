// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	ancestorIds,
	crumbs,
	descendantIds,
	indentClass,
	moveRefusal,
	moveTargets,
	openTo,
	pastIndent,
	treeKey,
	visibleRows,
	type Folder
} from './tree';

// -- FUNCTIONS -- //

const f = (id: string, parentId: string | null, depth: number, path: string): Folder => ({
	id,
	parentId,
	name: path.split('/').at(-1)!,
	depth,
	path,
	notes: 0
});

// Meetings; Research > Rivals > Pricing; Research > Talks
const TREE: Folder[] = [
	f('m', null, 1, 'Meetings'),
	f('r', null, 1, 'Research'),
	f('rr', 'r', 2, 'Research/Rivals'),
	f('rrp', 'rr', 3, 'Research/Rivals/Pricing'),
	f('rt', 'r', 2, 'Research/Talks')
];
const ids = (rows: Folder[]) => rows.map((r) => r.id);

describe('the folder tree', () => {
	it('shows a folder only when every folder above it is open', () => {
		expect(ids(visibleRows(TREE, new Set()))).toEqual(['m', 'r']);
		expect(ids(visibleRows(TREE, new Set(['r'])))).toEqual(['m', 'r', 'rr', 'rt']);
		expect(ids(visibleRows(TREE, new Set(['r', 'rr'])))).toEqual(['m', 'r', 'rr', 'rrp', 'rt']);
		// An open folder under a closed one stays hidden
		expect(ids(visibleRows(TREE, new Set(['rr'])))).toEqual(['m', 'r']);
	});

	it('knows what is above and below a folder, and what must open to reach it', () => {
		expect(ancestorIds(TREE, 'rrp')).toEqual(['rr', 'r']);
		expect(ancestorIds(TREE, 'm')).toEqual([]);
		expect([...descendantIds(TREE, 'r')].sort()).toEqual(['rr', 'rrp', 'rt']);
		expect(openTo(TREE, 'rrp')).toEqual(['rr', 'r']);
		expect(openTo(TREE, null)).toEqual([]);
		expect(crumbs(TREE, 'rrp').map((c) => c.name)).toEqual(['Research', 'Rivals', 'Pricing']);
		expect(crumbs(TREE, null)).toEqual([]);
	});

	it('does not hang on a loop in the data', () => {
		const loop = [f('a', 'b', 1, 'A'), f('b', 'a', 2, 'A/B')];
		expect(ancestorIds(loop, 'a')).toEqual(['b']);
		expect([...descendantIds(loop, 'a')]).toEqual(['b']);
	});

	it('a row at level 12 indents no further than one at level 6', () => {
		expect(indentClass(1)).toBe('pl-0');
		expect(indentClass(2)).toBe('pl-4');
		expect(indentClass(6)).toBe('pl-20');
		expect(indentClass(12)).toBe(indentClass(6));
		expect(indentClass(100)).toBe(indentClass(6));
		expect(indentClass(0)).toBe('pl-0');
		expect([pastIndent(6), pastIndent(7)]).toEqual([false, true]);
	});

	it('opens and closes with the arrow keys and moves between rows', () => {
		const closed = new Set<string>();
		expect(treeKey(TREE, closed, 'm', 'ArrowDown')).toEqual({ focus: 'r' });
		expect(treeKey(TREE, closed, 'r', 'ArrowDown')).toEqual({});
		expect(treeKey(TREE, closed, 'r', 'ArrowUp')).toEqual({ focus: 'm' });
		// Right opens a closed folder, then steps into it; on a folder with nothing inside it does nothing
		expect(treeKey(TREE, closed, 'r', 'ArrowRight')).toEqual({ expand: 'r' });
		const open = new Set(['r']);
		expect(treeKey(TREE, open, 'r', 'ArrowRight')).toEqual({ focus: 'rr' });
		expect(treeKey(TREE, open, 'm', 'ArrowRight')).toEqual({});
		// Left closes an open folder, and from a closed one steps to its parent
		expect(treeKey(TREE, open, 'r', 'ArrowLeft')).toEqual({ collapse: 'r' });
		expect(treeKey(TREE, open, 'rt', 'ArrowLeft')).toEqual({ focus: 'r' });
		expect(treeKey(TREE, open, 'm', 'ArrowLeft')).toEqual({});
		expect(treeKey(TREE, open, 'rt', 'Home')).toEqual({ focus: 'm' });
		expect(treeKey(TREE, open, 'm', 'End')).toEqual({ focus: 'rt' });
		// A row that is no longer showing sends focus to the first one
		expect(treeKey(TREE, closed, 'rrp', 'ArrowDown')).toEqual({ focus: 'm' });
	});

	it('offers every folder but itself and the folders inside it as a place to move', () => {
		expect(ids(moveTargets(TREE, 'r'))).toEqual(['m']);
		expect(ids(moveTargets(TREE, 'rr'))).toEqual(['m', 'r', 'rt']);
		// A note can go anywhere
		expect(moveTargets(TREE, null)).toHaveLength(5);
	});

	it('says in plain words why a folder cannot go into itself or a folder inside it', () => {
		expect(moveRefusal(TREE, 'r', 'r')).toBe('A folder cannot be moved into itself.');
		expect(moveRefusal(TREE, 'r', 'rrp')).toBe('A folder cannot be moved into a folder inside it.');
		expect(moveRefusal(TREE, 'rr', 'm')).toBe(null);
		expect(moveRefusal(TREE, 'rr', null)).toBe(null);
	});
});
