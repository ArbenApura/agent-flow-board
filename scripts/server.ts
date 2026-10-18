// THE SERVER COMMAND. OPERATOR ONLY: BACKUPS, AND RESTORES THAT CHANGE DATA FOR REAL. NOTHING HERE IS REACHABLE FROM THE WEB APP.
//
//   yarn server backup run                       back up every org now
//   yarn server backup list                      the recorded backups
//   yarn server backup verify <file>             decrypt and check an archive, change nothing
//   yarn server restore org <file> [--replace] [--scratch-url <url>] --confirm <database> --yes
//   yarn server restore full <dir> --confirm <database> --yes
//   yarn server owner reset-password --org <slug> --email <address> [--password <new>] --confirm <database> --yes
//   yarn server secrets rotate-master-key --confirm <database> --yes
//
// A restore prints what it would do and stops unless --yes is given with --confirm naming the database it will change.
// Settings come from the environment, the same names the app uses: DATABASE_URL (and DATABASE_OWNER_URL), DATABASE_BACKUP_URL
// (a role that bypasses row level security, required on PostgreSQL), BACKUP_KEY, BACKUP_DIR, AFB_STORAGE_DIR.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diskStorage, s3Storage } from '../src/lib/server/adapters/storage';
import { pgAdmin, type Admin } from '../src/lib/server/backup/admin';
import { inspectArchive, restoreAll, restoreOrg } from '../src/lib/server/backup/restore';
import { runBackup } from '../src/lib/server/backup/run';
import { createPostgres, type DbHandle } from '../src/lib/server/db/client';

const env = process.env;
const [group, command, ...rest] = process.argv.slice(2);
const WITH_VALUE = new Set(['--confirm', '--scratch-url', '--org', '--email', '--password']);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
// The words that are not flags and not the value of a flag
const positional = rest.filter(
	(a, i) => !a.startsWith('--') && !(i > 0 && WITH_VALUE.has(rest[i - 1]))
);

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const needsBackupKey = group === 'backup' || group === 'restore';
const key = env.BACKUP_KEY ?? '';
if (needsBackupKey && key.length < 32)
	fail('BACKUP_KEY is required and must be at least 32 characters.');

