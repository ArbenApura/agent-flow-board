// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { fail } from '@sveltejs/kit';
// -- MODULES -- //
import { getAuth } from '#lib/server/auth/index.js';
import { safeNext } from '#lib/server/auth/next.js';
import { resendVerification } from '#lib/server/auth/register.js';

// -- FUNCTIONS -- //

export const load: PageServerLoad = ({ url, locals }) => ({
	email: url.searchParams.get('email') ?? locals.user?.email ?? '',
	sent: url.searchParams.get('sent') === '1',
	failed: url.searchParams.get('failed') === '1',
	next: safeNext(url.searchParams.get('next')),
	verified: !!locals.user?.emailVerified
});

export const actions: Actions = {
	resend: async ({ request }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim();
		if (!email) return fail(400, { email, code: 'MISSING', message: 'Enter your email address.' });
		const result = await resendVerification(await getAuth(), email, safeNext(data.get('next')));
		if (!result.ok)
			return fail(result.code === 'EMAIL_FAILED' ? 502 : 400, {
				email,
				code: result.code,
				message: result.message
			});
		return { email, resent: true, code: 'SENT', message: '' };
	}
};
