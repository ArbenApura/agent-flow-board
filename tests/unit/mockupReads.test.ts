// THE PARTS OF A MOCKUP THAT WERE READ (AFB-20261110-2331): MERGING, COUNTING AND "READ TO THE END"

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	coveredChars,
	coversAll,
	mergeRange,
	unionRanges,
	unreadLine,
	type ReadRange
} from '../../src/lib/server/ops/mockupReads';

// -- TESTS -- //

describe('the read ranges of a mockup', () => {
	it('merges parts that overlap or touch, in any order, and keeps apart the ones that do not', () => {
		let r: ReadRange[] = [];
		r = mergeRange(r, 100, 200);
		r = mergeRange(r, 0, 50);
		expect(r).toEqual([
			[0, 50],
			[100, 200]
		]);
		// Touching parts become one, and so does a part that covers a gap
		r = mergeRange(r, 50, 100);
		expect(r).toEqual([[0, 200]]);
		expect(mergeRange(r, 150, 260)).toEqual([[0, 260]]);
		expect(mergeRange(r, 20, 30)).toEqual([[0, 200]]);
	});

	it('ignores an empty part and never changes the list it was given', () => {
		const before: ReadRange[] = [[0, 10]];
		expect(mergeRange(before, 5, 5)).toEqual([[0, 10]]);
		expect(mergeRange(before, 9, 3)).toEqual([[0, 10]]);
		mergeRange(before, 10, 40);
		expect(before).toEqual([[0, 10]]);
	});

	it('counts what is covered and says when the whole page is read', () => {
		const half: ReadRange[] = [
			[0, 40],
			[60, 100]
		];
		expect(coveredChars(half)).toBe(80);
		expect(coversAll(half, 100)).toBe(false);
		expect(coversAll(mergeRange(half, 40, 60), 100)).toBe(true);
		// A part that starts after the beginning never covers the page, however long it is
		expect(coversAll([[1, 100]], 100)).toBe(false);
		// An empty page has nothing to read
		expect(coversAll([], 0)).toBe(true);
		expect(coversAll([], 1)).toBe(false);
	});

	it('adds up what several sessions read', () => {
		const a: ReadRange[] = [[0, 40]];
		const b: ReadRange[] = [
			[30, 70],
			[90, 100]
		];
		expect(unionRanges([a, b])).toEqual([
			[0, 70],
			[90, 100]
		]);
		expect(coversAll(unionRanges([a, b, [[70, 90]]]), 100)).toBe(true);
	});

	it('writes the notice from ids, versions and counts only', () => {
		const line = unreadLine([
			{
				id: 'm-1',
				currentVersion: 2,
				sizeBytes: 5000,
				htmlLength: null,
				readChars: 0,
				readComplete: false
			},
			{
				id: 'm-2',
				currentVersion: 1,
				sizeBytes: 900,
				htmlLength: 800,
				readChars: 300,
				readComplete: false
			},
			{
				id: 'm-3',
				currentVersion: 1,
				sizeBytes: 10,
				htmlLength: 10,
				readChars: 10,
				readComplete: true
			}
		]);
		expect(line).toContain('m-1 v2 (not opened, 5,000 bytes)');
		expect(line).toContain('m-2 v1 (500 of 800 characters unread)');
		expect(line).not.toContain('m-3');
		expect(unreadLine([])).toBeNull();
	});
});
