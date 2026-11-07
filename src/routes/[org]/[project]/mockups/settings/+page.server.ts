// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { childContext } from '#lib/server/web/ctx.js';
import { mockupSettingsPage } from '#lib/server/web/mockupSettingsPage.js';

// -- FUNCTIONS -- //

/**
 * The mockup settings of the project. Everyone who can see the project reads them, admins and owners change them. The tab is read
 * in the page from the address, never here, so a click on a tab does not run this again.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:settings');
	const { org, summary } = await parent();
	if (!summary) return { settings: null, projectName: '', projectKey: params.project };
	const ctx = await childContext(locals, org.id);
	return {
		settings: await mockupSettingsPage(ctx, params.project),
		projectName: summary.project.name,
		projectKey: summary.project.key
	};
};
