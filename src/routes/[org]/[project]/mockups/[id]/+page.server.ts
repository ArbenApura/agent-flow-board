// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { error } from '@sveltejs/kit';
import { ALL_SCREENS } from '#lib/board/mockups.js';
import { OpError } from '#lib/server/ops/context.js';
import { listMockupPins } from '#lib/server/ops/mockupPins.js';
import { getMockupSource } from '#lib/server/ops/mockupParts.js';
import { getMockup, listMockups, mockupFileGrant } from '#lib/server/ops/mockups.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';
import { memberMockupUrl } from '#lib/server/web/mockupLinks.js';
// -- FUNCTIONS -- //

/**
 * One mockup for the viewer: its versions, the version named by `?v=` (the newest by default) with a 5 minute address for its
 * file, the pins of every version, and the four screens every project draws at. The build notes are untrusted text and are shown as text.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) error(404, 'Not found');
	const ctx = await childContext(locals, org.id);
	const asked = Number(url.searchParams.get('v'));
	try {
		const first = await getMockup(ctx, params.id);
		const version =
			Number.isInteger(asked) && first.versions.some((v) => v.number === asked)
				? asked
				: first.mockup.currentVersion;
		const [detail, pins, grant, source] = await Promise.all([
			version === first.mockup.currentVersion ? first : getMockup(ctx, params.id, version),
			listMockupPins(ctx, params.id),
			mockupFileGrant(ctx, params.id, { version }),
			// What the page costs to read. A failure here only hides the card, never the mockup
			getMockupSource(ctx, params.id, { version }).catch(() => null)
		]);
		// The other mockups of the same plan, for the switch in the header. A mockup with no plan has none
		const siblings = detail.plan
			? (await listMockups(ctx, { project: params.project, item: detail.plan.ref })).mockups.map(
					(s) => ({ id: s.id, title: s.title, currentVersion: s.currentVersion })
				)
			: [];
		return {
			detail,
			siblings,
			version,
			pins: pins.pins,
			source,
			screens: ALL_SCREENS,
			src: memberMockupUrl(grant),
			denied: null
		};
	} catch (e) {
		if (e instanceof OpError) {
			// A refusal that pageError turns into a value (no access) is a 403 here, never a page with no data
			pageError(e);
			error(403, 'You cannot open this mockup.');
		}
		throw e;
	}
};
