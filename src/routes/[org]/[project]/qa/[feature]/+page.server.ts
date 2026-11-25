// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { OpError } from '#lib/server/ops/context.js';
import { featureDetail } from '#lib/server/ops/qa.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * One feature of the QA map: its journeys, the latest result of each case with its picture, the runs that tested it a page at
 * a time, and its open bugs. An unknown feature is a 404; guests get the permission panel, as on the Testing page.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { detail: null, canWrite: false, denied: null };
	if (summary.role === 'guest')
		return { detail: null, canWrite: false, denied: { needed: 'Viewer', role: 'Guest' } };
	const ctx = await childContext(locals, org.id);
	// A whole number from 0 to 10,000, whatever the address holds
	const runsOffset = Math.min(
		10_000,
		Math.max(0, Math.trunc(Number(url.searchParams.get('runs') ?? 0) || 0))
	);
	try {
		const detail = await featureDetail(ctx, {
			project: params.project,
			feature: params.feature,
			runsOffset
		});
		return { detail, canWrite: summary.caps.includes('write'), denied: null };
	} catch (e) {
		if (e instanceof OpError) return { detail: null, canWrite: false, ...pageError(e) };
		throw e;
	}
};
