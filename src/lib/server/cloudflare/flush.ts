// WHAT A WORKER DOES WHEN A REQUEST, A QUEUE MESSAGE OR A CRON RUN HAS FINISHED: TELL THE HUB, AND QUEUE THE PUBLISH CHECK (SPEC 12)
// A change is announced only after the work that made it is done and committed, so a page that refetches at once sees it.

// -- TYPES -- //
import type { Change } from '../realtime/notify';
import type { HubNamespace } from './hub';
// -- MODULES -- //
import { getGithub } from '../github/index';
import { SCHEDULE_JOB } from '../github/jobs';
import { getJobs } from '../jobs/index';
import { currentPlatform, pendingChanges } from '../platform';
import { publishChanges } from './hub';

// -- CONSTANTS -- //

/** A burst of changes in one project becomes one look at it, as on a server. */
const DEBOUNCE_SECONDS = 3;

// -- FUNCTIONS -- //

/** Sends the changes the current work made. Does nothing on a Node server, where the database announces them. */
export async function flushChanges(): Promise<void> {
	const platform = currentPlatform();
	if (!platform) return;
	const list = pendingChanges<Change>();
	if (!list.length) return;
	const changes = list.splice(0, list.length);
	const hub = platform.env.AFB_HUB as HubNamespace | undefined;
	if (hub) await publishChanges(hub, changes);
	// Every change in a project asks the schedule job to look at it once things settle
	if (!getGithub() || !platform.env.AFB_QUEUE) return;
	const projects = new Map<string, Change>();
	for (const c of changes) {
		if (c.k !== 'event' || c.v?.startsWith('publish.') || c.v?.startsWith('github.')) continue;
		projects.set(c.p, c);
	}
	if (!projects.size) return;
	const jobs = await getJobs();
	await Promise.all(
		[...projects.values()].map((c) =>
			jobs
				.enqueue(
					SCHEDULE_JOB,
					{ orgId: c.o, projectId: c.p },
					{ runAt: new Date(Date.now() + DEBOUNCE_SECONDS * 1000) }
				)
				.catch((e) => console.error('Could not queue the publish check', e))
		)
	);
}