const databaseName = (url: string) => new URL(url).pathname.replace(/^\//, '') || 'postgres';
const secret = env.BETTER_AUTH_SECRET ?? 'server-command-no-signed-links-needed';
/** S3 compatible storage when its four settings are given (the same names the app reads), otherwise a folder on disk. */
function storageFor(prefix: string, dir: string) {
	const e = (name: string) => env[`${prefix}${name}`];
	const set = ['ENDPOINT', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].map((n) => e(n));
	if (set.some(Boolean)) {
		if (!set.every(Boolean))
			fail(
				`${prefix}ENDPOINT, ${prefix}BUCKET, ${prefix}ACCESS_KEY_ID and ${prefix}SECRET_ACCESS_KEY must be given together.`
			);
		return s3Storage({
			endpoint: e('ENDPOINT')!,
			bucket: e('BUCKET')!,
			accessKeyId: e('ACCESS_KEY_ID')!,
			secretAccessKey: e('SECRET_ACCESS_KEY')!
		});
	}
	return diskStorage(resolve(dir), secret);
}
const files = storageFor('S3_', env.AFB_STORAGE_DIR ?? '.afb/files');
const backups = storageFor('BACKUP_S3_', env.BACKUP_DIR ?? '.afb/backups');

let handle = null as DbHandle | null;
let admin = null as (Admin & { close?: () => Promise<void> }) | null;
let target = '';
let targetName = '';

async function open() {
	const url = env.DATABASE_URL;
	const backupUrl = env.DATABASE_BACKUP_URL;
	if (!url) return fail('DATABASE_URL is required: the PostgreSQL database to run this on.');
	if (!backupUrl)
		return fail(
			'DATABASE_BACKUP_URL is required: a role that bypasses row level security, used only here.'
		);
	handle = await createPostgres({
		runtimeUrl: env.DATABASE_OWNER_URL ? url : undefined,
		ownerUrl: env.DATABASE_OWNER_URL ?? url
	});
	admin = pgAdmin(backupUrl);
	target = `the PostgreSQL database "${databaseName(backupUrl)}"`;
	targetName = databaseName(backupUrl);
}

/** Every archive under a folder, the newest of each org (the folder per org that backups write). */
function newestPerOrg(dir: string): string[] {
	const out: string[] = [];
	const root = resolve(dir);
	const orgs = existsDir(join(root, 'backups')) ? join(root, 'backups') : root;
	for (const org of readdirSync(orgs)) {
		const folder = join(orgs, org);
		if (!statSync(folder).isDirectory()) continue;
		const archives = readdirSync(folder)
			.filter((f) => f.endsWith('.afbbak'))
			.sort();
		if (archives.length) out.push(join(folder, archives[archives.length - 1]));
	}
	return out;
}
const existsDir = (p: string) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

function confirmed(plan: string[]) {
	console.log(['This will change data for real.', `Database: ${target}`, ...plan].join('\n'));
	if (!flag('--yes') || option('--confirm') !== targetName) {
		console.log(
			`\nNothing was changed. To go ahead, repeat the command with --confirm ${targetName} --yes`
		);
		process.exit(2);
	}
}

try {
	if (group === 'backup' && command === 'verify') {
		const file = positional[0] ?? fail('Give the archive file.');
		const { meta } = inspectArchive(readFileSync(file), key);
		console.log(
			`OK. Organisation ${meta.orgSlug} (${meta.orgId}), made ${meta.createdAt}, migration ${meta.migrations.at(-1)}, ${meta.files} files.`
		);
		for (const [name, t] of Object.entries(meta.tables)) console.log(`  ${name}: ${t.count}`);
		if (meta.missingFiles.length) console.log(`Missing files: ${meta.missingFiles.join(', ')}`);
	} else if (group === 'backup' && command === 'run') {
		await open();
		const results = await runBackup({
			handle: handle!,
			admin: admin!,
			storage: files,
			backups,
			key
		});
		for (const r of results)
			console.log(
				`${r.orgId}: ${r.state}${r.error ? ` (${r.error})` : ''}${r.location ? ` ${r.location}` : ''}`
			);
		if (results.some((r) => r.state === 'failed')) process.exitCode = 1;
	} else if (group === 'backup' && command === 'list') {
		await open();
		const rows = await admin!.query<Record<string, unknown>>(
			`select "org_id", "state", "size", "location", "created_at", "error" from "backup_run" order by "created_at" desc limit 100`
		);
		for (const r of rows)
			console.log(
				`${String(r.created_at)}  ${r.org_id}  ${r.state}  ${r.size ?? ''}  ${r.location ?? ''}  ${r.error ?? ''}`
			);
		if (!rows.length) console.log('No backups recorded.');
	} else if (group === 'restore' && command === 'org') {
		const file = positional[0] ?? fail('Give the archive file.');
		await open();
		const { meta } = inspectArchive(readFileSync(file), key);
		const scratchUrl = option('--scratch-url');
		confirmed([
			`Restore organisation ${meta.orgSlug} (${meta.orgId}) from ${file}, made ${meta.createdAt}.`,
			flag('--replace')
				? 'Its current rows are removed first and replaced by the backup.'
				: 'The organisation must not exist there yet.',
			scratchUrl
				? `It is first loaded into the scratch database "${databaseName(scratchUrl)}" and checked.`
				: 'No scratch check (add --scratch-url to check first).'
		]);
		const scratch = scratchUrl ? pgAdmin(scratchUrl) : undefined;
		const result = await restoreOrg(readFileSync(file), key, admin!, {
			scratch,
			storage: files,
			replace: flag('--replace')
		});
		console.log(
			`Restored ${result.orgSlug}: ${Object.values(result.tables).reduce((a, b) => a + b, 0)} rows, ${result.files} files.`
		);
		await scratch?.close();
	} else if (group === 'restore' && command === 'full') {
		const dir = positional[0] ?? fail('Give the folder of backups.');
		await open();
		const list = newestPerOrg(dir);
		if (!list.length) fail('No backups found there.');
		confirmed([
			`Restore ${list.length} organisation(s) into an EMPTY database:`,
			...list.map((f) => `  ${f}`)
		]);
		const results = await restoreAll(
			list.map((f) => readFileSync(f)),
			key,
			admin!,
			{ storage: files }
		);
		for (const r of results)
			console.log(
				`Restored ${r.orgSlug}: ${Object.values(r.tables).reduce((a, b) => a + b, 0)} rows, ${r.files} files.`
			);
	} else if (group === 'owner' && command === 'reset-password') {
		// For a server with no email: sets a new password for an Owner, ends their sessions and clears their lockout (L11)
		const slug = option('--org') ?? fail('Give the organisation: --org <slug>.');
		const email = option('--email') ?? fail('Give the Owner: --email <address>.');
		await open();
		confirmed([`Set a new password for the Owner ${email} of ${slug} and end their sessions.`]);
		const { createAuth } = await import('../src/lib/server/auth/auth');
		const { resetOwnerPassword } = await import('../src/lib/server/orgs/ownerReset');
		const auth = createAuth({
			handle: handle!,
			mailer: { kind: 'log', send: async () => undefined },
			config: {
				secret: env.BETTER_AUTH_SECRET ?? fail('BETTER_AUTH_SECRET is required.'),
				baseUrl: env.AFB_BASE_URL ?? 'http://localhost',
				checkBreachedPasswords: false,
				disableRateLimit: true
			}
		});
		const done = await resetOwnerPassword(handle!, auth, {
			orgSlug: slug,
			email,
			newPassword: option('--password')
		});
		console.log(`New password for ${email}, shown once:\n${done.password}`);
	} else if (group === 'secrets' && command === 'rotate-master-key') {
		// The old key is AFB_MASTER_KEY, the new one AFB_NEW_MASTER_KEY. Neither is a command line argument, so neither is in a process list
		const oldKey = env.AFB_MASTER_KEY ?? fail('AFB_MASTER_KEY (the key now in use) is required.');
		const newKey =
			env.AFB_NEW_MASTER_KEY ?? fail('AFB_NEW_MASTER_KEY (the key to change to) is required.');
		await open();
		confirmed([
			'Re-wrap every organisation secret key with the new master key.',
			'Afterwards set AFB_MASTER_KEY to the new key and restart the app.'
		]);
		const { rotateMasterKey } = await import('../src/lib/server/secrets/vault');
		const done = await rotateMasterKey(admin!, oldKey, newKey);
		console.log(
			`Re-wrapped ${done.rewrapped} organisation key${done.rewrapped === 1 ? '' : 's'}. Set AFB_MASTER_KEY to the new key now.`
		);
	} else {
		console.error(
			'Usage:\n  yarn server backup run | list | verify <file>\n  yarn server restore org <file> [--replace] [--scratch-url <url>] --confirm <database> --yes\n  yarn server restore full <dir> --confirm <database> --yes\n  yarn server owner reset-password --org <slug> --email <address> [--password <new>] --confirm <database> --yes\n  yarn server secrets rotate-master-key --confirm <database> --yes (old key in AFB_MASTER_KEY, new key in AFB_NEW_MASTER_KEY)'
		);
		process.exitCode = 1;
	}
} finally {
	await handle?.close();
	await admin?.close?.();
}
