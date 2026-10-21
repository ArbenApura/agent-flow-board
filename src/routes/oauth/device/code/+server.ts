// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- ENVS -- //
import { AFB_BASE_URL } from '$app/env/private';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { isOAuthError, startDevice } from '#lib/server/oauth/oauth.js';
import { json, preflight, readParams } from '#lib/server/oauth/http.js';

// -- FUNCTIONS -- //

export const OPTIONS: RequestHandler = () => preflight();

/** Starts a device sign in (RFC 8628). The reply carries the code the person types at /device. */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const p = await readParams(request);
	let origin = '';
	try {
		origin = getClientAddress();
	} catch {
		/* No address behind some adapters */
	}
	const started = await startDevice(await getDb(), AFB_BASE_URL, {
		client_name: p.client_name,
		origin,
		code_challenge: p.code_challenge,
		code_challenge_method: p.code_challenge_method
	});
	return json(started, isOAuthError(started) ? 400 : 200);
};
