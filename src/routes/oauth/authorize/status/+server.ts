// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED DEP-MODULES
import { json } from '@sveltejs/kit';
// IMPORTED MODULES
import { getDb } from '#lib/server/db/index.js';
import { approvalStatus } from '#lib/server/oauth/oauth.js';

// -- FUNCTIONS -- //

/** Whether the tool has finished connecting, so the consent page left open can update itself. Signed in people only, and only their own approval. */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user)
		return json({ status: 'none' }, { status: 401, headers: { 'cache-control': 'no-store' } });
	const status = await approvalStatus(await getDb(), {
		orgId: url.searchParams.get('org') ?? '',
		userId: locals.user.id,
		clientId: url.searchParams.get('client_id') ?? '',
		challenge: url.searchParams.get('code_challenge') ?? ''
	});
	return json({ status }, { headers: { 'cache-control': 'no-store' } });
};
