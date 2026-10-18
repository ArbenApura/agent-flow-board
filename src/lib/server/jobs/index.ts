// THE APP'S BACKGROUND JOB RUNNER AND THE WATCHER THAT QUEUES AUTOMATIC PUBLISHES. STARTED ONCE WHEN THE SERVER STARTS.

// -- TYPES -- //
import type { JobRunner } from '../adapters/jobs';
// -- ENVS -- //
import { AFB_BASE_URL, BACKUP_KEY, DATABASE_OWNER_URL, DATABASE_URL } from '$app/env/private';
// -- MODULES -- //
import { pgBossJobs } from '../adapters/jobs';
import { getStorage } from '../adapters/index';
import { backupStorage, registerBackups } from '../backup/index';
import { NIL_ORG } from '../backup/run';
import { getMailer } from '../auth/index';
import { getDb } from '../db/index';
import { getGithub } from '../github/index';
import { SCHEDULE_JOB, registerPublishJobs } from '../github/jobs';
import { ORG_PURGE_JOB, ORG_PURGE_SWEEP_JOB, dueOrgPurges, purgeOrg } from '../orgs/purge';
import { getHub } from '../realtime/hub';

// -- CONSTANTS -- //

/** A burst of changes in one project becomes one look at it. */
const DEBOUNCE_MS = 3000;

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
	const github = getGithub();
	if (github)
		registerPublishJobs(jobs, {
			github,
			notify: { handle, mailer: getMailer(), baseUrl: AFB_BASE_URL }
		});
	const scheduleBackups = await registerBackups(jobs);
	const scheduleOrgPurge = registerOrgPurge(jobs, handle);
	await jobs.start();
	await scheduleBackups?.();
	await scheduleOrgPurge();
	if (github) {
		// Every change in any project asks the schedule job to look at that project once things settle
		const hub = await getHub(handle);
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		hub.subscribeAll((change) => {
			if (!change || change.k !== 'event') return;
			if (change.v?.startsWith('publish.') || change.v?.startsWith('github.')) return;
			clearTimeout(timers.get(change.p));
			timers.set(
				change.p,
				setTimeout(() => {
					timers.delete(change.p);
					void jobs
						.enqueue(SCHEDULE_JOB, { orgId: change.o, projectId: change.p })
						.catch((e) => console.error('Could not queue the publish check', e));
				}, DEBOUNCE_MS)
			);
		});
	}
	return jobs;
}

/** The runner, started on first use. */
export function getJobs(): Promise<JobRunner> {
	runner ??= open();
	return runner;
}
