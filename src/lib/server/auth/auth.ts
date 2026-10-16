// BETTER AUTH SETUP: EMAIL WITH PASSWORD AND GOOGLE ONLY, NO TWO STEP VERIFICATION (ADR-007)

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { Mailer } from '../email/mailer';
// -- DEP-MODULES -- //
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { haveIBeenPwned } from 'better-auth/plugins';
// -- MODULES -- //
import { authAccount, authRateLimit, authSession, authVerification, user } from '../db/schema';
import { resetPasswordMail, verifyEmailMail } from '../email/templates';
import { noteSignIn } from './devices';
import { lockedMinutes, recordFailure, recordSuccess } from './lockout';
import { googleProfileGuard } from './unverified';

// -- TYPES -- //

export type AuthConfig = {
	secret: string;
	baseUrl: string;
	google?: { clientId: string; clientSecret: string };
	/** Checks new passwords against the Have I Been Pwned range API. Only 5 characters of a hash leave the server. */
	checkBreachedPasswords: boolean;
	/** Extra plugins, for example the SvelteKit cookie bridge, supplied by the app and not needed in tests. */
	plugins?: NonNullable<Parameters<typeof betterAuth>[0]['plugins']>;
	/** Turns the request limits off. Only for tests that sign in many times. */
	disableRateLimit?: boolean;
};

// -- CONSTANTS -- //

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 128;

// -- FUNCTIONS -- //

export function createAuth(deps: { handle: DbHandle; mailer: Mailer; config: AuthConfig }) {
	const { handle, mailer, config } = deps;
	const db = handle.db;
	const secure = config.baseUrl.startsWith('https://');

	return betterAuth({
		appName: 'agent-flow-board',
		baseURL: config.baseUrl,
		secret: config.secret,
		database: drizzleAdapter(db, {
			provider: 'pg',
			schema: {
				user,
				session: authSession,
				account: authAccount,
				verification: authVerification,
				rateLimit: authRateLimit
			}
		}),
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			minPasswordLength: MIN_PASSWORD,
			maxPasswordLength: MAX_PASSWORD,
			autoSignIn: false,
			resetPasswordTokenExpiresIn: 60 * 60,
			revokeSessionsOnPasswordReset: true,
			// A failed send throws, so the page shows the reason and a resend button instead of pretending it worked
			sendResetPassword: async ({ user: u, url }) => {
				await mailer.send(resetPasswordMail(u.email, u.name, url));
			}
		},
		emailVerification: {
			// The sign up action sends the mail itself, so a failed send is seen and can be retried (register.ts)
			sendOnSignUp: false,
			sendOnSignIn: true,
			autoSignInAfterVerification: true,
			expiresIn: 60 * 60,
			sendVerificationEmail: async ({ user: u, url }) => {
				await mailer.send(verifyEmailMail(u.email, u.name, url));
			}
		},
		socialProviders: config.google
			? {
					google: {
						clientId: config.google.clientId,
						clientSecret: config.google.clientSecret,
						// An unverified duplicate of the same address is discarded first (L4)
						mapProfileToUser: googleProfileGuard(db)
					}
				}
			: {},
		account: {
			// Linking only into an already verified local account, never into an unverified one (L4)
			accountLinking: {
				enabled: true,
				trustedProviders: ['google'],
				requireLocalEmailVerified: true
			}
		},
		session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
		rateLimit: {
			enabled: !config.disableRateLimit,
			storage: 'database',
			window: 60,
			max: 100,
			customRules: {
				'/sign-in/email': { window: 60, max: 10 },
				'/sign-up/email': { window: 3600, max: 10 },
				'/request-password-reset': { window: 3600, max: 5 },
				'/send-verification-email': { window: 3600, max: 5 }
			}
		},
		advanced: { cookiePrefix: 'afb', useSecureCookies: secure },
		plugins: [
			haveIBeenPwned({ enabled: config.checkBreachedPasswords }),
			...(config.plugins ?? [])
		],
		hooks: {
			// A locked account is refused before the password is even checked
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== '/sign-in/email') return;
				const email = (ctx.body as { email?: string } | undefined)?.email;
				if (!email) return;
				const minutes = await lockedMinutes(db, email);
				if (minutes > 0) {
					throw new APIError('TOO_MANY_REQUESTS', {
						message: `Too many failed attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
						code: 'ACCOUNT_LOCKED'
					});
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== '/sign-in/email') return;
				const email = (ctx.body as { email?: string } | undefined)?.email;
				if (!email) return;
				const returned = ctx.context.returned;
				if (returned instanceof APIError) {
					// A wrong password counts. An unverified account or a lock does not
					const code = (returned.body as { code?: string } | undefined)?.code;
					if (code === 'INVALID_EMAIL_OR_PASSWORD') await recordFailure(db, email);
				} else {
					await recordSuccess(db, email);
				}
			})
		},
		databaseHooks: {
			session: {
				create: {
					after: async (session) => {
						await noteSignIn(db, mailer, {
							userId: session.userId,
							userAgent: session.userAgent,
							ipAddress: session.ipAddress
						});
					}
				}
			}
		}
	});
}

export type Auth = ReturnType<typeof createAuth>;
