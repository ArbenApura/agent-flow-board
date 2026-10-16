// THE RUNNER API: THE SMALL SET OF CALLS A RUNNER PROGRAM MAKES WITH ITS OWN TOKEN (SPEC 10)
// A runner token belongs to one org and serves the projects an admin chose. It can take a queued run, read the test accounts of
// that one run's project while the run is running, upload evidence and report a result. It can do nothing else: it is not a person
// and not a personal access token, and a personal token cannot do any of this.

// -- TYPES -- //
import type { Ctx } from '../ops/context';
import type { ApiDeps, ApiRequest, ApiResponse } from './dispatch';
// -- MODULES -- //
import {
	claimCheckJob,
	finishCheckRun,
	peekQueue,
	releaseRunnerRuns,
	runAccounts,
	storeRunArtifact
} from '../ops/checks';
import {
	authenticateRunKey,
	authenticateRunner,
	makeRunKey,
	RUN_KEY_PREFIX
} from '../ops/environments';
import { claimShotsJob, finishShotsRun, shotsAccounts, storeShotImage } from '../ops/uiShots';
import { MAX_ATTACHMENT_BYTES } from '../ops/attachments';
import { NO_STORE, errorResponse, fail } from './respond';

// -- CONSTANTS -- //

const ok = (body: unknown): ApiResponse => ({ status: 200, headers: NO_STORE, body });

// -- FUNCTIONS -- //

function json(req: ApiRequest): unknown {
	const text = new TextDecoder().decode(req.body);
	if (text.trim() === '') return {};
	return JSON.parse(text);
}

/** Handles one call of a runner. Every answer is uncached, and nothing about a refusal says more than it must. */
export async function handleRunnerApi(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
	try {
		const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
		// A throwaway container holds a key for one run, never the runner token (L1)
		const runKey = bearer?.startsWith(RUN_KEY_PREFIX)
			? await authenticateRunKey(deps.handle, bearer, deps.masterKey)
			: null;
		const auth = runKey ?? (bearer ? await authenticateRunner(deps.handle, bearer) : null);
		if (!auth) return fail(401, 'UNAUTHENTICATED', 'The runner token is not valid or was removed.');
		const services: Ctx['services'] = {
			storage: deps.storage,
			baseUrl: deps.baseUrl,
			masterKey: deps.masterKey,
			runnerQueueMinutes: deps.runnerQueueMinutes
		};
		const [, , kind, id, action] = req.path.split('/');
		const route = `${req.method} ${kind ?? ''}${id ? '/:id' : ''}${action ? `/${action}` : ''}`;
		if (runKey && (kind !== runKey.runKind || id !== runKey.runId))
			return fail(403, 'FORBIDDEN', 'This key opens one run only.');

		if (route === 'POST claim') {
			// A check run first, then a shots or measure run
			const job =
				(await claimCheckJob(deps.handle, auth, services)) ??
				(await claimShotsJob(deps.handle, auth, services));
			// The run's own key goes with it, for a supervisor that hands the run to a throwaway container
			const key =
				job && deps.masterKey
					? makeRunKey(deps.masterKey, job.kind === 'check' ? 'runs' : 'shots', auth, job.id)
					: null;
			return ok({ job, runKey: key });
		}
		if (route === 'POST peek') return ok({ waiting: await peekQueue(deps.handle, auth) });
		if (route === 'POST release')
			return ok({ released: await releaseRunnerRuns(deps.handle, auth) });
		if (req.body.byteLength > MAX_ATTACHMENT_BYTES + 1024)
			return fail(413, 'INVALID', 'The upload is larger than 15 MB.');
		if (route === 'GET runs/:id/accounts')
			return ok({ accounts: await runAccounts(deps.handle, auth, id, services) });
		if (route === 'GET shots/:id/accounts')
			return ok({ accounts: await shotsAccounts(deps.handle, auth, id, services) });
		if (route === 'POST runs/:id/artifacts')
			return ok(
				await storeRunArtifact(
					deps.handle,
					auth,
					id,
					{
						filename: req.query.filename ?? '',
						caption: req.query.caption ?? 'Evidence',
						bytes: req.body
					},
					services
				)
			);
		if (route === 'POST shots/:id/images')
			return ok(
				await storeShotImage(
					deps.handle,
					auth,
					id,
					{
						filename: req.query.filename ?? '',
						caption: req.query.caption ?? 'UI shot',
						bytes: req.body
					},
					services
				)
			);
		if (route === 'POST runs/:id/finish')
			return ok(await finishCheckRun(deps.handle, auth, id, json(req) as never, services));
		if (route === 'POST shots/:id/finish')
			return ok(await finishShotsRun(deps.handle, auth, id, json(req) as never));
		return fail(404, 'NOT_FOUND', 'No such runner call.');
	} catch (e) {
		if (e instanceof SyntaxError) return fail(400, 'INVALID', 'The body must be valid JSON.');
		return errorResponse(e);
	}
}
