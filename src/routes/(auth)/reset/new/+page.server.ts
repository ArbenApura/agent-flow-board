// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { fail, redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { MIN_PASSWORD } from '#lib/server/auth/auth.js';
import { getAuth } from '#lib/server/auth/index.js';

// -- FUNCTIONS -- //

export const load: PageServerLoad = ({ url }) => ({
	token: url.searchParams.get('token') ?? '',
	invalid: url.searchParams.get('error') !== null || !url.searchParams.get('token'),
	minPassword: MIN_PASSWORD
});

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const token = String(data.get('token') ?? '');
		const password = String(data.get('password') ?? '');
		if (password.length < MIN_PASSWORD)
			return fail(400, {
				token,
				expired: false,
				message: `Use at least ${MIN_PASSWORD} characters.`
			});
		try {
			await (await getAuth()).api.resetPassword({ body: { newPassword: password, token } });
		} catch (e) {
			const err = e as { body?: { code?: string; message?: string } };
			if (err.body?.code === 'PASSWORD_COMPROMISED')
				return fail(400, {
					token,
					expired: false,
					message: 'That password appears in known data leaks. Choose a different one.'
				});
			return fail(400, {
				token,
				message: 'This link has expired or was already used. Ask for a new one.',
				expired: true
			});
		}
		redirect(303, '/sign-in?reset=1');
	}
};
