// IMPORTED DEP-TYPES
import type { Actions } from './$types';
// IMPORTED ENVS
import { AFB_BASE_URL } from '$app/env/private';
// IMPORTED DEP-MODULES
import { fail } from '@sveltejs/kit';
// IMPORTED MODULES
import { getAuth } from '#lib/server/auth/index.js';

// -- FUNCTIONS -- //

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
			return fail(400, { email, message: 'Enter a full email address.' });
		try {
			await (
				await getAuth()
			).api.requestPasswordReset({
				body: { email, redirectTo: `${AFB_BASE_URL}/reset/new` },
				headers: request.headers
			});
		} catch (e) {
			// The answer is the same whether or not the account exists, so this page cannot be used to find accounts
			console.error('Password reset mail failed', e instanceof Error ? e.message : e);
		}
		return { email, sent: true };
	}
};
