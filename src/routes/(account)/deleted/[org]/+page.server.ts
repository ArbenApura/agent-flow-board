// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { error, fail, redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { purgeAt } from '#lib/server/orgs/deletion.js';
import { OrgError, orgForSlugIncludingDeleted, restoreOrg } from '#lib/server/orgs/orgs.js';
import { requireUser } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The page of an organisation that an owner deleted. Members read the date, an owner can restore it. */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = requireUser(locals, url.pathname);
	const org = await orgForSlugIncludingDeleted(await getDb(), params.org, user.id);
	if (!org) error(404, 'Not found');
	// An organisation that is not deleted has its normal pages
	if (!org.deletedAt) redirect(303, `/${org.slug}`);
	return {
		org: { name: org.name, slug: org.slug },
		deletedAt: org.deletedAt.toISOString(),
		purgeAt: purgeAt(org.deletedAt).toISOString(),
		purging: org.purgeStartedAt !== null,
		isOwner: org.role === 'owner'
	};
};

export const actions: Actions = {
	/** Brings the organisation back. The verb checks the live Owner role and refuses once the erase has started. */
	restore: async ({ locals, params, url }) => {
		const user = requireUser(locals, url.pathname);
		const handle = await getDb();
		const org = await orgForSlugIncludingDeleted(handle, params.org, user.id);
		if (!org) error(404, 'Not found');
		try {
			await restoreOrg(handle, org.id, user.id);
		} catch (e) {
			if (e instanceof OrgError) return fail(400, { message: e.message });
			throw e;
		}
		redirect(303, `/${org.slug}`);
	}
};
