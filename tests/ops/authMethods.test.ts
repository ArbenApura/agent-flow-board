// SIGN IN METHODS (AFB-20261123-1256): THE SEALED GOOGLE SECRET, THE OWNER ONLY VERBS, THE AT LEAST ONE ON RULE AND THE ENVIRONMENT FALLBACK

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import {
	METHODS_ROW_ID,
	openSecret,
	readMethodRow,
	resolveMethods,
	sealSecret
} from '../../src/lib/server/auth/methods';
import { getAuthMethods, updateAuthMethods } from '../../src/lib/server/ops/authMethods';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const AUTH_SECRET = 'a-test-auth-secret-of-at-least-32-characters';
const CLIENT_ID = '482913075521-k3m9d7vq2example.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-a-test-client-secret';

// -- FUNCTIONS -- //

describe('the sealed Google secret', () => {
	it('opens with the same auth secret, and never with another one or after a change', () => {
		const sealed = sealSecret(AUTH_SECRET, CLIENT_SECRET);
		expect(sealed).not.toContain(CLIENT_SECRET);
		expect(sealed.startsWith('v1.')).toBe(true);
		expect(openSecret(AUTH_SECRET, sealed)).toBe(CLIENT_SECRET);
		// A different auth secret, a cut value and a flipped byte all read as nothing
		expect(openSecret('another-auth-secret-of-at-least-32-chars', sealed)).toBeNull();
		expect(openSecret(AUTH_SECRET, sealed.slice(0, -4))).toBeNull();
		const parts = sealed.split('.');
		parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
		expect(openSecret(AUTH_SECRET, parts.join('.'))).toBeNull();
		expect(openSecret(AUTH_SECRET, null)).toBeNull();
		// Two seals of the same text differ (a fresh nonce each time)
		expect(sealSecret(AUTH_SECRET, CLIENT_SECRET)).not.toBe(sealed);
	});

	it('refuses a short auth secret loudly', () => {
		expect(() => sealSecret('short', CLIENT_SECRET)).toThrow(/at least 32/);
	});
});

