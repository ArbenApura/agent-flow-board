// IMPORTED DEP-TYPES
import type { Actions, PageServerLoad } from './$types';
// IMPORTED DEP-MODULES
import { fail, redirect } from '@sveltejs/kit';
// IMPORTED MODULES
import { MIN_PASSWORD } from '#lib/server/auth/auth.js';
import { getAuth, googleEnabled } from '#lib/server/auth/index.js';
import { safeNext } from '#lib/server/auth/next.js';
import { registerAccount } from '#lib/server/auth/register.js';

// -- FUNCTIONS -- //

export const load: PageServerLoad = ({ url }) => ({
	next: safeNext(url.searchParams.get('next')),
	google: googleEnabled(),
	minPassword: MIN_PASSWORD
});

export const actions: Actions = {
	register: async ({ request }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const email = String(data.get('email') ?? '').trim();
		const password = String(data.get('password') ?? '');
		const next = safeNext(data.get('next'));
		if (name.length < 2)
			return fail(400, { name, email, next, field: 'name', message: 'Enter your name.' });
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
			return fail(400, {
				name,
				email,
				next,
				field: 'email',
				message: 'Enter a full email address.'
			});
		if (password.length < MIN_PASSWORD)
			return fail(400, {
				name,
				email,
				next,
				field: 'password',
				message: `Use at least ${MIN_PASSWORD} characters for the password.`
			});
		const result = await registerAccount(await getAuth(), {
			name,
			email,
			password,
			headers: request.headers
		});
		if (result.ok)
			redirect(
				303,
				`/verify?email=${encodeURIComponent(email)}&sent=1&next=${encodeURIComponent(next)}`
			);
		if (result.code === 'EMAIL_FAILED') {
			// The account exists, so the page shows the reason and a resend button instead of pretending it worked
			redirect(
				303,
				`/verify?email=${encodeURIComponent(email)}&failed=1&next=${encodeURIComponent(next)}`
			);
		}
		return fail(400, {
			name,
			email,
			next,
			field: result.code === 'PASSWORD_COMPROMISED' ? 'password' : 'email',
			code: result.code,
			message: result.message
		});
	},
	google: async ({ request }) => {
		const data = await request.formData();
		const next = safeNext(data.get('next'));
		const res = await (
			await getAuth()
		).api.signInSocial({
			body: { provider: 'google', callbackURL: next, requestSignUp: true },
			headers: request.headers
		});
		if (res.url) redirect(303, res.url, { external: true });
		return fail(500, { next, message: 'Google sign in is not available right now.' });
	}
};
