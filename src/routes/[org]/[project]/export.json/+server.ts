// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { exportProject } from '#lib/server/ops/settings.js';
import { orgContext } from '#lib/server/web/ctx.js';
import { OpError } from '#lib/server/ops/context.js';
import { error } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** The lossless JSON snapshot of the project's public items, as a download. */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { ctx } = await orgContext(locals, params.org, url.pathname);
	try {
		const out = await exportProject(ctx, params.project);
		return new Response(out.files['snapshot.json'], {
			headers: {
				'content-type': 'application/json',
				'content-disposition': `attachment; filename="${out.key}-snapshot.json"`,
				'cache-control': 'private, no-store'
			}
		});
	} catch (e) {
		if (e instanceof OpError) error(e.code === 'FORBIDDEN' ? 403 : 404, 'Not found');
		throw e;
	}
};
