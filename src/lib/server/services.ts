// THE OUTSIDE SERVICES A REQUEST OR A PAGE LOAD HANDS TO THE OPERATIONS LAYER, BUILT FROM THE ENVIRONMENT

// -- TYPES -- //
import type { Ctx } from './ops/context';
// -- ENVS -- //
import {
	AFB_BASE_URL,
	AFB_MASTER_KEY,
	AFB_RUNNER_QUEUE_MINUTES,
	BACKUP_KEY,
	BETTER_AUTH_SECRET,
	MOCKUP_ORIGIN
} from '$app/env/private';
// -- MODULES -- //
import { getStorage } from './adapters/index';
import { getMailer } from './auth/index';
import { getJobs } from './jobs/index';

// -- FUNCTIONS -- //

/** File storage, the public address, mail and the job runner. */
export async function appServices(): Promise<NonNullable<Ctx['services']>> {
	return {
		storage: getStorage(),
		baseUrl: AFB_BASE_URL,
		mailer: getMailer(),
		jobs: await getJobs(),
		backups: Boolean(BACKUP_KEY),
		masterKey: AFB_MASTER_KEY,
		runnerQueueMinutes: AFB_RUNNER_QUEUE_MINUTES,
		mockupSecret: BETTER_AUTH_SECRET,
		mockupOrigin: MOCKUP_ORIGIN
	};
}
