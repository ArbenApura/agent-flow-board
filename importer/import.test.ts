// THE HAPR IMPORT END TO END ON A FIXTURE BOARD: IT READS ONLY, IT WRITES WHAT IT READ, AND THE REPORT FINDS A CHANGE IN A SINGLE BYTE (SPEC 13)

// -- DEP-MODULES -- //
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { memoryStorage } from '../src/lib/server/adapters/storage';
import {
	attachment,
	decision,
	event,
	item,
	project,
	step,
	task,
	uiChange
} from '../src/lib/server/db/schema';
import { withTenant } from '../src/lib/server/db/tenant';
import { makePglite, makePostgres, type TestDb } from '../tests/support/db';
import { makeFixtureBoard } from './fixture';
import { listing, listingHash } from './fsro';
import { importBoard } from './import';
import { readBoard } from './read';
import { verifyImport } from './verify';

// -- CONSTANTS -- //

const THEMES = [
	{ key: 'hapr', label: 'HAPR' },
	{ key: 'gameplan', label: 'GAMEPLAN' }
];
/** The importer files that touch the board. None of them may name a function that writes, moves, deletes or runs a command. */
const READ_ONLY_FILES = ['fsro.ts', 'read.ts', 'parse.ts', 'shape.ts', 'verify.ts'];
const FORBIDDEN =
	/\b(writeFileSync|writeFile|appendFile|appendFileSync|mkdirSync|mkdir|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|cpSync|truncateSync|createWriteStream|chmodSync|utimesSync|symlinkSync|spawnSync|spawn|execSync|execFile|child_process|fork)\b/;

// -- FUNCTIONS -- //

describe('the importer cannot write to the board', () => {
	it('names no function that writes, moves, deletes or runs a command in any file that touches the board', () => {
		for (const f of READ_ONLY_FILES) {
			const code = readFileSync(join(import.meta.dirname, f), 'utf8')
				.split('\n')
				.filter(
					(l) =>
						!l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')
				)
				.join('\n');
			expect(FORBIDDEN.test(code), `${f} names a function that could write`).toBe(false);
		}
	});
	it('imports only readers from node:fs in the file system door', () => {
		const fsro = readFileSync(join(import.meta.dirname, 'fsro.ts'), 'utf8');
		const names =
			/import \{([^}]+)\} from 'node:fs'/
				.exec(fsro)?.[1]
				.split(',')
				.map((x) => x.trim()) ?? [];
		expect(names.sort()).toEqual(['existsSync', 'readFileSync', 'readdirSync', 'statSync']);
	});
});

