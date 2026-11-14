// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- DEP-MODULES -- //
import { error } from '@sveltejs/kit';
// -- MODULES -- //
import { OpError } from '#lib/server/ops/context.js';
import { serveAttachmentResponse } from '#lib/server/ops/attachments.js';
import { orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * Serves one attachment picture or evidence file. Check-evidence and mockup-derived assets are served directly with the same
 * sandbox and nosniff headers as /pictures instead of a redirect. Other files redirect through a short-lived signed link.
 */
export const GET: RequestHandler = async ({ params, locals, url, request }) => {
	const { ctx } = await orgContext(locals, params.org, url.pathname);
	try {
		return await serveAttachmentResponse(ctx, params.id, request.headers.get('if-none-match'));
	} catch (e) {
		if (e instanceof OpError) error(404, 'Not found');
		throw e;
	}
};
