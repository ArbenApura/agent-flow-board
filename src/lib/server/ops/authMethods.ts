// SIGN IN METHODS: WHICH WAYS OF SIGNING IN ARE ON AND THE GOOGLE CLIENT, FOR THE WHOLE INSTANCE (AFB-20261123-1256)
// A sign in happens before any organisation is chosen, so the setting is instance wide. Only an owner may read or change it, and the
// caller's live role is checked inside the verb. The Google client secret is write only: sealed here, never returned or logged.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { METHODS_ROW_ID, methodsView, readMethodRow, sealSecret } from '../auth/methods';
import { authMethodSetting } from '../db/schema';
import { authMethodsInput } from '../db/zod';
import { OpError, requireCap, run } from './context';
import { appendOrgEvent } from './settings';

// -- CONSTANTS -- //

const NOT_OWNER = 'Only an owner can change how people sign in.';
/** The path Better Auth answers Google on, shown so it can be pasted into Google Cloud. */
export const GOOGLE_CALLBACK_PATH = '/api/auth/callback/google';

// -- FUNCTIONS -- //

function authSecretOf(ctx: Ctx): string {
	const secret = ctx.services?.authSecret;
	// Missing configuration fails loudly: no silent fallback to a weaker key
	if (!secret) throw new OpError('INVALID', 'Sign in settings are not available on this server.');
	return secret;
}

/** The methods as the settings card shows them, plus the address to add in Google Cloud. Owners only. */
export async function getAuthMethods(ctx: Ctx) {
	const secret = authSecretOf(ctx);
	return run(ctx, async (tx) => {
		const { role } = await requireCap(tx, ctx, 'manage');
		if (role !== 'owner') throw new OpError('FORBIDDEN', NOT_OWNER);
		const view = await methodsView(tx, secret, ctx.services?.googleEnv ?? {});
		const base = (ctx.services?.baseUrl ?? '').replace(/\/+$/, '');
		return { ...view, redirectUrl: `${base}${GOOGLE_CALLBACK_PATH}` };
	});
}

/** Changes the methods. Only what is sent changes. Refuses to leave nobody able to sign in. Owners only. */
export async function updateAuthMethods(ctx: Ctx, raw: z.input<typeof authMethodsInput>) {
	const input = authMethodsInput.parse(raw);
	const secret = authSecretOf(ctx);
	const env = ctx.services?.googleEnv ?? {};
	const result = await run(ctx, async (tx) => {
		const { role } = await requireCap(tx, ctx, 'manage');
		if (role !== 'owner') throw new OpError('FORBIDDEN', NOT_OWNER);
		// Two owners saving at once take turns, so the at least one method rule is always checked against the latest saved state
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext('afb-auth-methods'))`);
		const before = await methodsView(tx, secret, env);
		const row = await readMethodRow(tx);
		const next = {
			password: input.passwordEnabled ?? before.password,
			google: input.googleEnabled ?? before.google,
			clientId: (input.googleClientId ?? before.googleClientId).trim()
		};
		const secretKept = input.googleClientSecret !== undefined || before.googleSecretSet;
		if (!next.password && !next.google)
			throw new OpError(
				'INVALID',
				'At least one way to sign in must stay on. Turn the other one on first.'
			);
		if (next.google && (!next.clientId || !secretKept))
			throw new OpError(
				'INVALID',
				'Add the Google client ID and the client secret before you turn Google on.'
			);
		// A secret typed now is sealed. With none typed, the kept one stays, and a secret that so far lived only in the environment is sealed into the row
		const sealed =
			input.googleClientSecret !== undefined
				? sealSecret(secret, input.googleClientSecret)
				: (row?.googleClientSecret ??
					(env.clientSecret ? sealSecret(secret, env.clientSecret) : null));
		const values = {
			passwordEnabled: next.password,
			googleEnabled: next.google,
			googleClientId: next.clientId || null,
			googleClientSecret: sealed,
			updatedBy: ctx.actor.userId,
			updatedAt: new Date()
		};
		await tx
			.insert(authMethodSetting)
			.values({ id: METHODS_ROW_ID, ...values })
			.onConflictDoUpdate({ target: authMethodSetting.id, set: values });
		await appendOrgEvent(
			tx,
			ctx,
			'auth.methods',
			{ password: before.password, google: before.google, googleClientId: before.googleClientId },
			{
				password: next.password,
				google: next.google,
				googleClientId: next.clientId,
				// Only the fact that it changed, never the secret
				...(input.googleClientSecret !== undefined ? { googleClientSecret: 'replaced' } : {})
			}
		);
		return { changed: true };
	});
	// Auth is rebuilt only after the write is committed, so a page never sees a method that was not saved
	ctx.services?.onAuthMethodsChanged?.();
	return result;
}
