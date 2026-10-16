// THE PUBLISH JOBS, REGISTERED ON WHATEVER JOB RUNNER THE DEPLOYMENT USES (MEMORY, pg-boss OR QUEUES)

// -- TYPES -- //
import type { JobRunner } from '../adapters/jobs';
import type { DbHandle } from '../db/client';
import type { Mailer } from '../email/mailer';
import type { GithubApi } from './app';
// -- MODULES -- //
import { notifyPublishPaused } from './notify';
import { PUBLISH_JOB, executeRun, scheduleAutoPublish } from './publish';

// -- CONSTANTS -- //

/** Looks at one project after a change and queues an automatic publish when one is due. */
export const SCHEDULE_JOB = 'publish.schedule';

// -- FUNCTIONS -- //

export function registerPublishJobs(
	runner: JobRunner,
	deps: { github: GithubApi; notify?: { handle: DbHandle; mailer: Mailer; baseUrl: string } }
) {
	runner.register(PUBLISH_JOB, async (job) => {
		const { paused } = await executeRun(job, deps.github, runner);
		// A pause is said out loud to the people who manage the project, unless they asked not to be told
		if (paused && deps.notify && job.payload.projectId)
			await notifyPublishPaused(deps.notify, job.payload.orgId, job.payload.projectId, paused);
	});
	runner.register(SCHEDULE_JOB, async (job) => {
		await scheduleAutoPublish(job, runner);
	});
}
