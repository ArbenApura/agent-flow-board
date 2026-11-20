// THE NIGHTLY BACKUP: ONE ENCRYPTED ARCHIVE PER ORG, KEPT BY RETENTION RULES, WITH AN ALERT AND A HEALTH FLAG WHEN IT FAILS OR IS LATE (L12)
// Database rows and attachment files, encrypted
// with BACKUP_KEY, stored apart from the app's own file storage.

// IMPORTED TYPES
import type { Storage } from '../adapters/storage';
import type { DbHandle } from '../db/client';
import type { Mailer } from '../email/mailer';
import type { Admin } from './admin';
// IMPORTED DEP-MODULES
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { backupRun } from '../db/schema';
import { withTenant } from '../db/tenant';
import { writeArchiveStream } from './archive';
import { BackupBusyError, exportOrgTo } from './dump';
import { inspectArchiveStream } from './restore';

// -- TYPES -- //

/** How many good backups of one org are kept: the newest `max`, whatever their age. */
export type Retention = { max: number };
export type BackupHealth = {
	/** False when the newest backup failed, or none finished within the allowed age. */
	ok: boolean;
	lastOkAt: Date | null;
	ageHours: number | null;
	late: boolean;
	lastFailed: boolean;
	message: string | null;
};

// -- CONSTANTS -- //

/** At most this many successful backups are kept per org (owner, 2026-11-20). Older ones are removed after each good run. */
export const MAX_BACKUPS = 7;
export const DEFAULT_RETENTION: Retention = { max: MAX_BACKUPS };
/** A backup older than this is late. The job runs nightly, so a day and a bit is the allowance. */
export const LATE_AFTER_HOURS = 30;
/** An instance wide job has no org of its own, but every job payload names one. */
export const NIL_ORG = '00000000-0000-0000-0000-000000000000';
/** A run that says it is running for longer than this was killed (the server stopped or ran out of memory). */
export const STALE_RUN_HOURS = 6;

// -- FUNCTIONS -- //

/** The ids of the backups that stay: the newest `policy.max` of the good ones given. */
export function selectRetained(
	runs: { id: string; createdAt: Date }[],
	policy: Retention = DEFAULT_RETENTION
): Set<string> {
	const sorted = [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	return new Set(sorted.slice(0, Math.max(0, policy.max)).map((r) => r.id));
}

/** The SQL condition for an org whose automatic backups are on (a missing setting means on). */
const AUTO_ON = ` and coalesce(("settings"->>'autoBackups')::boolean, true)`;

export const archiveKey = (orgId: string, at: Date) =>
	`backups/${orgId}/${at.toISOString().replace(/[:.]/g, '-')}.afbbak`;

/** The time an archive was started, read from its name, or null when the name is not an archive name. */
export function archiveTime(key: string): number | null {
	const m = key.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.afbbak$/);
	return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}

/** How the newest backups of one org look, for the Organisation settings panel and the alert. */
export async function backupHealth(
	handle: DbHandle,
	orgId: string,
	now = new Date()
): Promise<BackupHealth> {
	const rows = await withTenant(handle, { orgId }, (tx) =>
		tx
			.select()
			.from(backupRun)
			.where(inArray(backupRun.state, ['done', 'failed']))
			.orderBy(desc(backupRun.createdAt))
			.limit(20)
	);
	const lastOk = rows.find((r) => r.state === 'done');
	const lastOkAt = lastOk?.createdAt ?? null;
	const ageHours = lastOkAt ? (now.getTime() - lastOkAt.getTime()) / 3_600_000 : null;
	const late = ageHours === null || ageHours > LATE_AFTER_HOURS;
	const lastFailed = rows[0]?.state === 'failed';
	const ok = !late && !lastFailed;
	return {
		ok,
		lastOkAt,
		ageHours,
		late,
		lastFailed,
		message: ok
			? null
			: lastFailed
				? `The last backup failed: ${rows[0].error ?? 'no reason was recorded'}`
				: lastOkAt
					? `The last good backup is ${Math.floor(ageHours!)} hours old.`
					: 'No backup has finished yet.'
	};
}

/** Tells the owners of an org that backups need attention. A mail that cannot be sent is logged, never thrown. */
async function alertOwners(
	admin: Admin,
	mailer: Mailer | undefined,
	orgId: string,
	message: string
) {
	console.error(`BACKUP ALERT for ${orgId}: ${message}`);
	if (!mailer) return;
	try {
		const owners = await admin.query<{ email: string; name: string; org: string }>(
			`select u."email", u."name", o."name" as org from "member" m join "user" u on u."id" = m."user_id" join "org" o on o."id" = m."org_id" left join "user_pref" p on p."user_id" = u."id" where m."org_id" = $1 and m."role" = 'owner' and coalesce((p."notifications"->>'backupAlerts')::boolean, true)`,
			[orgId]
		);
		for (const o of owners)
			await mailer.send({
				to: o.email,
				subject: `Backups of ${o.org} need attention`,
				text: `Hello ${o.name},\n\n${message}\n\nPlans and files are safe in the app for now, but a restore needs a recent backup. Ask whoever runs the server to look at the backup job.`,
				html: `<p>Hello ${o.name},</p><p>${message}</p><p>Plans and files are safe in the app for now, but a restore needs a recent backup. Ask whoever runs the server to look at the backup job.</p>`,
				tag: 'backup-alert'
			});
	} catch (e) {
		console.error('The backup alert could not be mailed', e);
	}
}

