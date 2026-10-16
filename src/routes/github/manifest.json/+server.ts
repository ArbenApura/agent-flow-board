// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- ENVS -- //
import { AFB_BASE_URL } from '$app/env/private';
// -- MODULES -- //
import { appManifest } from '#lib/server/github/install.js';

// -- FUNCTIONS -- //

/** The App manifest of this server. It holds addresses and permissions only, never a secret. */
export const GET: RequestHandler = () =>
	new Response(JSON.stringify(appManifest(AFB_BASE_URL), null, 2), {
		headers: { 'content-type': 'application/json' }
	});
