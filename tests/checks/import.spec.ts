/* eslint-disable @typescript-eslint/no-explicit-any -- the report is parsed from JSON and read loosely in checks */
// M12: the HAPR import report shows zero mismatches against the board, and a full recursive listing with checksums of the folders the
// importer reads is identical before and after. The real importer program runs as its own process, on a fixture board always and on
// the real HAPR board when this machine has one. It reads a copy, so nothing under the board is touched, and it refuses to write inside it.
// The importer needs a PostgreSQL (DATABASE_URL), so each run that gets that far starts a throwaway embedded one and stops it after.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtureBoard } from '../../importer/fixture';
import { listing, listingHash } from '../../importer/fsro';
import { startDatabase } from '../runner/database.mjs';

const REAL_BOARD = process.env.AFB_HAPR_BOARD ?? 'C:/Users/Admin/Desktop/hapr-gameplan/.board';
const READS = ['flow', 'attachments', 'TASKS.md'];

/** Runs the importer program, on the given database, and waits for it. */
function importer(args: string[], databaseUrl: string) {
	return new Promise<{ code: number | null; out: string }>((resolve) => {
		// The importer logs in as the URL it is given, so an owner URL from this machine's shell must not be inherited
		const env = { ...process.env, DATABASE_URL: databaseUrl };
		delete env.DATABASE_OWNER_URL;
		const child = spawn(process.execPath, ['--import', 'tsx', 'importer/cli.ts', ...args], {
			cwd: process.cwd(),
			env
		});
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('close', (code) => resolve({ code, out }));
	});
}

const work = () => mkdtempSync(join(tmpdir(), 'afb-m12-'));

test('M12 the import of a fixture board compares every fact with no mismatch, leaves the board as it was, and runs again without adding anything', async () => {
	test.setTimeout(240_000);
	const dir = work();
	const database = await startDatabase();
	try {
		const board = join(dir, 'board');
		makeFixtureBoard(board);
		const before = listingHash(listing(board, READS));
		const args = [
			'--board',
			board,
			'--owner',
			'import-check@example.com',
			'--create-owner',
			'--storage-dir',
			join(dir, 'files'),
			'--report',
			join(dir, 'report.json')
		];
		const first = await importer(args, database.url);
		expect(first.code, first.out).toBe(0);
		const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
		expect(report.ok).toBe(true);
		expect(report.mismatches).toEqual([]);
		expect(Object.values(report.compared).reduce((a: number, b: any) => a + b, 0)).toBeGreaterThan(
			60
		);
		expect(report.import).toMatchObject({
			imported: 4,
			removedRows: 1,
			tasks: 2,
			checkRuns: 2,
			uiShotRuns: 1
		});
		expect(report.liveBoardChangedDuringImport).toBe(false);
		expect(report.readListingHash).toBe(before);
		expect(listingHash(listing(board, READS))).toBe(before);
		// A second run skips everything that is there and still verifies clean
		const again = await importer(args, database.url);
		expect(again.code, again.out).toBe(0);
		expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).import).toMatchObject({
			imported: 0,
			skipped: 4
		});
	} finally {
		await database.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('M12 the importer refuses to write inside the board, and refuses a folder that is not a board', async () => {
	test.setTimeout(120_000);
	const dir = work();
	const database = await startDatabase();
	try {
		const board = join(dir, 'board');
		makeFixtureBoard(board);
		const inside = await importer(
			[
				'--board',
				board,
				'--owner',
				'x@example.com',
				'--create-owner',
				'--report',
				join(board, 'report.json')
			],
			database.url
		);
		expect(inside.code).toBe(2);
		expect(inside.out).toMatch(/inside the board folder/);
		expect(existsSync(join(board, 'report.json'))).toBe(false);
		const insideFiles = await importer(
			[
				'--board',
				board,
				'--owner',
				'x@example.com',
				'--create-owner',
				'--storage-dir',
				join(board, 'files')
			],
			database.url
		);
		expect(insideFiles.code).toBe(2);
		expect(insideFiles.out).toMatch(/inside the board folder/);
		expect(existsSync(join(board, 'files'))).toBe(false);
		const notBoard = await importer(['--board', dir, '--owner', 'x@example.com'], database.url);
		expect(notBoard.code).toBe(2);
		expect(notBoard.out).toMatch(/has no flow folder/);
		const noOwner = await importer(
			['--board', board, '--storage-dir', join(dir, 'f2'), '--report', join(dir, 'r2.json')],
			database.url
		);
		expect(noOwner.code).toBe(2);
		expect(noOwner.out).toMatch(/Say who owns/);
	} finally {
		await database.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('M12 the real HAPR board imports with zero mismatches and its files are the same before and after', async () => {
	test.skip(!existsSync(join(REAL_BOARD, 'flow')), 'This machine has no HAPR board to import.');
	test.setTimeout(480_000);
	const dir = work();
	const database = await startDatabase();
	try {
		const before = listingHash(listing(REAL_BOARD, READS));
		const run = await importer(
			[
				'--board',
				REAL_BOARD,
				'--owner',
				'import-check@example.com',
				'--create-owner',
				'--storage-dir',
				join(dir, 'files'),
				'--report',
				join(dir, 'report.json')
			],
			database.url
		);
		expect(run.code, run.out.slice(-2000)).toBe(0);
		const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
		expect(report.mismatches).toEqual([]);
		expect(report.ok).toBe(true);
		// Items, steps, ADRs, settled rows, log lines, UI changes and attachments were all compared by content
		for (const kind of [
			'item',
			'step',
			'adr',
			'settled',
			'event',
			'ui-change',
			'attachment',
			'attachment-bytes',
			'working-file',
			'document',
			'percent-vs-hapr',
			'task'
		])
			expect(report.compared[kind], kind).toBeGreaterThan(0);
		expect(report.import.imported).toBeGreaterThanOrEqual(100);
		// What the importer read is the same as before, unless another session wrote to the live board meanwhile, which the report then says
		const after = listingHash(listing(REAL_BOARD, READS));
		if (!report.liveBoardChangedDuringImport) expect(after).toBe(before);
		else
			test.info().annotations.push({
				type: 'note',
				description:
					'Another session wrote to the live board while the import ran. The import used its copy from the start.'
			});
	} finally {
		await database.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
