// ERASING AN ORGANISATION AFTER ITS GRACE PERIOD (FLOW-20261017-0007, ADR-014)
// The purge claims the org first, so a restore can no longer race it. Files go before the org row, because their keys live
// in the rows the cascade removes. Every step can run again after a failure.

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { Storage } from '../adapters/storage';
// -- DEP-MODULES -- //
import { and, eq, isNotNull, sql } from 'drizzle-orm';
// -- MODULES -- //
import {
	attachment,
	backupRun,
	deviceCode,
	mockupKit,
	mockupVersion,
	noteFile,
	org,
	orgDeletionLog
} from '../db/schema';
import { withTenant } from '../db/tenant';
import { ORG_DELETE_GRACE_DAYS, purgeAt } from './deletion';

// -- TYPES -- //

export type PurgeResult = 'purged' | 'not-due' | 'restored' | 'gone';

// -- CONSTANTS -- //

export const ORG_PURGE_SWEEP_JOB = 'org.purge.sweep';
export const ORG_PURGE_JOB = 'org.purge';

// -- FUNCTIONS -- //

/** The orgs whose grace period has ended. The sweep may read deleted orgs only (the `app.purge_sweep` setting), nothing else. */
export async function dueOrgPurges(handle: DbHandle, now = new Date()): Promise<string[]> {
	const cutoff = new Date(now.getTime() - ORG_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000);
	const rows = await withTenant(handle, { purgeSweep: true }, (tx) =>
		tx
			.select({ id: org.id })
			.from(org)
			.where(and(isNotNull(org.deletedAt), sql`${org.deletedAt} <= ${cutoff}`))
	);
	return rows.map((r) => r.id);
}

/** Deletes a stored file. A file that is already gone counts as deleted. */
async function removeFile(storage: Storage, key: string) {
	await storage.delete(key);
}

/**
 * Erases one org. Safe to call again: an org that is already gone is a success, one that was restored is left alone, one
 * that is not due yet is left alone. A storage failure other than "already gone" throws and keeps the org in its claimed
 * state, so the next call picks up where this one stopped.
 */
export async function purgeOrg(
	deps: { handle: DbHandle; storage: Storage | null; backups: Storage | null },
	orgId: string,
	now = new Date()
): Promise<PurgeResult> {
	const { handle } = deps;
	// Step 1: claim the org and list what has to be erased from storage
	const claimed = await withTenant(handle, { orgId }, async (tx) => {
		await tx.execute(sql`select id from org where id = ${orgId} for update`);
		const [row] = await tx
			.select({ deletedAt: org.deletedAt, purgeStartedAt: org.purgeStartedAt })
			.from(org)
			.where(eq(org.id, orgId));
		if (!row) return 'gone' as const;
		if (!row.deletedAt) return 'restored' as const;
		// Read again from the clock here, never from a date stored at delete time (ADR-016)
		if (purgeAt(row.deletedAt) > now) return 'not-due' as const;
		if (!row.purgeStartedAt)
			await tx
				.update(org)
				.set({ purgeStartedAt: sql`now()` })
				.where(eq(org.id, orgId));
		const files = await tx.select({ key: attachment.storageKey }).from(attachment);
		// Mockup versions, their screenshots and the project kits are stored files too
		const mockupFiles = await tx
			.select({ key: mockupVersion.storageKey, shot: mockupVersion.screenshotKey })
			.from(mockupVersion);
		const kitFiles = await tx.select({ key: mockupKit.storageKey }).from(mockupKit);
		// The pictures of notes
		const pictures = await tx.select({ key: noteFile.storageKey }).from(noteFile);
		const archives = await tx
			.select({ key: backupRun.location })
			.from(backupRun)
			.where(isNotNull(backupRun.location));
		return {
			files: [
				...files.map((f) => f.key),
				...mockupFiles.flatMap((f) => (f.shot ? [f.key, f.shot] : [f.key])),
				...kitFiles.map((f) => f.key),
				...pictures.map((f) => f.key)
			],
			archives: archives.map((a) => a.key!).filter(Boolean)
		};
	});
	if (typeof claimed === 'string') return claimed;

	// Step 2: erase the files, outside the database transaction because storage has none. Keys that cannot be erased fail loudly.
	if (!deps.storage && claimed.files.length)
		throw new Error(
			'This organisation has stored files but no file storage is configured to erase them'
		);
	if (!deps.backups && claimed.archives.length)
		throw new Error(
			'This organisation has backup archives but backup storage is not configured to erase them'
		);
	if (deps.storage) for (const key of claimed.files) await removeFile(deps.storage, key);
	if (deps.backups) for (const key of claimed.archives) await removeFile(deps.backups, key);

	// Step 3: delete the org row, guarded, and write the log row in the same transaction
	return withTenant(handle, { orgId }, async (tx) => {
		await tx.execute(sql`select id from org where id = ${orgId} for update`);
		const [row] = await tx
			.select({ name: org.name, slug: org.slug })
			.from(org)
			.where(and(eq(org.id, orgId), isNotNull(org.deletedAt), isNotNull(org.purgeStartedAt)));
		if (!row) return 'gone' as const;
		await tx.delete(org).where(and(eq(org.id, orgId), isNotNull(org.deletedAt)));
		// A device sign-in approved for this org has no foreign key, so it is cleared by hand
		await tx.delete(deviceCode).where(eq(deviceCode.approvedOrgId, orgId));
		await tx.insert(orgDeletionLog).values({
			orgId,
			orgName: row.name,
			orgSlug: row.slug,
			event: 'purged',
			actorUserId: null,
			actorLabel: 'Scheduled purge'
		});
		return 'purged' as const;
	});
}
