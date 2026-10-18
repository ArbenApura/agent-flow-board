// THE APP'S BACKUP SETUP FROM THE ENVIRONMENT: WHERE ARCHIVES GO, THE PRIVILEGED CONNECTION, AND THE NIGHTLY AND HOURLY JOBS
// Backups stay off until BACKUP_KEY is set. A key on a PostgreSQL server with no backup connection stops the app at start.

// -- TYPES -- //
import type { JobRunner } from '../adapters/jobs';
import type { Storage } from '../adapters/storage';
import type { Admin } from './admin';
// -- ENVS -- //
import {
	AFB_BACKUP_HOUR,
	BACKUP_DIR,
	BACKUP_KEY,
	BACKUP_S3_ACCESS_KEY_ID,
	BACKUP_S3_BUCKET,
	BACKUP_S3_ENDPOINT,
	BACKUP_S3_SECRET_ACCESS_KEY,
	BETTER_AUTH_SECRET,
	DATABASE_BACKUP_URL
} from '$app/env/private';
// -- MODULES -- //
import { diskStorage, s3Storage } from '../adapters/storage';
import { getStorage } from '../adapters/index';
import { getMailer } from '../auth/index';
import { getDb } from '../db/index';
import { pgAdmin } from './admin';
import { NIL_ORG, checkLateBackups, runBackup } from './run';

// -- CONSTANTS -- //

export const BACKUP_JOB = 'backup.nightly';
export const BACKUP_CHECK_JOB = 'backup.check';

// -- FUNCTIONS -- //

export function backupStorage(): Storage {
	if (
		BACKUP_S3_ENDPOINT ||
		BACKUP_S3_BUCKET ||
		BACKUP_S3_ACCESS_KEY_ID ||
		BACKUP_S3_SECRET_ACCESS_KEY
	) {
		if (!(
			BACKUP_S3_ENDPOINT &&
			BACKUP_S3_BUCKET &&
			BACKUP_S3_ACCESS_KEY_ID &&
			BACKUP_S3_SECRET_ACCESS_KEY
		))
			throw new Error(
				'S3 backups need BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY together'
			);
		return s3Storage({
			endpoint: BACKUP_S3_ENDPOINT,
			bucket: BACKUP_S3_BUCKET,
			accessKeyId: BACKUP_S3_ACCESS_KEY_ID,
			secretAccessKey: BACKUP_S3_SECRET_ACCESS_KEY
		});
	}
	return diskStorage(BACKUP_DIR ?? '.afb/backups', BETTER_AUTH_SECRET);
}

async function backupAdmin(): Promise<Admin> {
	if (!DATABASE_BACKUP_URL)
		throw new Error(
			'BACKUP_KEY is set, so DATABASE_BACKUP_URL is required: a PostgreSQL role that bypasses row level security, used only by backups.'
		);
	return pgAdmin(DATABASE_BACKUP_URL);
}

/**
 * Registers the backup jobs (before the runner starts) and returns the function that puts them on their schedules: the backup
 * every night, the late watch every hour (after it started). Null while BACKUP_KEY is unset.
 */
export async function registerBackups(jobs: JobRunner): Promise<(() => Promise<void>) | null> {
	if (!BACKUP_KEY) return null;
	const handle = await getDb();
	const admin = await backupAdmin();
	const backups = backupStorage();
	const payload = { orgId: NIL_ORG };
	jobs.register(BACKUP_JOB, async () => {
		// A backup the same night already finished is not made twice, whichever process the schedule woke
		const results = await runBackup(
			{ handle, admin, storage: getStorage(), backups, key: BACKUP_KEY!, mailer: getMailer() },
			{ skipIfWithinHours: 20 }
		);
		for (const r of results)
			if (r.state === 'failed') console.error(`Backup of ${r.orgId} failed: ${r.error}`);
	});
	jobs.register(BACKUP_CHECK_JOB, async () => {
		await checkLateBackups({ handle, admin, mailer: getMailer() });
	});
	return async () => {
		await jobs.schedule(BACKUP_JOB, `0 ${AFB_BACKUP_HOUR} * * *`, payload);
		await jobs.schedule(BACKUP_CHECK_JOB, '30 * * * *', payload);
	};
}
