// yarn import:hapr --board <path to the .board folder> [--owner <email of an existing user>] [--db-dir <folder>] [--storage-dir <folder>]
//                  [--report <file>] [--org hapr] [--project HAPR] [--no-snapshot] [--dry-run] [--create-owner]
//
// Imports a HAPR board into this product's database and checks the result by content. It only reads the board: it first copies
// the three things it reads (flow, attachments and TASKS.md, leaving .git out) into a temporary folder and imports from the copy,
// so another session writing to the live board cannot change what is compared. The listing with checksums of what it read is
// taken before and after, and the report says whether the live board changed meanwhile.
// With DATABASE_URL set it imports into that PostgreSQL database, otherwise into a local PGlite database in --db-dir.

// -- DEP-MODULES -- //
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
// -- MODULES -- //
import { diskStorage } from '../src/lib/server/adapters/storage';
import { createPglite, createPostgres, type DbHandle } from '../src/lib/server/db/client';
import { migrate } from '../src/lib/server/db/migrate';
import { listing, listingHash, type Listed } from './fsro';
import { importBoard } from './import';
import { readBoard } from './read';
import { verifyImport } from './verify';

// -- CONSTANTS -- //

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const has = (n: string) => args.includes(n);
const READS = ['flow', 'attachments', 'TASKS.md'];
const THEMES = [
	{ key: 'hapr', label: 'HAPR' },
	{ key: 'gameplan', label: 'GAMEPLAN' }
];

// -- FUNCTIONS -- //

const fail = (message: string): never => {
	console.error(message);
	process.exit(2);
};

/** The files the importer reads, listed with their checksums. */
const readListing = (root: string): Listed[] => listing(root, READS);

/** Copies what the importer reads into a temporary folder. The board is only read. */
function snapshot(board: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'afb-hapr-snapshot-'));
	for (const r of READS) {
		const from = join(board, r);
		if (existsSync(from))
			cpSync(from, join(dir, r), {
				recursive: true,
				filter: (p) => !p.split(sep).includes('.git')
			});
	}
	return dir;
}

/** A path must not be inside the board: the importer never writes there. */
function outside(board: string, p: string, what: string) {
	const a = resolve(p).toLowerCase() + sep;
	const b = resolve(board).toLowerCase() + sep;
	if (a.startsWith(b))
		fail(
			`${what} (${p}) is inside the board folder. The importer never writes under the board. Choose another place.`
		);
}

async function openDb(): Promise<{ handle: DbHandle; where: string }> {
	if (process.env.DATABASE_URL) {
		const handle = await createPostgres({
			runtimeUrl: process.env.DATABASE_OWNER_URL ? process.env.DATABASE_URL : undefined,
			ownerUrl: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL
		});
		return { handle, where: 'the PostgreSQL database in DATABASE_URL' };
	}
	const dir = resolve(opt('--db-dir') ?? '.afb/import-db');
	mkdirSync(dir, { recursive: true });
	return { handle: await createPglite(dir), where: `the local PGlite database ${dir}` };
}

async function main() {
	const boardArg = opt('--board') ?? fail('Say which board to read: --board C:/path/to/.board');
	const board = resolve(boardArg);
	if (!existsSync(join(board, 'flow'))) fail(`${board} has no flow folder.`);
	const reportFile = resolve(opt('--report') ?? '.afb/import-report.json');
	const storageDir = resolve(opt('--storage-dir') ?? '.afb/import-files');
	const dbDir = resolve(opt('--db-dir') ?? '.afb/import-db');
	for (const [p, what] of [
		[reportFile, 'The report file'],
		[storageDir, 'The storage folder'],
		[dbDir, 'The database folder']
	] as const)
		outside(board, p, what);

	console.log('Listing the board with checksums, before.');
	const before = readListing(board);
	const root = has('--no-snapshot') ? board : snapshot(board);
	console.log(`Reading ${root}`);
	const source = readBoard(root);
	console.log(
		`${source.items.length} items, ${source.removed.length} removed rows, ${source.tasks.length} tasks, ${source.items.reduce((n, i) => n + i.attachments.length, 0)} attachments.`
	);
	if (has('--dry-run')) {
		console.log('Dry run: nothing was written.');
		if (root !== board) rmSync(root, { recursive: true, force: true });
		return;
	}
	const { handle, where } = await openDb();
	await migrate(handle.owner);
	const email =
		opt('--owner') ??
		fail('Say who owns the new organisation: --owner someone@example.com (an existing user).');
	let [owner] = await handle.owner.query<{ id: string }>(
		'select id from "user" where lower(email) = lower($1)',
		[email]
	);
	// For a trial database only: makes the owner when asked. A real import names a person who has signed up
	if (!owner && has('--create-owner'))
		[owner] = await handle.owner.query<{ id: string }>(
			'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true) returning id',
			[`import-${Date.now().toString(36)}`, 'HAPR owner', email]
		);
	if (!owner) fail(`No user has the email ${email}. Sign up first, then import.`);
	const storage = diskStorage(storageDir, 'import-no-signed-links-needed');
	const o = {
		handle,
		storage,
		org: { slug: opt('--org') ?? 'hapr', name: 'HAPR' },
		project: { key: opt('--project') ?? 'HAPR', name: 'HAPR GamePlan' },
		ownerUserId: owner.id,
		themes: THEMES,
		log: (l: string) => process.stdout.write(`\r${l.slice(0, 100).padEnd(100)}`)
	};
	console.log(`Importing into ${where}`);
	const summary = await importBoard(source, o);
	console.log(
		`\nImported ${summary.imported}, skipped ${summary.skipped} already there, ${summary.attachments} attachments, ${summary.checkRuns} check runs, ${summary.uiShotRuns} UI shots runs, ${summary.tasks} tasks.`
	);
	console.log('Verifying by content.');
	const report = await verifyImport(source, {
		handle,
		storage,
		orgId: summary.orgId,
		projectId: summary.projectId,
		themes: THEMES
	});
	const after = readListing(board);
	const changedLive = listingHash(before) !== listingHash(after);
	const unchangedSnapshot =
		root === board ? true : listingHash(readListing(root)) === listingHash(before);
	const full = {
		...report,
		import: summary,
		liveBoardChangedDuringImport: changedLive,
		readListingHash: listingHash(after),
		readFiles: after.length,
		snapshotMatchesBoardBefore: unchangedSnapshot
	};
	mkdirSync(resolve(reportFile, '..'), { recursive: true });
	writeFileSync(reportFile, JSON.stringify(full, null, 2));
	console.log(
		`Compared ${Object.values(report.compared).reduce((a, b) => a + b, 0)} facts of ${Object.keys(report.compared).length} kinds: ${report.mismatches.length} mismatches.`
	);
	for (const m of report.mismatches.slice(0, 25)) console.log(`  ${m.item} ${m.kind}: ${m.detail}`);
	if (report.mismatches.length > 25)
		console.log(`  ... and ${report.mismatches.length - 25} more in the report`);
	for (const n of [...report.notes, ...summary.notes].slice(0, 12)) console.log(`  note: ${n}`);
	console.log(
		changedLive
			? 'The live board changed while this ran (another session wrote to it). The import used the copy taken at the start.'
			: `The ${after.length} files read from the board are the same before and after.`
	);
	console.log(`Report: ${reportFile}`);
	if (root !== board) rmSync(root, { recursive: true, force: true });
	await handle.close();
	process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
