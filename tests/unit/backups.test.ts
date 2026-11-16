// THE BACKUPS PAGE HELPERS: READABLE SIZES, THE EXACT TIME, AND FOLDING RUNS OF THE SAME FAILURE WITHOUT LOSING ANY RUN

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	formatBytes,
	groupRuns,
	newestGoodId,
	shortId,
	whenShort,
	whenText,
	type BackupRunView
} from '../../src/lib/board/backups';

// -- CONSTANTS -- //

const REASON = 'The run was interrupted (the server stopped or ran out of memory).';

// -- FUNCTIONS -- //

const run = (
	id: string,
	state: 'done' | 'failed',
	extra: Partial<BackupRunView> = {}
): BackupRunView => ({
	id,
	state,
	size: state === 'done' ? 470_470 * 1024 : null,
	error: state === 'failed' ? REASON : null,
	hasFile: state === 'done',
	createdAt: '2026-11-16T03:00:00.000Z',
	...extra
});

describe('formatBytes', () => {
	it('shows a size a person can read, with one decimal under 10 and none above', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(470_470 * 1024)).toBe('459 MB');
		expect(formatBytes(453_381 * 1024)).toBe('443 MB');
		expect(formatBytes(1.4 * 1024 ** 3)).toBe('1.4 GB');
		expect(formatBytes(12 * 1024 ** 3)).toBe('12 GB');
		// A value just under a unit boundary carries into the next unit
		expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
	});

	it('shows a dash for a missing or impossible size', () => {
		expect(formatBytes(null)).toBe('–');
		expect(formatBytes(undefined)).toBe('–');
		expect(formatBytes(-1)).toBe('–');
		expect(formatBytes(Number.NaN)).toBe('–');
	});
});

describe('times and ids', () => {
	it('writes the exact time with the weekday, and a short form for a folded line', () => {
		const text = whenText('2026-11-16T03:00:00');
		expect(text).toMatch(/^Mon, 16 Nov 2026, 03:00$|^Mon 16 Nov 2026, 03:00$/);
		expect(whenShort('2026-11-14T03:40:00')).not.toMatch(/2026/);
		expect(whenText('not a date')).toBe('');
	});

	it('shortens a run id to six characters for the mono tag', () => {
		expect(shortId('3f9a2c10-aaaa-4bbb-8ccc-000000000001')).toBe('3f9a2c');
	});
});

describe('groupRuns', () => {
	it('folds eight identical failures into one row and keeps every run inside it', () => {
		const runs = [
			run('g1', 'done'),
			run('g2', 'done'),
			...Array.from({ length: 8 }, (_, i) => run(`f${i}`, 'failed'))
		];
		const rows = groupRuns(runs);
		expect(rows.map((r) => r.kind)).toEqual(['good', 'good', 'failed']);
		const failed = rows[2];
		expect(failed.kind === 'failed' && failed.runs.map((r) => r.id)).toEqual(
			Array.from({ length: 8 }, (_, i) => `f${i}`)
		);
		expect(failed.kind === 'failed' && failed.error).toBe(REASON);
	});

	it('keeps a single failure as its own row and splits runs that fail for different reasons', () => {
		const rows = groupRuns([
			run('f1', 'failed'),
			run('f2', 'failed', { error: 'Disk is full.' }),
			run('g1', 'done'),
			run('f3', 'failed'),
			run('f4', 'failed', { error: null })
		]);
		expect(rows.map((r) => (r.kind === 'failed' ? r.runs.length : 'good'))).toEqual([
			1,
			1,
			'good',
			1,
			1
		]);
		const last = rows[4];
		expect(last.kind === 'failed' && last.error).toBe('No reason was recorded.');
	});

	it('does not join two failures that a good copy sits between, and handles an empty list', () => {
		const rows = groupRuns([run('f1', 'failed'), run('g1', 'done'), run('f2', 'failed')]);
		expect(rows).toHaveLength(3);
		expect(groupRuns([])).toEqual([]);
	});

	it('finds the newest good copy, the one a delete warns about', () => {
		expect(newestGoodId([run('f1', 'failed'), run('g1', 'done'), run('g2', 'done')])).toBe('g1');
		expect(newestGoodId([run('f1', 'failed')])).toBeNull();
	});
});