describe.each([
	['pglite', makePglite],
	['postgres', makePostgres]
] as const)('the import on %s', (_name, make) => {
	let db: TestDb;
	let root: string;
	let ownerId: string;
	const storage = memoryStorage('importer-test-secret-not-used');
	let ids: { orgId: string; projectId: string };
	let before: string;

	beforeAll(async () => {
		db = await make();
		root = mkdtempSync(join(tmpdir(), 'afb-fixture-board-'));
		makeFixtureBoard(root);
		before = listingHash(listing(root));
		await db.admin.exec(
			`insert into "user" (id, name, email, email_verified) values ('imp-owner', 'Importer owner', 'imp@example.com', true)`
		);
		ownerId = 'imp-owner';
	}, 240_000);
	afterAll(async () => {
		await db?.stop();
		rmSync(root, { recursive: true, force: true });
	});

	const run = () =>
		importBoard(readBoard(root), {
			handle: db,
			storage,
			org: { slug: 'hapr', name: 'HAPR' },
			project: { key: 'HAPR', name: 'HAPR GamePlan' },
			ownerUserId: ownerId,
			themes: THEMES
		});
	const rows = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
		withTenant(db, { orgId: ids.orgId, projectId: ids.projectId }, fn);

	it('reads the fixture, writes every item and removed row, and leaves the board exactly as it was', async () => {
		const board = readBoard(root);
		expect(board.items).toHaveLength(3);
		expect(board.removed).toHaveLength(1);
		expect(board.tasks).toHaveLength(2);
		const summary = await run();
		ids = { orgId: summary.orgId, projectId: summary.projectId };
		expect(summary).toMatchObject({
			imported: 4,
			skipped: 0,
			removedRows: 1,
			tasks: 2,
			checkRuns: 2,
			uiShotRuns: 1
		});
		expect(summary.attachments).toBe(7);
		expect(listingHash(listing(root))).toBe(before);
	});

	it('numbers items in id order and answers to the FLOW id and the legacy number', async () => {
		const got = await rows((tx) => tx.select().from(item));
		// A reference is the project key and the real moment of the legacy id, in UTC: FLOW-20260925-1000 is 10:00 in +08:00, so 02:00
		expect(got.map((i) => i.ref).sort()).toEqual([
			'HAPR-20260921-0605',
			'HAPR-20260925-0200',
			'HAPR-20261010-0100',
			'HAPR-20261011-0000'
		]);
		const [removed] = await rows((tx) => tx.select().from(item).where(eq(item.number, 1)));
		expect(removed.title).toBe('sourcing-requirements-refactor');
		expect(removed.status).toBe('COMPLETED');
		const aliases = (
			await db.admin.query<{ alias: string; ref: string }>(
				`select a.alias, i.ref from item_alias a join item i on i.id = a.item_id where a.org_id = '${ids.orgId}'`
			)
		)
			.map((r) => `${r.alias}=${r.ref}`)
			.sort();
		expect(aliases).toEqual(
			[
				'FEAT-003=HAPR-20260921-0605',
				'FEAT-016=HAPR-20260925-0200',
				'FLOW-20260921-1405=HAPR-20260921-0605',
				'FLOW-20260925-1000=HAPR-20260925-0200',
				'FLOW-20261010-0900=HAPR-20261010-0100',
				'FLOW-20261011-0800=HAPR-20261011-0000',
				// The old project key and number stay as aliases too
				'HAPR-1=HAPR-20260921-0605',
				'HAPR-2=HAPR-20260925-0200',
				'HAPR-3=HAPR-20261010-0100',
				'HAPR-4=HAPR-20261011-0000'
			].sort()
		);
	});

	it('keeps the plan: states, notes as reasons, manual checks, and a frozen percent for the legacy item', async () => {
		const [fresh] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20261010-0100'))
		);
		expect(fresh).toMatchObject({
			status: 'IN PROGRESS',
			tabName: 'NEW_THING',
			visibility: 'public',
			stream: 'features',
			scope: 'core',
			branchNote: 'feat/demo',
			doneSteps: 2,
			totalSteps: 3,
			openManual: 1
		});
		expect(fresh.percent).toBe(66);
		expect(fresh.updatedAt.toISOString()).toBe('2026-10-12T07:30:00.000Z');
		const steps = await rows((tx) => tx.select().from(step).where(eq(step.itemId, fresh.id)));
		const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
		expect(byKey['1.1'].state).toBe('done');
		expect(byKey['1.3']).toMatchObject({
			state: 'waived',
			reason: 'Arben, 2026-10-11, not needed any more'
		});
		expect(byKey['2.2'].state).toBe('superseded');
		const [legacy] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20260925-0200'))
		);
		expect(legacy).toMatchObject({ legacyPercent: 100, percent: 100, status: 'COMPLETED' });
		const [priv] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20261011-0000'))
		);
		expect(priv.visibility).toBe('private');
	});

	it('reads decisions in both styles, the settled table, and keeps unstructured text whole', async () => {
		const [fresh] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20261010-0100'))
		);
		const decs = await rows((tx) =>
			tx.select().from(decision).where(eq(decision.itemId, fresh.id))
		);
		const adrs = decs.filter((d) => d.kind === 'adr').sort((a, b) => a.number - b.number);
		expect(adrs.map((a) => [a.number, a.title])).toEqual([
			[1, 'Use the shared parser'],
			[2, 'Keep the old names']
		]);
		expect(adrs[0].alternatives).toBe('Copy it.');
		expect(adrs[1]).toMatchObject({ context: 'Old tools read them.', decision: 'Keep them.' });
		const settled = decs.filter((d) => d.kind === 'settled').sort((a, b) => a.number - b.number);
		expect(settled.map((s) => [s.title, s.answer, s.source])).toEqual([
			['Does it need a new table?', 'No', 'SPEC 3'],
			['Who owns it?', 'The core team', 'the register | row 4']
		]);
		const sections = await db.admin.query<{ slug: string; body: string }>(
			`select slug, body from section where item_id in (select id from item where ref = 'HAPR-20260925-0200')`
		);
		expect(sections.find((s) => s.slug === 'decisions')?.body).toContain('We chose the simple way');
	});

	it('turns history and log lines into events with their old dates, and drops the generated block of PROGRESS.md', async () => {
		const [fresh] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20261010-0100'))
		);
		const events = await rows((tx) => tx.select().from(event).where(eq(event.itemId, fresh.id)));
		expect(events.map((e) => e.verb).sort()).toEqual([
			'item.create',
			'item.log',
			'item.log',
			'item.log',
			'item.status',
			'item.status'
		]);
		expect(
			events
				.find(
					(e) =>
						e.verb === 'item.status' && (e.after as { status: string }).status === 'IN PROGRESS'
				)
				?.createdAt.toISOString()
		).toBe('2026-10-11T02:00:00.000Z');
		expect(
			events.some((e) => (e.after as { text?: string }).text === 'a line with a, comma and `code`.')
		).toBe(true);
		expect(events.every((e) => e.actorLabel === 'HAPR import')).toBe(true);
		const docs = await db.admin.query<{ slug: string; body: string }>(
			`select slug, body from section where item_id = '${fresh.id}'`
		);
		const progress = docs.find((d) => d.slug === 'progress')!;
		expect(progress.body).toContain('Keep going with 1.2.');
		expect(progress.body).not.toContain('flow:state');
		expect(docs.map((d) => d.slug).sort()).toEqual([
			'findings',
			'plan',
			'progress',
			'references',
			'registry',
			'spec',
			'validation'
		]);
		expect(docs.find((d) => d.slug === 'registry')?.body).toContain('follows FLOW-20261001-0800');
		expect(docs.find((d) => d.slug === 'registry')?.body).not.toContain('probe.py');
	});

	it('reads a file written with a byte order mark and Windows line breaks as plain text with LF', async () => {
		const [win] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20261011-0000'))
		);
		const [spec] = await db.admin.query<{ body: string }>(
			`select body from section where item_id = '${win.id}' and slug = 'spec'`
		);
		expect(spec.body).toBe('# Spec\n\nLines end with CRLF.\n');
	});

	it('keeps the UI changes table, the attachments (public and private) and the run results with their pictures', async () => {
		const [fresh] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20261010-0100'))
		);
		const ui = await rows((tx) => tx.select().from(uiChange).where(eq(uiChange.itemId, fresh.id)));
		expect(ui).toHaveLength(5);
		expect(ui.map((u) => u.page)).toEqual([
			'/new',
			'/new',
			'/new/more',
			'/new/more',
			'/hub/{event}/rooms'
		]);
		expect(ui[4]).toMatchObject({
			accounts: 'hapr=iso@example.com',
			siblings: ['/home', 'design/screens.html'],
			viewports: [1440]
		});
		const atts = await rows((tx) =>
			tx.select().from(attachment).where(eq(attachment.itemId, fresh.id))
		);
		expect(atts.find((a) => a.filename === '20261010-public-note.md')).toMatchObject({
			visibility: 'public',
			kind: 'document',
			refs: ['1.1']
		});
		expect(atts.find((a) => a.filename === '20261010-budget.csv')).toMatchObject({
			visibility: 'private',
			kind: 'data'
		});
		expect(atts.filter((a) => a.kind === 'ui-shot')).toHaveLength(2);
		const runs = await db.admin.query<{
			result: string;
			target: string;
			commit: string;
			manual_key: string;
		}>(
			`select r.result, r.target, r."commit", c.manual_key from check_run r join "check" c on c.id = r.check_id where c.item_id = '${fresh.id}' order by c.manual_key`
		);
		expect(runs).toEqual([
			{ result: 'pass', target: 'deployed', commit: 'deadbeefdeadbeef', manual_key: 'M1' },
			{ result: 'fail', target: 'deployed', commit: 'deadbeefdeadbeef', manual_key: 'M2' }
		]);
		const [shots] = await db.admin.query<{
			state: string;
			target: string;
			flags: { text: string }[];
			results: unknown[];
		}>(`select state, target, flags, results from ui_shot_run where item_id = '${fresh.id}'`);
		expect(shots).toMatchObject({ state: 'done', target: 'preview' });
		expect(shots.flags[0].text).toBe('the title is larger than its sibling');
		expect(shots.results).toHaveLength(2);
	});

	it('keeps the tasks, the future status and the link to an item', async () => {
		const tasks = await rows((tx) => tx.select().from(task));
		const [one, two] = tasks.sort((a, b) => a.number - b.number);
		expect(one).toMatchObject({
			number: 1,
			title: 'First task',
			status: 'DONE',
			groupName: 'Billing',
			priority: null
		});
		expect(one.body).toContain('Do the first thing.');
		expect(one.linkedItemIds).toHaveLength(1);
		expect(two).toMatchObject({
			number: 2,
			status: 'FUTURE',
			priority: 'high',
			groupName: 'Later'
		});
		const [proj] = await db.admin.query<{
			agents_may_complete: boolean;
			web_app: boolean;
			themes: { key: string }[];
		}>(`select agents_may_complete, web_app, themes from project where id = '${ids.projectId}'`);
		expect(proj).toMatchObject({ agents_may_complete: false, web_app: true });
		expect(proj.themes.map((t) => t.key)).toEqual(['hapr', 'gameplan']);
		const [counter] = await db.admin.query<{ next: number; next_task: number }>(
			`select next, next_task from project_counter where project_id = '${ids.projectId}'`
		);
		expect(counter).toEqual({ next: 5, next_task: 3 });
		void project;
	});

	it('compares every fact by content and finds nothing wrong, then runs again and skips what is there', async () => {
		const report = await verifyImport(readBoard(root), {
			handle: db,
			storage,
			orgId: ids.orgId,
			projectId: ids.projectId,
			themes: THEMES
		});
		expect(report.mismatches).toEqual([]);
		expect(report.ok).toBe(true);
		for (const kind of [
			'item',
			'step',
			'adr',
			'settled',
			'document',
			'event',
			'ui-change',
			'attachment',
			'attachment-bytes',
			'check-run',
			'shots-run',
			'shots-pictures',
			'task'
		])
			expect(report.compared[kind], kind).toBeGreaterThan(0);
		expect(report.notes.join(' ')).toMatch(/history-legacy\.md holds 2 registry history rows/);
		const again = await run();
		expect(again).toMatchObject({ imported: 0, skipped: 4, tasks: 0 });
		expect((await rows((tx) => tx.select().from(item))).length).toBe(4);
	});

	it('finds a changed step, a changed file in storage and a missing event, each by its content', async () => {
		const [fresh] = await rows((tx) =>
			tx.select().from(item).where(eq(item.ref, 'HAPR-20261010-0100'))
		);
		const opts = {
			handle: db,
			storage,
			orgId: ids.orgId,
			projectId: ids.projectId,
			themes: THEMES
		};
		await db.admin.exec(
			`update step set state = 'open' where item_id = '${fresh.id}' and key = '1.1'`
		);
		let report = await verifyImport(readBoard(root), opts);
		expect(report.ok).toBe(false);
		expect(report.mismatches.map((m) => m.kind)).toContain('step');
		await db.admin.exec(
			`update step set state = 'done' where item_id = '${fresh.id}' and key = '1.1'`
		);
		const [att] = await rows((tx) =>
			tx.select().from(attachment).where(eq(attachment.filename, '20261010-budget.csv'))
		);
		await storage.put(att.storageKey, Buffer.from('Private budget sheet\n1,2,4\n'), 'text/csv');
		report = await verifyImport(readBoard(root), opts);
		expect(report.mismatches.map((m) => m.kind)).toEqual(['attachment-bytes']);
		await storage.put(
			att.storageKey,
			readFileSync(join(root, 'attachments/FLOW-20261010-0900/20261010-budget.csv')),
			'text/csv'
		);
		const [log] = await db.admin.query<{ id: number }>(
			`select id from event where item_id = '${fresh.id}' and verb = 'item.log' limit 1`
		);
		const saved = await db.admin.query<Record<string, unknown>>(
			`select * from event where id = ${log.id}`
		);
		await db.admin.exec(`delete from event where id = ${log.id}`);
		report = await verifyImport(readBoard(root), opts);
		expect(report.mismatches.map((m) => m.kind)).toEqual(['event']);
		expect(saved).toHaveLength(1);
		void readdirSync;
	});
});
