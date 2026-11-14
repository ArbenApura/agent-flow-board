// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED ENVS
import { AFB_BASE_URL } from '$app/env/private';
// IMPORTED MODULES
import { oauthMetadata } from '#lib/server/mcp/handler.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = () =>
	new Response(JSON.stringify(oauthMetadata(AFB_BASE_URL).authorizationServer), {
		headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }
	});
