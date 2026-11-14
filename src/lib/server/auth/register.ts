// SIGN UP AND RESEND, WITH A SEND FAILURE THAT IS NEVER HIDDEN (M2: "A VISIBLE ERROR WHEN EMAIL SENDING FAILS")
// Better Auth swallows a verification mail error during sign up, so the mail is sent here where its failure is seen.

// IMPORTED TYPES
import type { Auth } from './auth';
// IMPORTED MODULES
import { MailError } from '../email/mailer';

// -- TYPES -- //

export type RegisterResult =
	| { ok: true }
	| { ok: false; code: 'EMAIL_FAILED'; message: string; email: string }
	| {
			ok: false;
			code: 'EXISTS' | 'INVALID' | 'PASSWORD_COMPROMISED' | 'RATE_LIMITED';
			message: string;
	  };

// -- FUNCTIONS -- //

function failureOf(e: unknown): RegisterResult {
	const err = e as {
		status?: string;
		body?: { code?: string; message?: string };
		message?: string;
	};
	const code = err.body?.code ?? '';
	if (code === 'PASSWORD_COMPROMISED')
		return {
			ok: false,
			code: 'PASSWORD_COMPROMISED',
			message: 'That password appears in known data leaks. Choose a different one.'
		};
	if (err.status === 'TOO_MANY_REQUESTS')
		return {
			ok: false,
			code: 'RATE_LIMITED',
			message: 'Too many attempts. Wait a few minutes and try again.'
		};
	if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')
		return {
			ok: false,
			code: 'EXISTS',
			message: 'An account with this email already exists. Sign in or reset the password.'
		};
	return {
		ok: false,
		code: 'INVALID',
		message:
			err.body?.message ?? err.message ?? 'That did not work. Check the details and try again.'
	};
}

/** Sends the verification mail for an existing unverified account. A failed send comes back as EMAIL_FAILED. */
export async function resendVerification(
	auth: Auth,
	email: string,
	callbackURL = '/'
): Promise<RegisterResult> {
	try {
		await auth.api.sendVerificationEmail({ body: { email, callbackURL } });
		return { ok: true };
	} catch (e) {
		if (e instanceof MailError)
			return {
				ok: false,
				code: 'EMAIL_FAILED',
				email,
				message: `We could not send the email. ${e.message}`
			};
		const err = e as { status?: string; cause?: unknown };
		if (err.cause instanceof MailError)
			return {
				ok: false,
				code: 'EMAIL_FAILED',
				email,
				message: `We could not send the email. ${err.cause.message}`
			};
		return failureOf(e);
	}
}

/** Creates the account, then sends the verification mail. The account exists even when the send fails, so Resend works. */
export async function registerAccount(
	auth: Auth,
	input: { email: string; password: string; name: string; headers?: Headers }
): Promise<RegisterResult> {
	try {
		await auth.api.signUpEmail({
			body: { email: input.email, password: input.password, name: input.name },
			headers: input.headers
		});
	} catch (e) {
		return failureOf(e);
	}
	return resendVerification(auth, input.email);
}
