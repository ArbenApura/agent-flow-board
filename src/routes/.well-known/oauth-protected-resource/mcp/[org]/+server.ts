// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED ENVS
import { AFB_BASE_URL } from '$app/env/private';
// IMPORTED MODULES
import { isOrgSlug } from '#lib/shared/orgConnection.js';
import { oauthMetadata } from '#lib/server/mcp/handler.js';

// -- FUNCTIONS -- //

/** The discovery document of one org address. It reads no database, so an existing and an unknown slug answer the same. */
export const GET: RequestHandler = ({ params }) => {
	const slug = params.org.toLowerCase();
	if (!isOrgSlug(slug)) return new Response('Not found', { status: 404 });
	return new Response(JSON.stringify(oauthMetadata(AFB_BASE_URL, slug).protectedResource), {
		headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }
	});
};