describe('sign in methods', () => {
	let db: TestDb;
	let w: World;
	const changed = vi.fn();
	const ctx = (who: 'owner' | 'admin' | 'member' = 'owner', env = {}) => ({
		...w.ctx(who),
		services: {
			authSecret: AUTH_SECRET,
			googleEnv: env,
			baseUrl: 'https://board.example.com/',
			onAuthMethodsChanged: changed
		}
	});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 240_000);
	afterAll(() => db?.stop());

	it('with nothing saved the environment decides, and only an owner may read it', async () => {
		await expect(getAuthMethods(ctx('admin'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(getAuthMethods(ctx('member'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const none = await getAuthMethods(ctx('owner'));
		expect(none).toMatchObject({
			password: true,
			google: false,
			googleSecretSet: false,
			fromEnvironment: true,
			redirectUrl: 'https://board.example.com/api/auth/callback/google'
		});
		const fromEnv = await getAuthMethods(
			ctx('owner', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
		);
		expect(fromEnv).toMatchObject({
			google: true,
			googleClientId: CLIENT_ID,
			googleSecretSet: true
		});
		// The environment alone is what the app builds its sign in from while no row exists
		expect(await readMethodRow(db.db)).toBeNull();
		expect(
			await resolveMethods(db.db, AUTH_SECRET, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
		).toEqual({
			password: true,
			google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }
		});
		expect(await resolveMethods(db.db, AUTH_SECRET, {})).toEqual({ password: true, google: null });
	});

	it('only an owner changes it, and a refused change writes nothing', async () => {
		await expect(
			updateAuthMethods(ctx('admin'), { googleEnabled: true, googleClientId: CLIENT_ID })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			updateAuthMethods(ctx('member'), { passwordEnabled: false })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(await readMethodRow(db.db)).toBeNull();
		expect(changed).not.toHaveBeenCalled();
	});

	it('refuses to turn everything off, and Google on without a client ID and a secret', async () => {
		await expect(updateAuthMethods(ctx(), { passwordEnabled: false })).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringContaining('At least one way to sign in must stay on')
		});
		await expect(updateAuthMethods(ctx(), { googleEnabled: true })).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringContaining('client ID and the client secret')
		});
		await expect(
			updateAuthMethods(ctx(), { googleEnabled: true, googleClientId: CLIENT_ID })
		).rejects.toMatchObject({ code: 'INVALID' });
		expect(await readMethodRow(db.db)).toBeNull();
	});

	it('saves Google with its secret sealed, never returns the secret, and tells the app to rebuild', async () => {
		const r = await updateAuthMethods(ctx(), {
			googleEnabled: true,
			googleClientId: CLIENT_ID,
			googleClientSecret: CLIENT_SECRET
		});
		expect(r.changed).toBe(true);
		expect(changed).toHaveBeenCalledTimes(1);
		const row = await readMethodRow(db.db);
		expect(row).toMatchObject({
			id: METHODS_ROW_ID,
			passwordEnabled: true,
			googleEnabled: true,
			googleClientId: CLIENT_ID
		});
		// What is stored is the sealed value, and it opens to the typed secret
		expect(row!.googleClientSecret).not.toContain(CLIENT_SECRET);
		expect(openSecret(AUTH_SECRET, row!.googleClientSecret)).toBe(CLIENT_SECRET);
		const view = await getAuthMethods(ctx());
		expect(view).toMatchObject({ password: true, google: true, googleSecretSet: true });
		expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);
		expect(JSON.stringify(view)).not.toContain(row!.googleClientSecret!);
		expect(await resolveMethods(db.db, AUTH_SECRET, {})).toEqual({
			password: true,
			google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }
		});
	});

	it('a change with no new secret keeps the kept one, and the stored choice wins over the environment', async () => {
		await updateAuthMethods(ctx(), { passwordEnabled: false });
		const row = await readMethodRow(db.db);
		expect(row).toMatchObject({ passwordEnabled: false, googleEnabled: true });
		expect(openSecret(AUTH_SECRET, row!.googleClientSecret)).toBe(CLIENT_SECRET);
		// The environment names another client, but the saved one is used
		expect(
			await resolveMethods(db.db, AUTH_SECRET, {
				clientId: 'other-client-id-xxxx',
				clientSecret: 'other-secret-xx'
			})
		).toEqual({ password: false, google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
		// Turning Google off needs the password back on first
		await expect(updateAuthMethods(ctx(), { googleEnabled: false })).rejects.toMatchObject({
			code: 'INVALID'
		});
		await updateAuthMethods(ctx(), { passwordEnabled: true, googleEnabled: false });
		expect(await resolveMethods(db.db, AUTH_SECRET, {})).toEqual({ password: true, google: null });
	});

	it('a Google secret that cannot be opened never leaves a server with nobody able to sign in', async () => {
		await updateAuthMethods(ctx(), { passwordEnabled: false, googleEnabled: true });
		// The same row read with another auth secret: the sealed secret is unreadable, so Google cannot work and the password stays on
		const other = 'another-auth-secret-of-at-least-32-chars';
		expect(await resolveMethods(db.db, other, {})).toEqual({ password: true, google: null });
		const view = await getAuthMethods({
			...ctx(),
			services: { ...ctx().services, authSecret: other }
		});
		expect(view.googleSecretSet).toBe(false);
	});

	it('a secret that so far lived only in the environment is sealed into the row on the first save', async () => {
		const fresh = await makePostgres();
		try {
			const world = await makeWorld(fresh);
			const env = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
			await updateAuthMethods(
				{ ...world.ctx('owner'), services: { authSecret: AUTH_SECRET, googleEnv: env } },
				{ googleEnabled: true }
			);
			const row = await readMethodRow(fresh.db);
			expect(openSecret(AUTH_SECRET, row!.googleClientSecret)).toBe(CLIENT_SECRET);
		} finally {
			await fresh.stop();
		}
	}, 240_000);
});
