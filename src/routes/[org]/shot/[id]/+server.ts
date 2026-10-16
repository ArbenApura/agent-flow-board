// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- DEP-MODULES -- //
import { error } from '@sveltejs/kit';
// -- MODULES -- //
import { OpError } from '#lib/server/ops/context.js';
import { attachmentLink } from '#lib/server/ops/attachments.js';
import { orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * A UI shot picture, for an image tag. It checks that the signed in person may see the item and the private file, then sends
 * them to the short lived signed link. A picture of an item they may not see answers 404, the same as one that does not exist.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { ctx } = await orgContext(locals, params.org, url.pathname);
	let link;
	try {
		link = await attachmentLink(ctx, params.id);
	} catch (e) {
		if (e instanceof OpError) error(404, 'Not found');
		throw e;
	}
	// A plain response, because the link may point at another address (object storage), which redirect() refuses
	return new Response(null, {
		status: 302,
		headers: { location: link.url, 'cache-control': 'private, max-age=60' }
	});
};
