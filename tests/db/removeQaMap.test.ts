// THE MIGRATION THAT REMOVES THE QA MAP (AFB-20261127-0438): IT RUNS OVER A DATABASE THAT STILL HAS QA RUNS
// A database is built to migration 0060 with a plan item and a QA run item, then migrated to the end as the NON-SUPERUSER owner,
// bound by forced row level security like production. Only a throwaway database on the embedded server is used.

// IMPORTED DEP-MODULES
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
// IMPORTED MODULES
import { MIGRATIONS_DIR, migrate } from '../../src/lib/server/db/migrate';

// -- CONSTANTS -- //

const LAST_OLD = '0060_screen_mime';
/** Tables the security statements of the current code name that 0062 creates later, stood in for while the old database is built. */
const LATER_TABLES = [
	'test_case',
	'test_case_version',
	'test_counter',
	'test_run',
	'test_result',
	'test_proof',
	'test_plan_case',
	'test_surface'
];
const ORG = '00000000-0000-4000-8000-000000000001';
const PROJ = '00000000-0000-4000-8000-000000000011';
const PLAN_ITEM = '00000000-0000-4000-8000-000000000101';
const RUN_ITEM = '00000000-0000-4000-8000-000000000102';

// -- FUNCTIONS -- //

describe('migration 0061_remove_qa_map', () => {
	const { port } = inject('afbPg');
	const name = `afb_rmqa_${randomBytes(5).toString('hex')}`;
	const url = (user: string, password: string, database = name) =>
		`postgres://${user}:${password}@localhost:${port}/${database}`;
	let admin: pg.Pool;
	let owner: pg.Pool;
	let oldDir = '';

	const run = async (dir: string) => {
		const client = await owner.connect();
		try {
			return await migrate(
				{
					exec: async (s) => void (await client.query(s)),
					query: async <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
						(await client.query(s, p)).rows as T[]
				},
				dir
			);
		} finally {
			client.release();
		}
	};

	beforeAll(async () => {
		const root = new pg.Pool({ connectionString: url('postgres', 'pw', 'postgres'), max: 1 });
		await root.query(`CREATE DATABASE "${name}" OWNER afb_owner`);
		await root.end();
		admin = new pg.Pool({ connectionString: url('postgres', 'pw'), max: 2 });
		await admin.query(`ALTER SCHEMA public OWNER TO afb_owner`);
		owner = new pg.Pool({ connectionString: url('afb_owner', 'own'), max: 2 });
		// A copy of the migrations up to the last old one
		oldDir = mkdtempSync(join(tmpdir(), 'afb-mig-'));
		mkdirSync(join(oldDir, 'meta'));
		const journal = JSON.parse(
			readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
		) as { entries: { tag: string }[] };
		const upto = journal.entries.findIndex((e) => e.tag === LAST_OLD);
		expect(upto).toBeGreaterThan(0);
		const kept = journal.entries.slice(0, upto + 1);
		for (const e of kept)
			copyFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(oldDir, `${e.tag}.sql`));
		writeFileSync(
			join(oldDir, 'meta', '_journal.json'),
			JSON.stringify({ ...journal, entries: kept })
		);
	}, 60_000);

	afterAll(async () => {
		await owner.end();
		await admin.end();
		rmSync(oldDir, { recursive: true, force: true });
		const drop = new pg.Pool({ connectionString: url('postgres', 'pw', 'postgres'), max: 1 });
		try {
			await drop.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
		} catch {
			/* The server removes everything when the run ends */
		} finally {
			await drop.end();
		}
	});

	it('trashes the QA run items, keeps the plans, drops the QA tables and starts the testing cut-off', async () => {
		for (const t of LATER_TABLES)
			await owner.query(
				`CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY, org_id uuid, project_id uuid)`
			);
		await run(oldDir);
		for (const t of [...LATER_TABLES].reverse()) await owner.query(`DROP TABLE ${t}`);

		await admin.query(
			`INSERT INTO "user" (id, name, email) VALUES ('u-1', 'Ana', 'ana@a.example')`
		);
		await admin.query(`INSERT INTO org (id, name, slug) VALUES ('${ORG}', 'Org A', 'a')`);
		await admin.query(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${PROJ}', '${ORG}', 'AAA', 'A one')`
		);
		await admin.query(
			`INSERT INTO item (id, org_id, project_id, number, ref, title) VALUES
			 ('${PLAN_ITEM}', '${ORG}', '${PROJ}', 1, 'AAA-1', 'A plan'),
			 ('${RUN_ITEM}', '${ORG}', '${PROJ}', 2, 'AAA-2', 'QA run 1')`
		);
		await admin.query(
			`INSERT INTO qa_run (org_id, project_id, run_no, item_id, target_host) VALUES ('${ORG}', '${PROJ}', 1, '${RUN_ITEM}', 'localhost')`
		);
		// On the live database the QA tables are forced tenant tables with policies for the runtime role only, as the code that
		// made them secured them; the current code no longer lists them, so that state is set here as production has it
		await admin.query(`ALTER TABLE qa_run ENABLE ROW LEVEL SECURITY`);
		await admin.query(`ALTER TABLE qa_run FORCE ROW LEVEL SECURITY`);

		const applied = await run(MIGRATIONS_DIR);
		expect(applied).toEqual(['0061_remove_qa_map', '0062_testing']);

		const items = await admin.query<{
			id: string;
			deleted_at: Date | null;
			deleted_by: string | null;
		}>(`select id, deleted_at, deleted_by from item order by number`);
		// The plan stays; the QA run item is in the trash, restorable, and says what put it there
		expect(items.rows[0]).toMatchObject({ id: PLAN_ITEM, deleted_at: null });
		expect(items.rows[1].id).toBe(RUN_ITEM);
		expect(items.rows[1].deleted_at).not.toBeNull();
		expect(items.rows[1].deleted_by).toBe('migration 0061_remove_qa_map');

		const tables = await admin.query<{ table_name: string }>(
			`select table_name from information_schema.tables where table_schema = 'public'`
		);
		const have = new Set(tables.rows.map((r) => r.table_name));
		for (const t of [
			'qa_feature',
			'qa_run',
			'qa_result',
			'qa_bug',
			'qa_plan_feature',
			'qa_settings'
		])
			expect(have.has(t), t).toBe(false);
		for (const t of LATER_TABLES) expect(have.has(t), t).toBe(true);
		const since = await admin.query<{ testing_since: Date }>(`select testing_since from project`);
		expect(since.rows[0].testing_since).toBeInstanceOf(Date);
		// Forced row level security is back on the item table, and on every testing table
		const forced = await admin.query<{ relname: string; relforcerowsecurity: boolean }>(
			`select relname, relforcerowsecurity from pg_class where relname = any($1)`,
			[['item', ...LATER_TABLES]]
		);
		expect(forced.rows).toHaveLength(LATER_TABLES.length + 1);
		expect(forced.rows.every((r) => r.relforcerowsecurity)).toBe(true);
		expect(await run(MIGRATIONS_DIR)).toEqual([]);
	}, 120_000);
});
