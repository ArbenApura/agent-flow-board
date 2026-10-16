// 6.6 TO 6.8: OAUTH 2.1 WITH PKCE, DYNAMIC REGISTRATION, REFRESH ROTATION, THE DEVICE CODE FLOW AND CONNECTED APPS

// -- DEP-MODULES -- //
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	approveDevice,
	exchangeCode,
	isOAuthError,
	issueCode,
	listConnections,
	pollDevice,
	redirectHost,
	refreshTokens,
	registerClient,
	revokeConnection,
	startDevice,
	validRedirectUri,
	type TokenResponse
} from '../../src/lib/server/oauth/oauth';
import { authenticateToken } from '../../src/lib/server/ops/tokens';
import { deviceCode, oauthCode } from '../../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { makePglite, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const REDIRECT = 'http://127.0.0.1:33418/callback';

// -- FUNCTIONS -- //

const pkce = () => {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

describe('redirect rules', () => {
	it('accepts https, loopback http and app schemes, and refuses the rest', () => {
		for (const ok of [
			'https://claude.ai/api/mcp/auth_callback',
			'http://localhost:3000/cb',
			'http://127.0.0.1:1/x',
			'cursor://anysphere.cursor-retrieval/oauth/callback',
			'vscode://ms-vscode.mcp/cb'
		])
			expect(validRedirectUri(ok), ok).toBe(true);
		for (const bad of [
			'http://evil.example/cb',
			'javascript:alert(1)',
			'data:text/html,x',
			'file:///etc/passwd',
			'https://a.example/cb#frag',
			'not a url',
			''
		])
			expect(validRedirectUri(bad), bad).toBe(false);
		expect(redirectHost('https://claude.ai/api/x')).toBe('claude.ai');
	});
});

describe('OAuth and device flows', () => {
	let db: TestDb;
	let w: World;
	beforeAll(async () => {
		db = await makePglite();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	const client = async (name = 'Claude Desktop') => {
		const r = await registerClient(db, { client_name: name, redirect_uris: [REDIRECT] });
		if (isOAuthError(r)) throw new Error(r.error_description);
		return r.client_id;
	};
	const ok = (r: TokenResponse | { error: string }) => {
		expect(isOAuthError(r), JSON.stringify(r)).toBe(false);
		return r as TokenResponse;
	};

	it('registers a self named client as unverified and refuses bad redirect addresses', async () => {
		const id = await client();
		const bad = await registerClient(db, {
			client_name: 'Evil',
			redirect_uris: ['http://evil.example/cb']
		});
		expect(isOAuthError(bad)).toBe(true);
		expect(
			isOAuthError(await registerClient(db, { client_name: '', redirect_uris: [REDIRECT] }))
		).toBe(true);
		expect(
			isOAuthError(
				await registerClient(db, { client_name: 'Many', redirect_uris: Array(6).fill(REDIRECT) })
			)
		).toBe(true);
		const rows = await db.admin.query<{ verified: boolean }>(
			`select verified from oauth_client where id = '${id}'`
		);
		expect(rows[0].verified).toBe(false);
	});

	it('the code flow with PKCE gives a working token, once, with the permissions the role allows', async () => {
		const id = await client();
		const { verifier, challenge } = pkce();
		const code = await issueCode(db, {
			orgId: w.orgId,
			userId: w.people.viewer,
			clientId: id,
			redirectUri: REDIRECT,
			challenge,
			scopes: ['read', 'write', 'complete']
		});
		expect(isOAuthError(code)).toBe(false);
		const tokens = ok(
			await exchangeCode(db, {
				code: code as string,
				redirectUri: REDIRECT,
				verifier,
				clientId: id
			})
		);
		// A viewer asked for write and complete, and got only what a viewer may hold
		expect(tokens.scope).toBe('read');
		expect(tokens.expires_in).toBe(3600);
		const auth = await authenticateToken(db, tokens.access_token);
		expect(auth).toMatchObject({ orgId: w.orgId, userId: w.people.viewer, caps: ['read'] });
		// The same code cannot be used again, and using it again ends what it produced
		const again = await exchangeCode(db, {
			code: code as string,
			redirectUri: REDIRECT,
			verifier,
			clientId: id
		});
		expect(again).toMatchObject({ error: 'invalid_grant' });
		expect(await authenticateToken(db, tokens.access_token)).toBeNull();
	});

	it('refuses a wrong verifier, a different redirect, a different client, an expired code and a forged code', async () => {
		const id = await client();
		const other = await client('Another tool');
		const mk = async () => {
			const p = pkce();
			const code = (await issueCode(db, {
				orgId: w.orgId,
				userId: w.people.member,
				clientId: id,
				redirectUri: REDIRECT,
				challenge: p.challenge,
				scopes: ['read']
			})) as string;
			return { ...p, code };
		};
		const a = await mk();
		expect(
			await exchangeCode(db, {
				code: a.code,
				redirectUri: REDIRECT,
				verifier: pkce().verifier,
				clientId: id
			})
		).toMatchObject({ error: 'invalid_grant' });
		const b = await mk();
		expect(
			await exchangeCode(db, {
				code: b.code,
				redirectUri: 'http://127.0.0.1:1/other',
				verifier: b.verifier,
				clientId: id
			})
		).toMatchObject({ error: 'invalid_grant' });
		const c = await mk();
		expect(
			await exchangeCode(db, {
				code: c.code,
				redirectUri: REDIRECT,
				verifier: c.verifier,
				clientId: other
			})
		).toMatchObject({ error: 'invalid_grant' });
		const d = await mk();
		await db.db
			.update(oauthCode)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(oauthCode.clientId, id));
		expect(
			await exchangeCode(db, {
				code: d.code,
				redirectUri: REDIRECT,
				verifier: d.verifier,
				clientId: id
			})
		).toMatchObject({ error: 'invalid_grant' });
		expect(
			await exchangeCode(db, {
				code: `${w.orgId}.forged`,
				redirectUri: REDIRECT,
				verifier: pkce().verifier,
				clientId: id
			})
		).toMatchObject({ error: 'invalid_grant' });
		expect(
			await exchangeCode(db, {
				code: 'garbage',
				redirectUri: REDIRECT,
				verifier: pkce().verifier,
				clientId: id
			})
		).toMatchObject({ error: 'invalid_grant' });
		expect(
			await exchangeCode(db, {
				code: a.code,
				redirectUri: REDIRECT,
				verifier: 'short',
				clientId: id
			})
		).toMatchObject({ error: 'invalid_request' });
	});

	it('refuses a code for a redirect the client did not register, a missing challenge and a non member', async () => {
		const id = await client();
		const { challenge } = pkce();
		expect(
			await issueCode(db, {
				orgId: w.orgId,
				userId: w.people.member,
				clientId: id,
				redirectUri: 'http://127.0.0.1:1/x',
				challenge,
				scopes: ['read']
			})
		).toMatchObject({ error: 'invalid_request' });
		expect(
			await issueCode(db, {
				orgId: w.orgId,
				userId: w.people.member,
				clientId: id,
				redirectUri: REDIRECT,
				challenge: 'plain',
				scopes: ['read']
			})
		).toMatchObject({ error: 'invalid_request' });
		expect(
			await issueCode(db, {
				orgId: w.orgId,
				userId: w.other.userId,
				clientId: id,
				redirectUri: REDIRECT,
				challenge,
				scopes: ['read']
			})
		).toMatchObject({ error: 'access_denied' });
	});

	it('refresh rotates the pair, ends the old access token, and reusing an old refresh token ends the whole connection', async () => {
		const id = await client();
		const p = pkce();
		const code = (await issueCode(db, {
			orgId: w.orgId,
			userId: w.people.member,
			clientId: id,
			redirectUri: REDIRECT,
			challenge: p.challenge,
			scopes: ['read', 'write']
		})) as string;
		const first = ok(
			await exchangeCode(db, { code, redirectUri: REDIRECT, verifier: p.verifier, clientId: id })
		);
		const second = ok(
			await refreshTokens(db, { refreshToken: first.refresh_token!, clientId: id })
		);
		expect(second.access_token).not.toBe(first.access_token);
		expect(await authenticateToken(db, first.access_token)).toBeNull();
		expect(await authenticateToken(db, second.access_token)).not.toBeNull();
		// Replaying the first refresh token is a theft signal: everything stops
		expect(
			await refreshTokens(db, { refreshToken: first.refresh_token!, clientId: id })
		).toMatchObject({ error: 'invalid_grant' });
		expect(await authenticateToken(db, second.access_token)).toBeNull();
		expect(
			await refreshTokens(db, { refreshToken: second.refresh_token!, clientId: id })
		).toMatchObject({ error: 'invalid_grant' });
	});

	it("a refreshed token carries no more than the person's role allows today", async () => {
		const id = await client();
		const p = pkce();
		const code = (await issueCode(db, {
			orgId: w.orgId,
			userId: w.people.member,
			clientId: id,
			redirectUri: REDIRECT,
			challenge: p.challenge,
			scopes: ['read', 'write', 'complete']
		})) as string;
		const first = ok(
			await exchangeCode(db, { code, redirectUri: REDIRECT, verifier: p.verifier, clientId: id })
		);
		expect(first.scope).toBe('read write complete');
		await db.admin.exec(
			`update member set role = 'viewer' where org_id = '${w.orgId}' and user_id = '${w.people.member}'`
		);
		const next = ok(await refreshTokens(db, { refreshToken: first.refresh_token!, clientId: id }));
		expect(next.scope).toBe('read');
		await db.admin.exec(
			`update member set role = 'member' where org_id = '${w.orgId}' and user_id = '${w.people.member}'`
		);
	});

	it('the device flow: pending, slow down, approve, one token, never a second', async () => {
		const start = await startDevice(db, BASE, { client_name: 'Gemini CLI', origin: '203.0.113.9' });
		expect(start.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
		expect(start.verification_uri).toBe(`${BASE}/device`);
		expect(start.verification_uri).not.toContain(start.user_code);
		expect(await pollDevice(db, start.device_code)).toMatchObject({
			error: 'authorization_pending'
		});
		expect(await pollDevice(db, start.device_code)).toMatchObject({ error: 'slow_down' });
		// Typed in lower case and without the dash still works
		const typed = start.user_code.replace('-', '').toLowerCase();
		expect(
			await approveDevice(db, {
				userId: w.people.member,
				typed,
				orgId: w.orgId,
				scopes: ['read', 'write', 'publish']
			})
		).toMatchObject({ ok: true, client: 'Gemini CLI' });
		await db.db.update(deviceCode).set({ lastPolledAt: new Date(Date.now() - 60_000) });
		const token = ok(await pollDevice(db, start.device_code));
		// A member asked for publish and was given only what a member may hold
		expect(token.scope).toBe('read write');
		expect(await authenticateToken(db, token.access_token)).toMatchObject({
			userId: w.people.member,
			orgId: w.orgId
		});
		expect(await pollDevice(db, start.device_code)).toMatchObject({ error: 'invalid_grant' });
	});

	it('refuses a denied code, an expired code and an unknown code, and limits wrong guesses', async () => {
		const denied = await startDevice(db, BASE, { client_name: 'Denied tool' });
		expect(
			await approveDevice(db, {
				userId: w.people.member,
				typed: denied.user_code,
				orgId: w.orgId,
				scopes: [],
				deny: true
			})
		).toMatchObject({ ok: true });
		expect(await pollDevice(db, denied.device_code)).toMatchObject({ error: 'access_denied' });
		const old = await startDevice(db, BASE, { client_name: 'Old tool' });
		await db.db
			.update(deviceCode)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(deviceCode.userCode, old.user_code.replace('-', '')));
		expect(await pollDevice(db, old.device_code)).toMatchObject({ error: 'expired_token' });
		expect(
			await approveDevice(db, {
				userId: w.people.member,
				typed: old.user_code,
				orgId: w.orgId,
				scopes: ['read']
			})
		).toMatchObject({ error: 'invalid_grant' });
		expect(await pollDevice(db, 'unknown-device-code')).toMatchObject({ error: 'invalid_grant' });
		let last: unknown;
		for (let i = 0; i < 12; i++)
			last = await approveDevice(db, {
				userId: w.people.guest,
				typed: 'AAAA-AAAA',
				orgId: w.orgId,
				scopes: ['read']
			});
		expect(last).toMatchObject({ error: 'access_denied' });
	});

	it('lists connected apps with the unverified badge and ends one connection for good', async () => {
		const id = await client('Cursor');
		const p = pkce();
		const code = (await issueCode(db, {
			orgId: w.orgId,
			userId: w.people.admin,
			clientId: id,
			redirectUri: REDIRECT,
			challenge: p.challenge,
			scopes: ['read']
		})) as string;
		const tokens = ok(
			await exchangeCode(db, { code, redirectUri: REDIRECT, verifier: p.verifier, clientId: id })
		);
		const connections = await listConnections(w.ctx('admin'));
		const mine = connections.find((c) => c.name === 'Cursor')!;
		expect(mine).toMatchObject({
			kind: 'oauth',
			verified: false,
			redirectHosts: ['127.0.0.1:33418']
		});
		await revokeConnection(w.ctx('admin'), mine.id);
		expect(await authenticateToken(db, tokens.access_token)).toBeNull();
		expect(
			await refreshTokens(db, { refreshToken: tokens.refresh_token!, clientId: id })
		).toMatchObject({ error: 'invalid_grant' });
		expect((await listConnections(w.ctx('admin'))).some((c) => c.id === mine.id)).toBe(false);
		const stored = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from api_token where id = '${mine.id}' and revoked_at is not null`
		);
		expect(stored[0].n).toBe(1);
	});
});
