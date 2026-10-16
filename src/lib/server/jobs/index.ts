// THE APP'S BACKGROUND JOB RUNNER AND THE WATCHER THAT QUEUES AUTOMATIC PUBLISHES. STARTED ONCE WHEN THE SERVER STARTS.

// -- TYPES -- //
import type { JobRunner } from '../adapters/jobs';
// -- ENVS -- //
import { AFB_BASE_URL, AFB_JOBS, DATABASE_OWNER_URL, DATABASE_URL } from '$app/env/private';
// -- MODULES -- //
import { memoryJobs, pgBossJobs, queuesJobs, type QueueLike } from '../adapters/jobs';
import { currentPlatform, requestScoped, type Platform } from '../platform';
import { registerBackups } from '../backup/index';
import { getMailer } from '../auth/index';
import { getDb } from '../db/index';
import { getGithub } from '../github/index';
import { SCHEDULE_JOB, registerPublishJobs } from '../github/jobs';
import { getHub } from '../realtime/hub';

// -- CONSTANTS -- //

/** A burst of changes in one project becomes one look at it. */
const DEBOUNCE_MS = 3000;

// -- STATES -- //

let runner: Promise<JobRunner> | null = null;

// -- FUNCTIONS -- //

async function open(): Promise<JobRunner> {
	const handle = await getDb();
	const mode = AFB_JOBS ?? (DATABASE_URL ? 'pgboss' : 'memory');
	const jobs =
		mode === 'pgboss'
			? await pgBossJobs(handle, (DATABASE_OWNER_URL ?? DATABASE_URL)!)
			: memoryJobs(handle);
	const github = getGithub();
	if (github)
		registerPublishJobs(jobs, {
			github,
			notify: { handle, mailer: getMailer(), baseUrl: AFB_BASE_URL }
		});
	const scheduleBackups = await registerBackups(jobs);
	await jobs.start();
	await scheduleBackups?.();
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

/**
 * Jobs on a Worker go through the queue bound to the current request, and its handlers run in the queue consumer. There is no
 * background watcher and no nightly backup here: the Worker reports changes when a request ends, and backups are run by the
 * operator command against the database (docs/cloudflare.md).
 */
async function openWorkers(platform: Platform): Promise<JobRunner> {
	const handle = await getDb();
	const jobs = queuesJobs(handle, platform.env.AFB_QUEUE as QueueLike);
	const github = getGithub();
	if (github)
		registerPublishJobs(jobs, {
			github,
			notify: { handle, mailer: getMailer(), baseUrl: AFB_BASE_URL }
		});
	return jobs;
}

/** The runner, started on first use. */
export function getJobs(): Promise<JobRunner> {
	const platform = currentPlatform();
	if (platform?.env.AFB_QUEUE) return requestScoped('jobs', () => openWorkers(platform));
	runner ??= open();
	return runner;
}
