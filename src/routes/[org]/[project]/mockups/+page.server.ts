// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { listMockups } from '#lib/server/ops/mockups.js';
import { childContext } from '#lib/server/web/ctx.js';
import { cardThumb } from '#lib/server/web/mockupThumbs.js';

// -- FUNCTIONS -- //

/**
 * The mockups of the project this person may see, each with a 5 minute address for its thumbnail. The files are never in the
 * page data, only their signed addresses.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { mockups: [], canWrite: false };
	const ctx = await childContext(locals, org.id);
	const list = await listMockups(ctx, { project: params.project });
	return {
		mockups: list.mockups.map((m) => ({
			id: m.id,
			title: m.title,
			itemId: m.itemId,
			currentVersion: m.currentVersion,
			versions: m.versions,
			hasShot: m.hasShot,
			visibility: m.visibility,
			publicLinkOn: m.publicLinkOn,
			updatedAt: m.updatedAt,
			plan: m.plan,
			...cardThumb(org.id, m)
		})),
		canWrite: summary.caps.includes('write')
	};
};
