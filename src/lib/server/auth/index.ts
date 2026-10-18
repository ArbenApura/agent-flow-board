// THE APP'S AUTH AND MAILER, BUILT ONCE FROM THE ENVIRONMENT

// -- TYPES -- //
import type { Auth } from './auth';
import type { Mailer } from '../email/mailer';
// -- ENVS -- //
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
// -- DEP-MODULES -- //
import { sveltekitCookies } from 'better-auth/svelte-kit';
// -- MODULES -- //
import { getDb } from '../db';
import { createMailer } from '../email/mailer';
import { createAuth } from './auth';

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

function buildAuth(): Promise<Auth> {
	return getDb().then((handle) =>
		createAuth({
			handle,
			mailer: getMailer(),
			config: {
				secret: BETTER_AUTH_SECRET,
				baseUrl: AFB_BASE_URL,
				google:
					GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
						? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
						: undefined,
				checkBreachedPasswords: AFB_PWNED_CHECK,
				disableRateLimit: !AFB_RATE_LIMIT,
				// Sets the session cookie from inside a form action
				plugins: [sveltekitCookies(getRequestEvent)]
			}
		})
	);
}

/** One instance per process. */
export function getAuth(): Promise<Auth> {
	auth ??= buildAuth();
	return auth;
}

/** Whether Google sign in is configured, so the page shows the button only when it can work. */
export const googleEnabled = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
