// IMPORTED DEP-TYPES
import type { Actions, PageServerLoad } from './$types';
// IMPORTED DEP-MODULES
import { fail, redirect } from '@sveltejs/kit';
// IMPORTED MODULES
import { getDb } from '#lib/server/db/index.js';
import { acceptInvite, describeInvite } from '#lib/server/orgs/invites.js';

// -- FUNCTIONS -- //

export const load: PageServerLoad = async ({ params, locals }) => {
	const handle = await getDb();
	const invite = await describeInvite(handle, params.token);
	return {
		invite,
		person: locals.user ? { email: locals.user.email, verified: locals.user.emailVerified } : null,
		next: `/invite/${params.token}`
	};
};

export const actions: Actions = {
	accept: async ({ params, locals }) => {
		if (!locals.user)
			redirect(303, `/sign-in?next=${encodeURIComponent(`/invite/${params.token}`)}`);
		const result = await acceptInvite(await getDb(), params.token, {
			id: locals.user.id,
			email: locals.user.email,
			emailVerified: locals.user.emailVerified
		});
		if (!result.ok) return fail(400, { code: result.code, message: result.message });
		redirect(303, `/${result.orgSlug}`);
	}
};
