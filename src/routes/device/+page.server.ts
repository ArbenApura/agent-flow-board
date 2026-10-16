// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { fail, redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import {
	approveDevice,
	describeDevice,
	grantableCaps,
	isOAuthError
} from '#lib/server/oauth/oauth.js';
import { listMyOrgs } from '#lib/server/orgs/orgs.js';

// -- FUNCTIONS -- //

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) redirect(303, `/sign-in?next=${encodeURIComponent('/device')}`);
	return {};
};

/** The code is typed by the person and never taken from the address, so a link cannot pre fill and phish it (L6). */
export const actions: Actions = {
	lookup: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/sign-in');
		const typed = String((await request.formData()).get('code') ?? '');
		const handle = await getDb();
		const info = await describeDevice(handle, typed);
		if (!info)
			return fail(400, {
				step: 'code',
				message: 'That code is not valid or has expired. Check the code in your tool.'
			});
		// An org scheduled for deletion cannot be connected to
		const orgs = (await listMyOrgs(handle, locals.user.id)).filter((o) => !o.deletedAt);
		const withCaps = await Promise.all(
			orgs.map(async (o) => ({
				id: o.id,
				name: o.name,
				role: o.role,
				caps: await grantableCaps(handle, o.id, locals.user!.id)
			}))
		);
		return { step: 'confirm', typed: info.userCode, info, orgs: withCaps };
	},
	approve: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/sign-in');
		const data = await request.formData();
		const result = await approveDevice(await getDb(), {
			userId: locals.user.id,
			typed: String(data.get('code') ?? ''),
			orgId: String(data.get('org') ?? ''),
			scopes: data.getAll('scope').map(String) as never
		});
		if (isOAuthError(result)) return fail(400, { step: 'code', message: result.error_description });
		return { step: 'done', client: result.client, approved: true };
	},
	deny: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/sign-in');
		const data = await request.formData();
		const result = await approveDevice(await getDb(), {
			userId: locals.user.id,
			typed: String(data.get('code') ?? ''),
			orgId: '',
			scopes: [],
			deny: true
		});
		if (isOAuthError(result)) return fail(400, { step: 'code', message: result.error_description });
		return { step: 'done', client: result.client, approved: false };
	}
};
