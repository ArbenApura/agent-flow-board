// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { fail, redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { OrgError, createOrg, listMyOrgs } from '#lib/server/orgs/orgs.js';

// -- FUNCTIONS -- //

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/sign-in');
	if (!locals.user.emailVerified)
		redirect(303, `/verify?email=${encodeURIComponent(locals.user.email)}`);
	const orgs = await listMyOrgs(await getDb(), locals.user.id);
	return { user: { name: locals.user.name, email: locals.user.email }, orgs };
};

export const actions: Actions = {
	createOrg: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/sign-in');
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const slug = String(data.get('slug') ?? '')
			.trim()
			.toLowerCase();
		try {
			const created = await createOrg(await getDb(), locals.user.id, { name, slug });
			redirect(303, `/${created.slug}`);
		} catch (e) {
			if (e instanceof OrgError) return fail(400, { name, slug, message: e.message });
			throw e;
		}
	}
};