/**
 * Backs up every org. A failure of one org is recorded and alerted, and the others still run. Returns what happened per org.
 * `since` skips an org that already has a good backup that recent, so a repeated or overlapping job does nothing twice.
 */
export async function runBackup(
	deps: {
		handle: DbHandle;
		admin: Admin;
		storage: Storage | null;
		backups: Storage;
		key: string;
		mailer?: Mailer;
	},
	options: {
		now?: Date;
		retention?: Retention;
		skipIfWithinHours?: number;
		/** The nightly job passes true: an org that turned automatic backups off is left out. A run by hand takes every org. */
		onlyAutoBackups?: boolean;
	} = {}
): Promise<
	{ orgId: string; state: 'done' | 'failed' | 'skipped'; location?: string; error?: string }[]
> {
	const now = options.now ?? new Date();
	const orgs = await deps.admin.query<{ id: string }>(
		`select "id" from "org" where "deleted_at" is null${options.onlyAutoBackups ? AUTO_ON : ''} order by "id"`
	);
	const out: Awaited<ReturnType<typeof runBackup>> = [];
	for (const { id: orgId } of orgs) {
		if (options.skipIfWithinHours) {
			const recent = await withTenant(deps.handle, { orgId }, (tx) =>
				tx
					.select({ id: backupRun.id })
					.from(backupRun)
					.where(
						and(
							eq(backupRun.state, 'done'),
							sql`${backupRun.createdAt} > ${new Date(now.getTime() - options.skipIfWithinHours! * 3_600_000)}`
						)
					)
					.limit(1)
			);
			if (recent.length) {
				out.push({ orgId, state: 'skipped' });
				continue;
			}
		}
		// A run that was killed leaves its row saying running. It is marked failed once it is clearly not running any more
		await withTenant(deps.handle, { orgId }, (tx) =>
			tx
				.update(backupRun)
				.set({
					state: 'failed',
					error: 'The run was interrupted (the server stopped or ran out of memory).'
				})
				.where(
					and(
						eq(backupRun.state, 'running'),
						sql`${backupRun.createdAt} < ${new Date(now.getTime() - STALE_RUN_HOURS * 3_600_000)}`
					)
				)
		);
		const [started] = await withTenant(deps.handle, { orgId }, (tx) =>
			tx.insert(backupRun).values({ orgId, state: 'running', createdAt: now }).returning()
		);
		const location = archiveKey(orgId, now);
		// Set once this run has put its archive, so a failure before that never deletes another run's file at the same key
		let stored = false;
		try {
			// The archive is written as the org is read, a piece at a time, so memory stays flat whatever its size. The export
			// holds a lock per org: a second run (the command beside the nightly job) steps aside instead of running in parallel
			const written = await exportOrgTo(
				deps.admin,
				deps.storage,
				orgId,
				now,
				async (meta, frames) => {
					if (meta.missingFiles.length)
						throw new Error(
							`${meta.missingFiles.length} attachment file${meta.missingFiles.length === 1 ? ' is' : 's are'} missing from storage, such as ${meta.missingFiles[0]}.`
						);
					return deps.backups.putStream(
						location,
						writeArchiveStream(frames, deps.key),
						'application/octet-stream'
					);
				},
				{ lock: true }
			);
			stored = true;
			// Read it back and compare the size, so a backup that never reached its storage is not called done
			const size = await deps.backups.size(location);
			const back = size === written ? await deps.backups.getStream(location) : null;
			if (!back) throw new Error('The backup could not be read back from its storage.');
			// And opened with the key, block by block: an archive that cannot be decrypted and counted is not a backup
			await inspectArchiveStream(back, deps.key);
			await withTenant(deps.handle, { orgId }, (tx) =>
				tx
					.update(backupRun)
					.set({ state: 'done', size: written, location })
					.where(eq(backupRun.id, started.id))
			);
			out.push({ orgId, state: 'done', location });
			// A cleanup that fails must not take the verified backup with it
			await prune(deps, orgId, options.retention ?? DEFAULT_RETENTION, now).catch((e) =>
				console.error(`Pruning old backups of ${orgId} failed`, e)
			);
		} catch (e) {
			// What this run wrote is not a backup: it never stays at its place (a failed put already removed its own partial file)
			if (stored) await deps.backups.delete(location).catch(() => undefined);
			if (e instanceof BackupBusyError) {
				await withTenant(deps.handle, { orgId }, (tx) =>
					tx.delete(backupRun).where(eq(backupRun.id, started.id))
				);
				out.push({ orgId, state: 'skipped' });
				continue;
			}
			const message = e instanceof Error ? e.message : String(e);
			await withTenant(deps.handle, { orgId }, (tx) =>
				tx
					.update(backupRun)
					.set({ state: 'failed', error: message.slice(0, 500) })
					.where(eq(backupRun.id, started.id))
			);
			out.push({ orgId, state: 'failed', error: message });
			await alertOwners(deps.admin, deps.mailer, orgId, `Last night's backup failed: ${message}`);
		}
	}
	return out;
}

