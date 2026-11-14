// IMPORTED DEP-TYPES
import type { LayoutServerLoad } from './$types';
// IMPORTED MODULES
import { avatarVersion } from '#lib/board/pictures.js';
import { purgeTrashIfDue } from '#lib/server/ops/history.js';
import { listProjects } from '#lib/server/ops/projects.js';
import { orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The org of the URL and the projects the person can see. Every page below reads them from here. */
export const load: LayoutServerLoad = async ({ params, locals, url }) => {
	const { ctx, org: found, user } = await orgContext(locals, params.org, url.pathname);
	const { palette, ...org } = found;
	// Things stay in the trash for 30 days, then the first person to open the org that day clears them out
	await purgeTrashIfDue(ctx).catch((e) => console.error('Could not clear the trash', e));
	const projects = await listProjects(ctx);
	return {
		orgPalette: palette,
		org,
		me: { id: user.id, name: user.name, email: user.email, imageV: avatarVersion(user) },
		projects: projects.map((p) => ({
			id: p.id,
			key: p.key,
			name: p.name,
			webApp: p.webApp,
			logoV: p.logoV
		}))
	};
};
