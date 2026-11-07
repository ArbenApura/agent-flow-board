// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { listMockups } from '#lib/server/ops/mockups.js';
import { getMockupSettings } from '#lib/server/ops/mockupSettings.js';
import { childContext } from '#lib/server/web/ctx.js';
import { cardThumb } from '#lib/server/web/mockupThumbs.js';

// -- FUNCTIONS -- //

/**
 * The mockups of the project this person may see, each with a 5 minute address for its thumbnail, and whether the person may
 * change the mockup style (admins and owners). The files are never in the page data, only their signed addresses.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { mockups: [], canManage: false, canWrite: false, styleSet: false };
	const ctx = await childContext(locals, org.id);
	const [list, settings] = await Promise.all([
		listMockups(ctx, { project: params.project }),
		getMockupSettings(ctx, params.project)
	]);
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
		canManage: settings.canManage,
		canWrite: summary.caps.includes('write'),
		styleSet: settings.style.text.trim().length > 0 || settings.kit !== null
	};
};