/**
 * Removes the archives retention no longer keeps, and their rows, then the archive files of this org that no row names. A file
 * that cannot be removed keeps its row, so the next run tries again, and the failure is logged: it is never swallowed.
 */
async function prune(
	deps: { handle: DbHandle; backups: Storage },
	orgId: string,
	retention: Retention,
	now: Date
) {
	const rows = await withTenant(deps.handle, { orgId }, (tx) =>
		tx.select().from(backupRun).where(eq(backupRun.state, 'done'))
	);
	const keep = selectRetained(rows, retention);
	for (const r of rows) {
		if (keep.has(r.id)) continue;
		if (r.location) {
			try {
				await deps.backups.delete(r.location);
			} catch (e) {
				console.error(`Backup file ${r.location} could not be removed, its record is kept`, e);
				continue;
			}
		}
		await withTenant(deps.handle, { orgId }, (tx) =>
			tx.delete(backupRun).where(eq(backupRun.id, r.id))
		);
	}
	await sweepOrphanFiles(deps, orgId, now);
}

/**
 * Deletes archive files in this org's folder that no backup record names (a killed run leaves one). Only a file older than the
 * time a run may take is touched, so a backup that is still being written is never removed. Returns how many went.
 */
export async function sweepOrphanFiles(
	deps: { handle: DbHandle; backups: Storage },
	orgId: string,
	now: Date
): Promise<number> {
	const files = await deps.backups.list(`backups/${orgId}`);
	if (!files.length) return 0;
	const rows = await withTenant(deps.handle, { orgId }, (tx) =>
		tx.select({ location: backupRun.location }).from(backupRun)
	);
	const known = new Set(rows.map((r) => r.location).filter((l): l is string => Boolean(l)));
	const oldest = now.getTime() - STALE_RUN_HOURS * 3_600_000;
	let removed = 0;
	for (const key of files) {
		if (known.has(key)) continue;
		const at = archiveTime(key);
		// A file that is not named like an archive, or is young enough to be a run in progress, is left alone
		if (at === null || at > oldest) continue;
		try {
			await deps.backups.delete(key);
			removed += 1;
		} catch (e) {
			console.error(`Orphan backup file ${key} could not be removed`, e);
		}
	}
	return removed;
}

/**
 * The late backup watch: when an org has no good backup within the allowance, a failed row says so once a day and the owners
 * are told. Runs hourly, so a job that stopped running at all is noticed too.
 */
export async function checkLateBackups(
	deps: { handle: DbHandle; admin: Admin; mailer?: Mailer },
	now = new Date()
): Promise<{ orgId: string; message: string }[]> {
	// An org that turned automatic backups off is paused, never late, so it gets no alert
	const orgs = await deps.admin.query<{ id: string }>(
		`select "id" from "org" where "deleted_at" is null${AUTO_ON} order by "id"`
	);
	const flagged: { orgId: string; message: string }[] = [];
	for (const { id: orgId } of orgs) {
		const health = await backupHealth(deps.handle, orgId, now);
		if (!health.late) continue;
		const message = health.message ?? 'No backup finished recently.';
		// Say it once a day, not every hour
		const [recent] = await withTenant(deps.handle, { orgId }, (tx) =>
			tx
				.select({ id: backupRun.id })
				.from(backupRun)
				.where(
					and(
						eq(backupRun.state, 'failed'),
						sql`${backupRun.createdAt} > ${new Date(now.getTime() - 24 * 3_600_000)}`
					)
				)
				.limit(1)
		);
		if (recent) continue;
		await withTenant(deps.handle, { orgId }, (tx) =>
			tx
				.insert(backupRun)
				.values({ orgId, state: 'failed', error: `Late. ${message}`, createdAt: now })
		);
		await alertOwners(deps.admin, deps.mailer, orgId, message);
		flagged.push({ orgId, message });
	}
	return flagged;
}
