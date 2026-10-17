import { describe, expect, it } from 'vitest';
import { activityText, arrangeProjects, parseSort, parseView, type ProjectRow } from './projects';

const row = (key: string, name: string, extra: Partial<ProjectRow> = {}): ProjectRow => ({
	project: { id: key, key, name },
	total: 0,
	byStatus: {},
	running: 0,
	pinned: false,
	createdAt: '2026-01-01T00:00:00Z',
	lastActivityAt: null,
	...extra
});

const rows = [
	row('ZED', 'Zebra', { total: 2, byStatus: { COMPLETED: 2 }, createdAt: '2026-03-01T00:00:00Z' }),
	row('ABC', 'apple', {
		total: 9,
		byStatus: { 'IN PROGRESS': 3, PLANNED: 6 },
		running: 1,
		createdAt: '2026-02-01T00:00:00Z',
		lastActivityAt: '2026-10-01T00:00:00Z'
	}),
	row('MID', 'Mango', {
		total: 5,
		byStatus: { 'IN PROGRESS': 5 },
		pinned: true,
		createdAt: '2026-04-01T00:00:00Z',
		lastActivityAt: '2026-10-02T00:00:00Z'
	}),
	row('EMP', 'Empty one')
];
const keys = (list: ProjectRow[]) => list.map((o) => o.project.key);
const base = { q: '', chip: 'all', sort: 'name' } as const;

describe('arrangeProjects', () => {
	it('sorts by name without caring about case, and keeps pinned projects in their own group', () => {
		const g = arrangeProjects(rows, base);
		expect(keys(g.pinned)).toEqual(['MID']);
		expect(keys(g.rest)).toEqual(['ABC', 'EMP', 'ZED']);
	});
	it('sorts by key, newest, items and most active inside each group', () => {
		expect(keys(arrangeProjects(rows, { ...base, sort: 'key' }).rest)).toEqual([
			'ABC',
			'EMP',
			'ZED'
		]);
		expect(keys(arrangeProjects(rows, { ...base, sort: 'newest' }).rest)).toEqual([
			'ZED',
			'ABC',
			'EMP'
		]);
		expect(keys(arrangeProjects(rows, { ...base, sort: 'items' }).rest)).toEqual([
			'ABC',
			'ZED',
			'EMP'
		]);
		// Running first, then in progress, then the empty and finished ones by name
		expect(keys(arrangeProjects(rows, { ...base, sort: 'active' }).rest)).toEqual([
			'ABC',
			'EMP',
			'ZED'
		]);
	});
	it('never moves a pinned project out of Pinned, whatever the sort', () => {
		for (const sort of ['name', 'key', 'active', 'newest', 'items'] as const)
			expect(keys(arrangeProjects(rows, { ...base, sort }).pinned)).toEqual(['MID']);
	});
	it('searches name and key', () => {
		expect(keys(arrangeProjects(rows, { ...base, q: 'MANG' }).pinned)).toEqual(['MID']);
		expect(keys(arrangeProjects(rows, { ...base, q: 'zed' }).rest)).toEqual(['ZED']);
		const none = arrangeProjects(rows, { ...base, q: 'nothing like this' });
		expect(none.pinned).toEqual([]);
		expect(none.rest).toEqual([]);
	});
	it('filters by chip and counts every chip for the current search', () => {
		expect(keys(arrangeProjects(rows, { ...base, chip: 'running' }).rest)).toEqual(['ABC']);
		expect(keys(arrangeProjects(rows, { ...base, chip: 'empty' }).rest)).toEqual(['EMP']);
		const open = arrangeProjects(rows, { ...base, chip: 'open' });
		expect(keys([...open.pinned, ...open.rest]).sort()).toEqual(['ABC', 'MID']);
		expect(open.counts).toEqual({ all: 4, running: 1, open: 2, empty: 1 });
		expect(arrangeProjects(rows, { ...base, q: 'a' }).counts.all).toBe(3);
	});
});

describe('remembered choices and activity text', () => {
	it('falls back to the defaults for anything unknown', () => {
		expect(parseSort('items')).toBe('items');
		expect(parseSort('<script>')).toBe('name');
		expect(parseView('list')).toBe('list');
		expect(parseView(null)).toBe('cards');
	});
	it('writes the last change in plain words', () => {
		const now = Date.parse('2026-10-17T12:00:00Z');
		expect(activityText(null, now)).toBe('No activity yet');
		expect(activityText('2026-10-17T11:59:40Z', now)).toBe('Active just now');
		expect(activityText('2026-10-17T11:30:00Z', now)).toBe('Active 30 min ago');
		expect(activityText('2026-10-17T10:00:00Z', now)).toBe('Active 2 hours ago');
		expect(activityText('2026-10-15T12:00:00Z', now)).toBe('Active 2 days ago');
	});
});
