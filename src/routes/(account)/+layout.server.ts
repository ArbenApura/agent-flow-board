// -- DEP-TYPES -- //
import type { LayoutServerLoad } from './$types';
// -- MODULES -- //
import { avatarVersion } from '#lib/board/pictures.js';
import { getDb } from '#lib/server/db/index.js';
import { listMyOrgs } from '#lib/server/orgs/orgs.js';
import { requireUser } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The pages that belong to no organisation: the person and the organisations they are in, for the sidebar. */
export const load: LayoutServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals, url.pathname);
	const orgs = await listMyOrgs(await getDb(), user.id);
	return {
		me: { id: user.id, name: user.name, email: user.email, imageV: avatarVersion(user) },
		orgs: orgs.map((o) => ({
			id: o.id,
			name: o.name,
			slug: o.slug,
			role: o.role,
			logo: o.logo,
			palette: o.palette,
			deleted: o.deletedAt !== null
		}))
	};
};
