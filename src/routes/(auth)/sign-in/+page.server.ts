// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { fail, redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { getAuth, googleEnabled } from '#lib/server/auth/index.js';
import { safeNext } from '#lib/server/auth/next.js';
import { resendVerification } from '#lib/server/auth/register.js';

// -- FUNCTIONS -- //

export const load: PageServerLoad = ({ url }) => ({
	next: safeNext(url.searchParams.get('next')),
	google: googleEnabled(),
	reset: url.searchParams.get('reset') === '1'
});

export const actions: Actions = {
	signIn: async ({ request }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim();
		const password = String(data.get('password') ?? '');
		const next = safeNext(data.get('next'));
		if (!email || !password)
			return fail(400, { email, next, code: 'MISSING', message: 'Enter your email and password.' });
		const auth = await getAuth();
		try {
			await auth.api.signInEmail({ body: { email, password }, headers: request.headers });
		} catch (e) {
			const err = e as { status?: string; body?: { code?: string; message?: string } };
			const code = err.body?.code;
			if (code === 'ACCOUNT_LOCKED' || err.status === 'TOO_MANY_REQUESTS') {
				return fail(429, {
					email,
					next,
					code: 'LOCKED',
					message: err.body?.message ?? 'Too many attempts. Wait a few minutes and try again.'
				});
			}
			if (err.status === 'FORBIDDEN' || code === 'EMAIL_NOT_VERIFIED') {
				return fail(403, {
					email,
					next,
					code: 'UNVERIFIED',
					message: 'Confirm your email address first. Use the button below to get a new link.'
				});
			}
			// The same words for an unknown email and a wrong password, so the page does not reveal which accounts exist
			return fail(400, {
				email,
				next,
				code: 'INVALID',
				message: 'The email or the password is not right.'
			});
		}
		redirect(303, next);
	},
	resend: async ({ request }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim();
		const next = safeNext(data.get('next'));
		if (!email)
			return fail(400, {
				email,
				next,
				code: 'MISSING',
				message: 'Enter your email address first.'
			});
		const result = await resendVerification(await getAuth(), email);
		if (!result.ok)
			return fail(502, { email, next, code: 'EMAIL_FAILED', message: result.message });
		redirect(303, `/verify?email=${encodeURIComponent(email)}&sent=1`);
	},
	google: async ({ request }) => {
		const data = await request.formData();
		const next = safeNext(data.get('next'));
		const auth = await getAuth();
		const res = await auth.api.signInSocial({
			body: { provider: 'google', callbackURL: next },
			headers: request.headers
		});
		if (res.url) redirect(303, res.url, { external: true });
		return fail(500, {
			email: '',
			next,
			code: 'GOOGLE',
			message: 'Google sign in is not available right now.'
		});
	}
};
