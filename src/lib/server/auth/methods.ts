// WHICH WAYS OF SIGNING IN ARE ON: THE STORED CHOICE, THE ENVIRONMENT AS ITS FALLBACK, AND THE SEALED GOOGLE SECRET
// One row (id `default`) for the whole instance, because a sign in happens before any organisation is chosen. With no row the
// environment decides, so a server set up before this setting existed behaves exactly as it did.

// IMPORTED TYPES
import type { Db } from '../db/client';
// IMPORTED DEP-MODULES
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import { authMethodSetting } from '../db/schema';

// -- TYPES -- //

/** Anything that can select: the database handle, or an open transaction of an operation. */
type Reader = Pick<Db, 'select'>;

/** The Google client as the environment gives it, used while nothing is stored. */
export type EnvGoogle = { clientId?: string; clientSecret?: string };

/** What the sign in and sign up pages and Better Auth are built from. */
export type EffectiveMethods = {
	password: boolean;
	google: { clientId: string; clientSecret: string } | null;
};

/** What the settings card may see: never the secret itself, only whether one is kept. */
export type MethodsView = {
	password: boolean;
	google: boolean;
	googleClientId: string;
	googleSecretSet: boolean;
	/** True while nothing is stored and the environment is deciding. */
	fromEnvironment: boolean;
};

// -- CONSTANTS -- //

export const METHODS_ROW_ID = 'default';
const KEY_INFO = 'afb-auth-method-v1';
const PREFIX = 'v1';

// -- FUNCTIONS -- //

function sealKey(secret: string): Buffer {
	if (secret.length < 32) throw new Error('The auth secret must be at least 32 characters.');
	return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_INFO, 32));
}

/** Seals a client secret as `v1.<iv>.<tag>.<ciphertext>` (base64url). The plain text never leaves this function. */
export function sealSecret(authSecret: string, plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', sealKey(authSecret), iv);
	cipher.setAAD(Buffer.from(KEY_INFO));
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return [
		PREFIX,
		iv.toString('base64url'),
		cipher.getAuthTag().toString('base64url'),
		ct.toString('base64url')
	].join('.');
}

/** Opens a sealed secret, or returns null when it cannot be opened (a changed auth secret, a damaged value). */
export function openSecret(authSecret: string, sealed: string | null | undefined): string | null {
	if (!sealed) return null;
	const [v, iv, tag, ct] = sealed.split('.');
	if (v !== PREFIX || !iv || !tag || !ct) return null;
	try {
		const d = createDecipheriv('aes-256-gcm', sealKey(authSecret), Buffer.from(iv, 'base64url'));
		d.setAAD(Buffer.from(KEY_INFO));
		d.setAuthTag(Buffer.from(tag, 'base64url'));
		return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
	} catch {
		return null;
	}
}

/** The stored row, or null when nothing was ever saved. */
export async function readMethodRow(db: Reader) {
	const [row] = await db
		.select()
		.from(authMethodSetting)
		.where(eq(authMethodSetting.id, METHODS_ROW_ID));
	return row ?? null;
}

/**
 * What is really on right now. A stored row wins over the environment. Google counts as on only when it is switched on and a
 * client id and a secret that can be opened are both there, so a half set up Google never shows a button that cannot work.
 */
export async function resolveMethods(
	db: Reader,
	authSecret: string,
	env: EnvGoogle
): Promise<EffectiveMethods> {
	const row = await readMethodRow(db);
	const envGoogle =
		env.clientId && env.clientSecret
			? { clientId: env.clientId, clientSecret: env.clientSecret }
			: null;
	if (!row) return { password: true, google: envGoogle };
	// A stored client wins over the environment's, and the environment fills in only what was never saved
	const clientId = row.googleClientId || env.clientId || '';
	const clientSecret =
		openSecret(authSecret, row.googleClientSecret) ??
		(row.googleClientSecret ? '' : env.clientSecret || '');
	const google = row.googleEnabled && clientId && clientSecret ? { clientId, clientSecret } : null;
	// Never leave nobody able to sign in: a stored choice that turned both off (or whose Google cannot work) keeps the password on
	return { password: row.passwordEnabled || !google, google };
}

/** What the settings card shows. */
export async function methodsView(
	db: Reader,
	authSecret: string,
	env: EnvGoogle
): Promise<MethodsView> {
	const row = await readMethodRow(db);
	if (!row) {
		return {
			password: true,
			google: Boolean(env.clientId && env.clientSecret),
			googleClientId: env.clientId ?? '',
			googleSecretSet: Boolean(env.clientSecret),
			fromEnvironment: true
		};
	}
	return {
		password: row.passwordEnabled,
		google: row.googleEnabled,
		googleClientId: row.googleClientId ?? env.clientId ?? '',
		googleSecretSet: Boolean(
			openSecret(authSecret, row.googleClientSecret) ??
			(row.googleClientSecret ? null : env.clientSecret)
		),
		fromEnvironment: false
	};
}
