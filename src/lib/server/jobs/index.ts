// THE APP'S BACKGROUND JOB RUNNER STARTED ONCE WHEN THE SERVER STARTS.

// -- TYPES -- //
import type { JobRunner } from '../adapters/jobs';
// -- ENVS -- //
import { BACKUP_KEY, DATABASE_OWNER_URL, DATABASE_URL } from '$app/env/private';
// -- MODULES -- //
import { pgBossJobs } from '../adapters/jobs';
import { getStorage } from '../adapters/index';
import { backupStorage, registerBackups } from '../backup/index';
import { NIL_ORG } from '../backup/run';
import { getDb } from '../db/index';
import { ORG_PURGE_JOB, ORG_PURGE_SWEEP_JOB, dueOrgPurges, purgeOrg } from '../orgs/purge';

// -- STATES -- //

let runner: Promise<JobRunner> | null = null;

// -- FUNCTIONS -- //

/**
 * Erases the orgs an owner deleted once the grace period is over. An hourly sweep lists the due orgs and queues one purge
 * job for each; the purge job carries its own org id and may touch a deleted org (`allowLocked`). Nothing is erased
 * unless the sweep finds an org past its date.
 */
function registerOrgPurge(jobs: JobRunner, handle: Awaited<ReturnType<typeof getDb>>) {
	jobs.register(ORG_PURGE_SWEEP_JOB, async () => {
		for (const orgId of await dueOrgPurges(handle))
			await jobs.enqueue(ORG_PURGE_JOB, { orgId, allowLocked: true });
	});
	jobs.register(ORG_PURGE_JOB, async (job) => {
		const result = await purgeOrg(
			{ handle, storage: getStorage(), backups: BACKUP_KEY ? backupStorage() : null },
			job.payload.orgId
		);
		if (result === 'purged') console.info(`Organisation ${job.payload.orgId} was erased.`);
	});
	return () => jobs.schedule(ORG_PURGE_SWEEP_JOB, '15 * * * *', { orgId: NIL_ORG });
}

async function open(): Promise<JobRunner> {
	const handle = await getDb();
	// pg-boss makes its own tables, so it connects as the owner when there is one
	const jobs = await pgBossJobs(handle, (DATABASE_OWNER_URL ?? DATABASE_URL)!);
	const scheduleBackups = await registerBackups(jobs);
	const scheduleOrgPurge = registerOrgPurge(jobs, handle);
	await jobs.start();
	await scheduleBackups?.();
	await scheduleOrgPurge();
	return jobs;
}

/** The runner, started on first use. */
export function getJobs(): Promise<JobRunner> {
	runner ??= open();
	return runner;
}
