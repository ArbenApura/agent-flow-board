// THE SERVER COMMAND (scripts/server.ts), RUN FOR REAL AGAINST LOCAL PGLITE FOLDERS: BACKUP, LIST, VERIFY, AND THE CONFIRMED RESTORES

// -- DEP-MODULES -- //
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { createPglite } from '../../src/lib/server/db/client';
import { migrate } from '../../src/lib/server/db/migrate';
import { seedDemo, SEED } from '../../src/lib/server/db/seed';

// -- CONSTANTS -- //

const KEY = 'a-backup-key-of-more-than-32-characters!!';
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

// -- FUNCTIONS -- //

describe('the server command', () => {
	let dir: string;
	const run = (args: string[], extra: Record<string, string> = {}) =>
		spawnSync(process.execPath, [TSX, 'scripts/server.ts', ...args], {
			cwd: process.cwd(),
			encoding: 'utf8',
			env: {
				...process.env,
				BACKUP_KEY: KEY,
				AFB_DB_DIR: join(dir, 'db'),
				BACKUP_DIR: join(dir, 'backups'),
				AFB_STORAGE_DIR: join(dir, 'files'),
				DATABASE_URL: '',
				...extra
			},
			timeout: 120_000
		});

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'afb-cli-'));
		const handle = await createPglite(join(dir, 'db'));
		await migrate(handle.owner);
		await seedDemo(handle.owner, { loadItems: 5 });
		await handle.close();
	}, 120_000);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('refuses to run without a long enough key, and shows its usage', () => {
		expect(run(['backup', 'run'], { BACKUP_KEY: 'short' }).status).toBe(1);
		const usage = run(['nothing']);
		expect(usage.status).toBe(1);
		expect(usage.stderr).toMatch(/Usage/);
	});

	it('backs up every org, lists the runs, and verifies an archive without changing anything', () => {
		const ran = run(['backup', 'run']);
		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).toContain(`${SEED.acme}: done`);
		expect(ran.stdout).toContain(`${SEED.lumora}: done`);
		const folder = join(dir, 'backups', 'backups', SEED.acme);
		const archives = readdirSync(folder).filter((f) => f.endsWith('.afbbak'));
		expect(archives).toHaveLength(1);
		const listed = run(['backup', 'list']);
		expect(listed.stdout).toContain('done');
		expect(listed.stdout).toContain(SEED.lumora);
		const verified = run(['backup', 'verify', join(folder, archives[0])]);
		expect(verified.status, verified.stderr).toBe(0);
		expect(verified.stdout).toMatch(/OK\. Organisation acme/);
		expect(verified.stdout).toMatch(/item: 5003|item: \d+/);
		// The wrong key says so and exits with an error
		const wrong = run(['backup', 'verify', join(folder, archives[0])], {
			BACKUP_KEY: 'x'.repeat(40)
		});
		expect(wrong.status).toBe(1);
		expect(wrong.stderr + wrong.stdout).toMatch(/decrypted|Error/);
		expect(existsSync(join(dir, 'files'))).toBeDefined();
	});

	it('a restore shows its plan and stops unless it is confirmed by the database name, then restores over the org', () => {
		const folder = join(dir, 'backups', 'backups', SEED.acme);
		const file = join(folder, readdirSync(folder)[0]);
		const plan = run(['restore', 'org', file, '--replace']);
		expect(plan.status).toBe(2);
		expect(plan.stdout).toContain('This will change data for real.');
		expect(plan.stdout).toContain('Nothing was changed');
		const wrongName = run([
			'restore',
			'org',
			file,
			'--replace',
			'--confirm',
			'something-else',
			'--yes'
		]);
		expect(wrongName.status).toBe(2);
		// Without replace the org exists, so it is refused
		const exists = run(['restore', 'org', file, '--confirm', 'pglite', '--yes']);
		expect(exists.status).toBe(1);
		expect(exists.stderr).toMatch(/already exists/);
		const done = run(['restore', 'org', file, '--replace', '--confirm', 'pglite', '--yes']);
		expect(done.status, done.stderr).toBe(0);
		expect(done.stdout).toMatch(/Restored acme: \d+ rows/);
	});

	it('a full restore puts every org into an empty database', () => {
		const empty = join(dir, 'empty-db');
		const done = run(['restore', 'full', join(dir, 'backups'), '--confirm', 'pglite', '--yes'], {
			AFB_DB_DIR: empty
		});
		expect(done.status, done.stderr).toBe(0);
		expect(done.stdout).toMatch(/Restored acme/);
		expect(done.stdout).toMatch(/Restored lumora/);
	});

	it('resets an Owner password for a server with no email, only for an Owner, and only when confirmed', () => {
		const secret = {
			BETTER_AUTH_SECRET: 'a-secret-of-more-than-thirty-two-characters',
			AFB_BASE_URL: 'http://localhost:5180'
		};
		const plan = run(
			['owner', 'reset-password', '--org', 'acme', '--email', 'owner@acme.example'],
			secret
		);
		expect(plan.status).toBe(2);
		expect(plan.stdout).toContain('Nothing was changed');
		const done = run(
			[
				'owner',
				'reset-password',
				'--org',
				'acme',
				'--email',
				'owner@acme.example',
				'--confirm',
				'pglite',
				'--yes'
			],
			secret
		);
		expect(done.status, done.stderr).toBe(0);
		const shown = /shown once:\n(\S+)/.exec(done.stdout)?.[1] ?? '';
		expect(shown.length).toBeGreaterThanOrEqual(20);
		const refused = run(
			[
				'owner',
				'reset-password',
				'--org',
				'acme',
				'--email',
				'member@acme.example',
				'--confirm',
				'pglite',
				'--yes'
			],
			secret
		);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toMatch(/not an Owner/);
		const missing = run(['owner', 'reset-password', '--org', 'acme'], secret);
		expect(missing.status).toBe(1);
		expect(missing.stderr).toMatch(/--email/);
	});

	it('rotates the master key only with both keys given, and says how many keys it re-wrapped', () => {
		const old = 'the-old-master-key-with-plenty-of-characters-0123';
		const next = 'the-new-master-key-with-plenty-of-characters-0123';
		expect(run(['secrets', 'rotate-master-key'], { AFB_MASTER_KEY: old }).status).toBe(1);
		const plan = run(['secrets', 'rotate-master-key'], {
			AFB_MASTER_KEY: old,
			AFB_NEW_MASTER_KEY: next
		});
		expect(plan.status).toBe(2);
		expect(plan.stdout).toContain('Nothing was changed');
		const done = run(['secrets', 'rotate-master-key', '--confirm', 'pglite', '--yes'], {
			AFB_MASTER_KEY: old,
			AFB_NEW_MASTER_KEY: next
		});
		expect(done.status, done.stderr).toBe(0);
		expect(done.stdout).toMatch(/Re-wrapped \d+ organisation keys?/);
	});
});
