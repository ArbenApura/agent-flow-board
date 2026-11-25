// THE MIGRATION THAT REMOVES BROWSER CHECKS (AFB-20261123-0936): IT RUNS OVER A DATABASE THAT STILL HAS CHECK DATA
// A database is built to migration 0052 and filled with the rows the removal must deal with, then migrated to the end as the
// NON-SUPERUSER owner, bound by forced row level security like production. Only a throwaway database on the embedded server is used.

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

const LAST_OLD = '0052_runner_tool_owner_name_unique';
const GONE_TABLES = [
	'check',
	'check_run',
	'ui_change',
	'ui_shot_run',
	'design_scale',
	'runner',
	'dev_registration',
	'bridge_approval',
	'bridge_signin_envelope',
	'environment',
	'org_data_key',
	'secret'
];

// -- FUNCTIONS -- //

describe('migration 0053_remove_browser_checks', () => {
	const { port } = inject('afbPg');
	const name = `afb_rm_${randomBytes(5).toString('hex')}`;
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
		) as {
			entries: { tag: string }[];
		};
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

	it('drops the check tables and columns, keeps everything else, and clears the rows that would block it', async () => {
		// The security statements of the current code name every table, so a table that a later migration creates (0055 auth_method_setting) is
		// stood in for while the old database is built, and removed again before the real run creates it
		await owner.query(`CREATE TABLE IF NOT EXISTS auth_method_setting (id text PRIMARY KEY)`);
		// The same for the screenshot tables of 0056 (AFB-20261124-0926): tenant tables, so they carry the org and project columns
		// And for the QA Map tables of 0057 (AFB-20261125-0442)
		const qaTables = [
			'qa_feature',
			'qa_settings',
			'qa_run',
			'qa_result',
			'qa_plan_feature',
			'qa_bug'
		];
		for (const t of ['screen', ...qaTables])
			await owner.query(
				`CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY, org_id uuid, project_id uuid)`
			);
		await run(oldDir);
		for (const t of [...qaTables].reverse()) await owner.query(`DROP TABLE ${t}`);
		await owner.query(`DROP TABLE auth_method_setting`);
		await owner.query(`DROP TABLE screen`);
		const org = '00000000-0000-4000-8000-000000000001';
		const proj = '00000000-0000-4000-8000-000000000011';
		await admin.query(
			`INSERT INTO "user" (id, name, email) VALUES ('u-1', 'Ana', 'ana@a.example')`
		);
		await admin.query(`INSERT INTO org (id, name, slug) VALUES ('${org}', 'Org A', 'a')`);
		await admin.query(
			`INSERT INTO project (id, org_id, key, name, web_app, reference_pages) VALUES ('${proj}', '${org}', 'AAA', 'A one', true, '{/x}')`
		);
		await admin.query(
			`INSERT INTO connect_setup_mark (org_id, user_id, key, state) VALUES ('${org}', 'u-1', 'checks', 'done'), ('${org}', 'u-1', 'tools', 'done')`
		);
		await admin.query(
			`INSERT INTO attachment (org_id, project_id, kind, caption, filename, mime, size, checksum, storage_key) VALUES
			 ('${org}', '${proj}', 'check-evidence', 'shot', 'a.png', 'image/png', 1, 'x', 'mf/evidence-1'),
			 ('${org}', '${proj}', 'file', 'keep', 'b.png', 'image/png', 1, 'y', 'files/keep-1')`
		);
		await admin.query(
			`INSERT INTO runner (org_id, kind, name, owner_id) VALUES ('${org}', 'tool', 'pc', 'u-1')`
		);

		const applied = await run(MIGRATIONS_DIR);
		// 0054 (the parent link of master and child plans), 0055 (the sign in methods table) and 0056 (the screenshots) come after it and apply on the same run
		expect(applied).toEqual([
			'0053_remove_browser_checks',
			'0054_master_child',
			'0055_auth_method_setting',
			'0056_screens',
			'0057_qa_map',
			'0058_screens_no_annotations'
		]);

		const tables = await admin.query<{ table_name: string }>(
			`select table_name from information_schema.tables where table_schema = 'public'`
		);
		const have = new Set(tables.rows.map((r) => r.table_name));
		for (const t of GONE_TABLES) expect(have.has(t), t).toBe(false);
		for (const t of [
			'project',
			'item',
			'step',
			'attachment',
			'connect_setup_mark',
			'api_token',
			'device_code'
		])
			expect(have.has(t), t).toBe(true);
		const cols = await admin.query<{ table_name: string; column_name: string }>(
			`select table_name, column_name from information_schema.columns where table_schema = 'public'
			 and ((table_name = 'step' and column_name = 'required_target') or (table_name = 'user_pref' and column_name = 'check_target')
			   or (table_name = 'project' and column_name in ('web_app', 'reference_pages')))`
		);
		expect(cols.rows).toEqual([]);
		const marks = await admin.query<{ key: string }>(`select key from connect_setup_mark`);
		expect(marks.rows.map((r) => r.key)).toEqual(['tools']);
		const atts = await admin.query<{ kind: string }>(`select kind from attachment`);
		// The check-evidence row stays for the purge command, which deletes its stored file first
		expect(atts.rows.map((r) => r.kind).sort()).toEqual(['check-evidence', 'file']);
		const projects = await admin.query(`select id from project`);
		expect(projects.rows).toHaveLength(1);
		// Forced row level security is back on both tables the migration lifted it from
		const forced = await admin.query<{ relname: string; relforcerowsecurity: boolean }>(
			`select relname, relforcerowsecurity from pg_class where relname in ('attachment', 'connect_setup_mark')`
		);
		expect(forced.rows.every((r) => r.relforcerowsecurity)).toBe(true);
		// A second run finds nothing to do
		expect(await run(MIGRATIONS_DIR)).toEqual([]);
	}, 120_000);
});
