// THE APP'S AUTH AND MAILER, BUILT ONCE FROM THE ENVIRONMENT

// IMPORTED TYPES
import type { Auth } from './auth';
import type { Mailer } from '../email/mailer';
// IMPORTED ENVS
import {
	AFB_BASE_URL,
	AFB_MAIL_FAIL_PATTERN,
	AFB_OUTBOX_FILE,
	AFB_PWNED_CHECK,
	AFB_RATE_LIMIT,
	BETTER_AUTH_SECRET,
	EMAIL_FROM,
	EMAIL_PROVIDER,
	GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET,
	POSTMARK_TOKEN,
	RESEND_API_KEY,
	SMTP_URL
} from '$app/env/private';
import { getRequestEvent } from '$app/server';
// IMPORTED DEP-MODULES
import { sveltekitCookies } from 'better-auth/svelte-kit';
// IMPORTED MODULES
import { getDb } from '../db';
import { createMailer } from '../email/mailer';
import { createAuth } from './auth';
import { resolveMethods, type EffectiveMethods } from './methods';

// -- STATES -- //

let mailer: Mailer | null = null;
let auth: Promise<Auth> | null = null;

// -- FUNCTIONS -- //

export function getMailer(): Mailer {
	mailer ??= createMailer({
		provider: EMAIL_PROVIDER,
		from: EMAIL_FROM,
		resendApiKey: RESEND_API_KEY,
		postmarkToken: POSTMARK_TOKEN,
		smtpUrl: SMTP_URL,
		outboxFile: AFB_OUTBOX_FILE,
		failPattern: AFB_MAIL_FAIL_PATTERN
	});
	return mailer;
}

/** The Google client from the environment: the fallback while no sign in methods are stored (AFB-20261123-1256). */
export const googleEnv = () => ({ clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET });

/** The sign in methods that are on right now: the stored choice, else the environment. Read fresh, so a change shows at once. */
export async function getMethods(): Promise<EffectiveMethods> {
	return resolveMethods((await getDb()).db, BETTER_AUTH_SECRET, googleEnv());
}

function buildAuth(): Promise<Auth> {
	return getDb().then(async (handle) => {
		const methods = await resolveMethods(handle.db, BETTER_AUTH_SECRET, googleEnv());
		return createAuth({
			handle,
			mailer: getMailer(),
			config: {
				secret: BETTER_AUTH_SECRET,
				baseUrl: AFB_BASE_URL,
				google: methods.google ?? undefined,
				passwordEnabled: methods.password,
				checkBreachedPasswords: AFB_PWNED_CHECK,
				disableRateLimit: !AFB_RATE_LIMIT,
				// Sets the session cookie from inside a form action
				plugins: [sveltekitCookies(getRequestEvent)]
			}
		});
	});
}

/** One instance per process. */
export function getAuth(): Promise<Auth> {
	auth ??= buildAuth();
	return auth;
}

/** Drops the built auth so the next request builds it again from the saved methods. Called after the methods change. */
export function resetAuth(): void {
	auth = null;
}
