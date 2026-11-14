// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED MODULES
import { getDb } from '#lib/server/db/index.js';
import { isOAuthError, registerClient } from '#lib/server/oauth/oauth.js';
import { json, preflight } from '#lib/server/oauth/http.js';

// -- FUNCTIONS -- //

export const OPTIONS: RequestHandler = () => preflight();

/** Dynamic client registration (RFC 7591). The client is stored as unverified and the consent page says so. */
export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid_request', error_description: 'The body must be JSON.' }, 400);
	}
	const result = await registerClient(await getDb(), body);
	return isOAuthError(result) ? json(result, 400) : json(result, 201);
};
