// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { OpError } from '#lib/server/ops/context.js';
import { testCaseDetail, testingSheet } from '#lib/server/ops/testing.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * The Testing sheet of the project (AFB-20261127-0438): every case with its latest result per device, the last ten runs, the
 * latest run, coverage and open defects, filtered to the runs of plans the viewer may see. The case named by `case` in the
 * address also comes in full for the drawer. Testing is not shared with guests, like Notes. Refetched when the live stream
 * reports a change, so a run fills in on an open page.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	const none = { sheet: null, open: null };
	if (!summary) return { ...none, denied: null };
	if (summary.role === 'guest') return { ...none, denied: { needed: 'Viewer', role: 'Guest' } };
	const ctx = await childContext(locals, org.id);
	try {
		const key = url.searchParams.get('case');
		const [sheet, open] = await Promise.all([
			testingSheet(ctx, params.project),
			// A case key that does not exist simply opens nothing
			key
				? testCaseDetail(ctx, params.project, key).catch((e: unknown) => {
						if (e instanceof OpError && e.code === 'NOT_FOUND') return null;
						throw e;
					})
				: Promise.resolve(null)
		]);
		return { sheet, open, denied: null };
	} catch (e) {
		if (e instanceof OpError) return { ...none, ...pageError(e) };
		throw e;
	}
};
