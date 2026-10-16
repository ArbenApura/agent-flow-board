// THE NIGHTLY BACKUP: ONE ENCRYPTED ARCHIVE PER ORG, KEPT BY RETENTION RULES, WITH AN ALERT AND A HEALTH FLAG WHEN IT FAILS OR IS LATE (L12)
// A published copy on GitHub is a reference, not a backup. This is the real one: database rows and attachment files, encrypted
// with BACKUP_KEY, stored apart from the app's own file storage.

// -- TYPES -- //
import type { Storage } from '../adapters/storage';
import type { DbHandle } from '../db/client';
import type { Mailer } from '../email/mailer';
import type { Admin } from './admin';
// -- DEP-MODULES -- //
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
// -- MODULES -- //
import { backupRun } from '../db/schema';
import { withTenant } from '../db/tenant';
import { writeArchive } from './archive';
import { exportOrg } from './dump';
import { inspectArchive } from './restore';

// -- TYPES -- //

export type Retention = { daily: number; weekly: number; monthly: number };
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

export const DEFAULT_RETENTION: Retention = { daily: 14, weekly: 8, monthly: 12 };
/** A backup older than this is late. The job runs nightly, so a day and a bit is the allowance. */
export const LATE_AFTER_HOURS = 30;
/** An instance wide job has no org of its own, but every job payload names one. */
export const NIL_ORG = '00000000-0000-0000-0000-000000000000';

// -- FUNCTIONS -- //

/** The keys of backups that stay: the newest N days, the newest of each of N weeks and N months. */
export function selectRetained(
	runs: { id: string; createdAt: Date }[],
	policy: Retention = DEFAULT_RETENTION
): Set<string> {
	const keep = new Set<string>();
	const sorted = [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	const seen = {
		daily: new Set<string>(),
		weekly: new Set<string>(),
		monthly: new Set<string>()
	};
	const week = (d: Date) => {
		const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
		const day = t.getUTCDay() || 7;
		t.setUTCDate(t.getUTCDate() + 4 - day);
		const start = Date.UTC(t.getUTCFullYear(), 0, 1);
		return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - start) / 86_400_000 + 1) / 7)}`;
	};
	for (const r of sorted) {
		const d = r.createdAt;
		const day = d.toISOString().slice(0, 10);
		const month = d.toISOString().slice(0, 7);
		if (!seen.daily.has(day) && seen.daily.size < policy.daily) {
			seen.daily.add(day);
			keep.add(r.id);
		}
		if (!seen.weekly.has(week(d)) && seen.weekly.size < policy.weekly) {
			seen.weekly.add(week(d));
			keep.add(r.id);
		}
		if (!seen.monthly.has(month) && seen.monthly.size < policy.monthly) {
			seen.monthly.add(month);
			keep.add(r.id);
		}
	}
	return keep;
}

export const archiveKey = (orgId: string, at: Date) =>
	`backups/${orgId}/${at.toISOString().replace(/[:.]/g, '-')}.afbbak`;

/** How the newest backups of one org look, for the health panel and the alert. */
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
	options: { now?: Date; retention?: Retention; skipIfWithinHours?: number } = {}
): Promise<
	{ orgId: string; state: 'done' | 'failed' | 'skipped'; location?: string; error?: string }[]
> {
	const now = options.now ?? new Date();
	const orgs = await deps.admin.query<{ id: string }>(
		`select "id" from "org" where "deleted_at" is null order by "id"`
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
		const [started] = await withTenant(deps.handle, { orgId }, (tx) =>
			tx.insert(backupRun).values({ orgId, state: 'running', createdAt: now }).returning()
		);
		try {
			const { frames, meta } = await exportOrg(deps.admin, deps.storage, orgId, now);
			if (meta.missingFiles.length)
				throw new Error(
					`${meta.missingFiles.length} attachment file${meta.missingFiles.length === 1 ? ' is' : 's are'} missing from storage, such as ${meta.missingFiles[0]}.`
				);
			const bytes = writeArchive(frames, deps.key);
			const location = archiveKey(orgId, now);
			await deps.backups.put(location, bytes, 'application/octet-stream');
			// Read it back and compare the size, so a backup that never reached its storage is not called done
			const back = await deps.backups.get(location);
			if (!back || back.length !== bytes.length)
				throw new Error('The backup could not be read back from its storage.');
			// And opened with the key: an archive that cannot be decrypted and counted is not a backup
			inspectArchive(back, deps.key);
			await withTenant(deps.handle, { orgId }, (tx) =>
				tx
					.update(backupRun)
					.set({ state: 'done', size: bytes.length, location })
					.where(eq(backupRun.id, started.id))
			);
			out.push({ orgId, state: 'done', location });
			await prune(deps, orgId, options.retention ?? DEFAULT_RETENTION);
		} catch (e) {
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

/** Removes the archives retention no longer keeps, and their rows. */
async function prune(
	deps: { handle: DbHandle; backups: Storage },
	orgId: string,
	retention: Retention
) {
	const rows = await withTenant(deps.handle, { orgId }, (tx) =>
		tx.select().from(backupRun).where(eq(backupRun.state, 'done'))
	);
	const keep = selectRetained(rows, retention);
	for (const r of rows) {
		if (keep.has(r.id)) continue;
		if (r.location) await deps.backups.delete(r.location).catch(() => undefined);
		await withTenant(deps.handle, { orgId }, (tx) =>
			tx.delete(backupRun).where(eq(backupRun.id, r.id))
		);
	}
}

/**
 * The late backup watch: when an org has no good backup within the allowance, a failed row says so once a day and the owners
 * are told. Runs hourly, so a job that stopped running at all is noticed too.
 */
export async function checkLateBackups(
	deps: { handle: DbHandle; admin: Admin; mailer?: Mailer },
	now = new Date()
): Promise<{ orgId: string; message: string }[]> {
	const orgs = await deps.admin.query<{ id: string }>(
		`select "id" from "org" where "deleted_at" is null order by "id"`
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
