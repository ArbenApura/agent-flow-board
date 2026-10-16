// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- ENVS -- //
import { BETTER_AUTH_SECRET } from '$app/env/private';
// -- DEP-MODULES -- //
import { error, json } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
// -- MODULES -- //
import { signBody } from '#lib/server/cloudflare/sign.js';
import { getJobs } from '#lib/server/jobs/index.js';

// -- FUNCTIONS -- //

/**
 * Runs one queued job. Only the Worker's own queue consumer calls it, with the body signed by a key only this app holds, so no
 * outside caller can run a job. A Node server has no queue and answers 404.
 */
export const POST: RequestHandler = async ({ request }) => {
	const jobs = await getJobs();
	if (!('runQueued' in jobs)) error(404, 'Not found');
	const body = await request.text();
	const want = Buffer.from(await signBody(BETTER_AUTH_SECRET, body));
	const got = Buffer.from(request.headers.get('x-afb-signature') ?? '');
	if (want.length !== got.length || !timingSafeEqual(want, got)) error(403, 'Not allowed');
	await (jobs as { runQueued(m: unknown): Promise<void> }).runQueued(JSON.parse(body));
	return json({ ok: true });
};
