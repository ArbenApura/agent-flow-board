// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED MODULES
import { OpError } from '#lib/server/ops/context.js';
import { exportAsMarkdown, exportProject } from '#lib/server/ops/settings.js';
import { orgContext } from '#lib/server/web/ctx.js';
import { error } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** The project's public items as one readable Markdown file, as a download. */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { ctx } = await orgContext(locals, params.org, url.pathname);
	try {
		const out = await exportProject(ctx, params.project);
		return new Response(exportAsMarkdown(out.files), {
			headers: {
				'content-type': 'text/markdown; charset=utf-8',
				'content-disposition': `attachment; filename="${out.key}.md"`,
				'cache-control': 'private, no-store'
			}
		});
	} catch (e) {
		if (e instanceof OpError) error(e.code === 'FORBIDDEN' ? 403 : 404, 'Not found');
		throw e;
	}
};
