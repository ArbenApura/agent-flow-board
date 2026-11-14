// OAUTH 2.1 FOR MCP CLIENTS AND THE DEVICE CODE FLOW (SPEC 6.2, 6.7, L6, L7)
// People sign in with Better Auth; this module only decides what an agent tool may hold. Access tokens are the same
// org bound afb_ tokens the REST API and /mcp already verify, so there is one token check everywhere (L8).

// IMPORTED TYPES
import type { DbHandle } from '../db/client';
import type { Capability, Ctx } from '../ops/context';
// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
// IMPORTED MODULES
import {
	apiToken,
	deviceCode,
	member,
	org,
	oauthClient,
	oauthCode,
	oauthGrant,
	oauthRefresh
} from '../db/schema';
import { withTenant } from '../db/tenant';
import { ALL_CAPS, OpError, capsOf, run } from '../ops/context';
import { mintToken } from '../ops/tokens';

// -- CONSTANTS -- //

export const ACCESS_TOKEN_SECONDS = 3600;
export const REFRESH_TOKEN_DAYS = 30;
export const CODE_SECONDS = 60;
export const DEVICE_SECONDS = 600;
export const DEVICE_INTERVAL = 5;
export const DEVICE_TOKEN_DAYS = 30;
/** No vowels and no look alikes, so a typed code is easy to read aloud and cannot spell a word. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_PREFIX = 'afr_';

// -- TYPES -- //

export type OAuthError = {
	error:
		| 'invalid_request'
		| 'invalid_client'
		| 'invalid_grant'
		| 'invalid_scope'
		| 'unsupported_grant_type'
		| 'access_denied'
		| 'authorization_pending'
		| 'slow_down'
		| 'expired_token';
	error_description: string;
};
export type TokenResponse = {
	access_token: string;
	token_type: 'Bearer';
	expires_in: number;
	refresh_token?: string;
	scope: string;
};

// -- FUNCTIONS -- //

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const err = (error: OAuthError['error'], error_description: string): OAuthError => ({
	error,
	error_description
});
export const isOAuthError = (v: unknown): v is OAuthError =>
	!!v && typeof v === 'object' && 'error' in v;

/** A redirect address is https, a loopback address over http, or a private scheme such as cursor:// (never http elsewhere, never script). */
export function validRedirectUri(uri: string): boolean {
	let u: URL;
	try {
		u = new URL(uri);
	} catch {
		return false;
	}
	if (u.hash) return false;
	if (u.protocol === 'https:') return true;
	if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
	return (
		/^[a-z][a-z0-9+.-]*:$/.test(u.protocol) &&
		!['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(u.protocol)
	);
}

/** What the consent page shows about where the tool will be sent back to (L7). */
export const redirectHost = (uri: string) => {
	try {
		const u = new URL(uri);
		return u.host || u.protocol;
	} catch {
		return uri;
	}
};

export function parseScopes(
	value: string | undefined,
	fallback: Capability[] = ['read', 'write']
): Capability[] | OAuthError {
	if (!value || !value.trim()) return fallback;
	const out = value.split(/[\s,]+/).filter(Boolean);
	const bad = out.find((s) => !(ALL_CAPS as string[]).includes(s));
	return bad ? err('invalid_scope', `Unknown scope "${bad}".`) : (out as Capability[]);
}

// -- DYNAMIC CLIENT REGISTRATION (RFC 7591) -- //

/** Registers a client that names itself. It is shown as unverified, with its redirect domain, until someone reviews it (L7). */
export async function registerClient(
	handle: DbHandle,
	input: { client_name?: unknown; redirect_uris?: unknown }
): Promise<
	| {
			client_id: string;
			client_name: string;
			redirect_uris: string[];
			token_endpoint_auth_method: 'none';
	  }
	| OAuthError
> {
	const name = typeof input.client_name === 'string' ? input.client_name.trim().slice(0, 80) : '';
	const uris = Array.isArray(input.redirect_uris)
		? input.redirect_uris.filter((u): u is string => typeof u === 'string')
		: [];
	if (!name) return err('invalid_request', 'client_name is required.');
	if (uris.length === 0 || uris.length > 5 || !uris.every(validRedirectUri))
		return err(
			'invalid_request',
			'redirect_uris must list 1 to 5 https addresses, loopback addresses or app schemes.'
		);
	// A cap on new self registered clients per hour, so the table cannot be flooded
	const [recent] = await handle.db
		.select({ n: sql<number>`count(*)::int` })
		.from(oauthClient)
		.where(gt(oauthClient.createdAt, sql`now() - interval '1 hour'`));
	if (recent.n >= 200)
		return err('invalid_request', 'Too many registrations right now. Try again later.');
	const id = `afbc_${randomBytes(12).toString('base64url')}`;
	await handle.db.insert(oauthClient).values({ id, name, redirectUris: uris, verified: false });
	return {
		client_id: id,
		client_name: name,
		redirect_uris: uris,
		token_endpoint_auth_method: 'none'
	};
}

export async function getClient(handle: DbHandle, id: string) {
	const [c] = await handle.db.select().from(oauthClient).where(eq(oauthClient.id, id));
	return c ?? null;
}

// -- AUTHORIZATION CODE WITH PKCE -- //

/** The caps a person may hand a tool for one org: their own role's, never more. */
export async function grantableCaps(
	handle: DbHandle,
	orgId: string,
	userId: string
): Promise<Capability[]> {
	return withTenant(handle, { orgId, userId }, async (tx) => {
		// An org scheduled for deletion hands out nothing
		const [o] = await tx.select({ deletedAt: org.deletedAt }).from(org).where(eq(org.id, orgId));
		if (!o || o.deletedAt) return [];
		const [m] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, orgId), eq(member.userId, userId)));
		return capsOf(m?.role ?? null);
	});
}

/** Issues a one time code after the person approved. The code is `<orgId>.<secret>`, valid 60 seconds, bound to the PKCE challenge. */
export async function issueCode(
	handle: DbHandle,
	input: {
		orgId: string;
		userId: string;
		clientId: string;
		redirectUri: string;
		challenge: string;
		scopes: Capability[];
		/** The canonical MCP address of the org the approval was for, when the tool started from /mcp/<slug>. */
		resource?: string | null;
	}
): Promise<string | OAuthError> {
	const client = await getClient(handle, input.clientId);
	if (!client || !client.redirectUris.includes(input.redirectUri))
		return err(
			'invalid_request',
			'The redirect address does not match the one the tool registered.'
		);
	if (!/^[A-Za-z0-9_-]{43}$/.test(input.challenge))
		return err('invalid_request', 'A PKCE S256 code challenge is required.');
	const allowed = await grantableCaps(handle, input.orgId, input.userId);
	if (allowed.length === 0)
		return err('access_denied', 'You are not a member of that organisation.');
	const scopes = input.scopes.filter((s) => allowed.includes(s));
	if (scopes.length === 0)
		return err('invalid_scope', 'None of the requested permissions is allowed for your role.');
	const secret = randomBytes(32).toString('base64url');
	const code = `${input.orgId}.${secret}`;
	await withTenant(handle, { orgId: input.orgId, userId: input.userId }, (tx) =>
		tx.insert(oauthCode).values({
			orgId: input.orgId,
			codeHash: sha(code),
			clientId: input.clientId,
			userId: input.userId,
			redirectUri: input.redirectUri,
			codeChallenge: input.challenge,
			scopes,
			resource: input.resource ?? null,
			expiresAt: new Date(Date.now() + CODE_SECONDS * 1000)
		})
	);
	return code;
}

async function issueTokens(
	tx: Parameters<Parameters<typeof withTenant>[2]>[0],
	input: {
		orgId: string;
		userId: string;
		clientName: string;
		grantId: string;
		scopes: Capability[];
	}
): Promise<TokenResponse> {
	const access = await mintToken(tx, {
		orgId: input.orgId,
		userId: input.userId,
		name: input.clientName,
		kind: 'oauth',
		caps: input.scopes,
		ttlSeconds: ACCESS_TOKEN_SECONDS,
		grantId: input.grantId
	});
	const refresh = `${REFRESH_PREFIX}${input.orgId}.${randomBytes(32).toString('base64url')}`;
	await tx.insert(oauthRefresh).values({
		orgId: input.orgId,
		grantId: input.grantId,
		tokenHash: sha(refresh),
		expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000)
	});
	return {
		access_token: access.token,
		token_type: 'Bearer',
		expires_in: ACCESS_TOKEN_SECONDS,
		refresh_token: refresh,
		scope: input.scopes.join(' ')
	};
}

/** Exchanges a code and its PKCE verifier for tokens. A code works once, only for its client and redirect, and only with the right verifier. */
export async function exchangeCode(
	handle: DbHandle,
	input: { code: string; redirectUri: string; verifier: string; clientId: string }
): Promise<TokenResponse | OAuthError> {
	const orgId = input.code.split('.')[0];
	if (!UUID.test(orgId)) return err('invalid_grant', 'The code is not valid.');
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier))
		return err('invalid_request', 'The code verifier must be 43 to 128 characters.');
	const client = await getClient(handle, input.clientId);
	if (!client) return err('invalid_client', 'Unknown client.');
	return withTenant(handle, { orgId }, async (tx) => {
		const [live] = await tx.select({ deletedAt: org.deletedAt }).from(org).where(eq(org.id, orgId));
		if (!live || live.deletedAt) return err('invalid_grant', 'The code is not valid.');
		const [row] = await tx
			.select()
			.from(oauthCode)
			.where(eq(oauthCode.codeHash, sha(input.code)))
			.for('update');
		if (!row) return err('invalid_grant', 'The code is not valid.');
		if (row.usedAt) {
			// A code used twice means it leaked: everything it produced is revoked
			await tx
				.update(apiToken)
				.set({ revokedAt: sql`now()` })
				.where(
					and(
						eq(apiToken.orgId, orgId),
						sql`${apiToken.grantId} in (select id from oauth_grant where client_id = ${row.clientId} and user_id = ${row.userId})`,
						isNull(apiToken.revokedAt)
					)
				);
			return err('invalid_grant', 'The code was already used.');
		}
		if (row.expiresAt <= new Date()) return err('invalid_grant', 'The code has expired.');
		if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri)
			return err('invalid_grant', 'The code does not match this client or redirect address.');
		const challenge = createHash('sha256').update(input.verifier).digest('base64url');
		if (challenge !== row.codeChallenge)
			return err('invalid_grant', 'The code verifier does not match.');
		await tx
			.update(oauthCode)
			.set({ usedAt: sql`now()` })
			.where(eq(oauthCode.id, row.id));
		const [grant] = await tx
			.insert(oauthGrant)
			.values({
				orgId,
				userId: row.userId,
				clientId: row.clientId,
				scopes: row.scopes,
				resource: row.resource
			})
			.returning();
		return issueTokens(tx, {
			orgId,
			userId: row.userId,
			clientName: client.name,
			grantId: grant.id,
			scopes: row.scopes as Capability[]
		});
	});
}

/** Trades a refresh token for new tokens and replaces it. Reusing a replaced token revokes the whole grant (token theft signal). */
export async function refreshTokens(
	handle: DbHandle,
	input: { refreshToken: string; clientId: string }
): Promise<TokenResponse | OAuthError> {
	if (!input.refreshToken.startsWith(REFRESH_PREFIX))
		return err('invalid_grant', 'The refresh token is not valid.');
	const orgId = input.refreshToken.slice(REFRESH_PREFIX.length).split('.')[0];
	if (!UUID.test(orgId)) return err('invalid_grant', 'The refresh token is not valid.');
	const client = await getClient(handle, input.clientId);
	if (!client) return err('invalid_client', 'Unknown client.');
	return withTenant(handle, { orgId }, async (tx) => {
		const [live] = await tx.select({ deletedAt: org.deletedAt }).from(org).where(eq(org.id, orgId));
		if (!live || live.deletedAt) return err('invalid_grant', 'The refresh token is not valid.');
		const [row] = await tx
			.select()
			.from(oauthRefresh)
			.where(eq(oauthRefresh.tokenHash, sha(input.refreshToken)))
			.for('update');
		if (!row) return err('invalid_grant', 'The refresh token is not valid.');
		const [grant] = await tx.select().from(oauthGrant).where(eq(oauthGrant.id, row.grantId));
		if (!grant || grant.revokedAt || grant.clientId !== input.clientId)
			return err('invalid_grant', 'The grant was revoked.');
		if (row.replacedAt) {
			await revokeGrantIn(tx, orgId, grant.id);
			return err(
				'invalid_grant',
				'This refresh token was already used. The connection was ended for safety. Sign in again.'
			);
		}
		if (row.expiresAt <= new Date()) return err('invalid_grant', 'The refresh token has expired.');
		await tx
			.update(oauthRefresh)
			.set({ replacedAt: sql`now()` })
			.where(eq(oauthRefresh.id, row.id));
		// The old access token stops now, so only the newest pair works
		await tx
			.update(apiToken)
			.set({ revokedAt: sql`now()` })
			.where(and(eq(apiToken.grantId, grant.id), isNull(apiToken.revokedAt)));
		// The user's role may have dropped since: the new token carries no more than the role allows today
		const [m] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, orgId), eq(member.userId, grant.userId)));
		if (!m) return err('invalid_grant', 'The person is no longer a member of the organisation.');
		const scopes = (grant.scopes as Capability[]).filter((s) => capsOf(m.role).includes(s));
		return issueTokens(tx, {
			orgId,
			userId: grant.userId,
			clientName: client.name,
			grantId: grant.id,
			scopes
		});
	});
}

async function revokeGrantIn(
	tx: Parameters<Parameters<typeof withTenant>[2]>[0],
	orgId: string,
	grantId: string
) {
	await tx
		.update(oauthGrant)
		.set({ revokedAt: sql`now()` })
		.where(eq(oauthGrant.id, grantId));
	await tx
		.update(apiToken)
		.set({ revokedAt: sql`now()` })
		.where(
			and(eq(apiToken.orgId, orgId), eq(apiToken.grantId, grantId), isNull(apiToken.revokedAt))
		);
	await tx
		.update(oauthRefresh)
		.set({ replacedAt: sql`coalesce(${oauthRefresh.replacedAt}, now())` })
		.where(eq(oauthRefresh.grantId, grantId));
}

// -- DEVICE CODE (RFC 8628, L6) -- //

const attempts = new Map<string, { n: number; since: number }>();

/** Starts a device sign in. The person types the code on the approval page; it is never pre filled into any link. */
export async function startDevice(
	handle: DbHandle,
	baseUrl: string,
	input: {
		client_name?: unknown;
		origin?: string;
		code_challenge?: unknown;
		code_challenge_method?: unknown;
	}
) {
	const client =
		typeof input.client_name === 'string' && input.client_name.trim()
			? input.client_name.trim().slice(0, 80)
			: 'A command line tool';
	// A tool that keeps a verifier sends its SHA-256 (base64url, 43 characters). Anything else is refused, never stored as if it were one
	let challengeHash: string | null = null;
	if (input.code_challenge !== undefined) {
		if (
			input.code_challenge_method !== 'S256' ||
			typeof input.code_challenge !== 'string' ||
			!/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge)
		)
			return err(
				'invalid_request',
				'code_challenge must be the SHA-256 of a verifier, base64url, with code_challenge_method S256.'
			);
		challengeHash = input.code_challenge;
	}
	const deviceCodeValue = randomBytes(32).toString('base64url');
	for (let i = 0; i < 5; i++) {
		const userCode = Array.from(
			randomBytes(8),
			(b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]
		).join('');
		try {
			await handle.db.insert(deviceCode).values({
				deviceCodeHash: sha(deviceCodeValue),
				userCode,
				client,
				origin: (input.origin ?? '').slice(0, 80) || null,
				challengeHash,
				expiresAt: new Date(Date.now() + DEVICE_SECONDS * 1000)
			});
			return {
				device_code: deviceCodeValue,
				user_code: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
				verification_uri: `${baseUrl}/device`,
				expires_in: DEVICE_SECONDS,
				interval: DEVICE_INTERVAL
			};
		} catch {
			// A user code collision is rare; try another
		}
	}
	throw new Error('Could not create a device code');
}

/** What the approval page shows for a typed code, so the person can check it is the tool they started. */
export async function describeDevice(handle: DbHandle, typed: string) {
	const code = typed.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
	const [row] = await handle.db.select().from(deviceCode).where(eq(deviceCode.userCode, code));
	if (!row || row.status !== 'pending' || row.expiresAt <= new Date()) return null;
	return {
		userCode: code,
		client: row.client,
		origin: row.origin,
		expiresInSeconds: Math.max(0, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000))
	};
}

/** A person approves a typed code for one org and a set of permissions no larger than their role. Wrong codes are limited per person. */
export async function approveDevice(
	handle: DbHandle,
	input: { userId: string; typed: string; orgId: string; scopes: Capability[]; deny?: boolean }
): Promise<{ ok: true; client: string } | OAuthError> {
	const key = input.userId;
	const now = Date.now();
	const a = attempts.get(key);
	if (a && now - a.since < 600_000 && a.n >= 10)
		return err('access_denied', 'Too many wrong codes. Wait ten minutes and try again.');
	const info = await describeDevice(handle, input.typed);
	if (!info) {
		attempts.set(
			key,
			a && now - a.since < 600_000 ? { n: a.n + 1, since: a.since } : { n: 1, since: now }
		);
		return err(
			'invalid_grant',
			'That code is not valid or has expired. Check the code in your tool.'
		);
	}
	if (input.deny) {
		await handle.db
			.update(deviceCode)
			.set({ status: 'denied' })
			.where(eq(deviceCode.userCode, info.userCode));
		return { ok: true, client: info.client };
	}
	const allowed = await grantableCaps(handle, input.orgId, input.userId);
	const scopes = input.scopes.filter((s) => allowed.includes(s));
	if (scopes.length === 0)
		return err(
			'invalid_scope',
			'None of the chosen permissions is allowed for your role in that organisation.'
		);
	await handle.db
		.update(deviceCode)
		.set({ status: 'approved', approvedBy: input.userId, approvedOrgId: input.orgId, scopes })
		.where(and(eq(deviceCode.userCode, info.userCode), eq(deviceCode.status, 'pending')));
	return { ok: true, client: info.client };
}

/** The tool polls this. It answers pending, slow_down, denied, expired, or hands over a token exactly once. */
export async function pollDevice(
	handle: DbHandle,
	deviceCodeValue: string
): Promise<TokenResponse | OAuthError> {
	const [row] = await handle.db
		.select()
		.from(deviceCode)
		.where(eq(deviceCode.deviceCodeHash, sha(deviceCodeValue)));
	if (!row) return err('invalid_grant', 'Unknown device code.');
	if (row.expiresAt <= new Date()) return err('expired_token', 'The code expired. Start again.');
	if (row.status === 'denied') return err('access_denied', 'The person refused the sign in.');
	if (row.status === 'issued') return err('invalid_grant', 'This device code was already used.');
	if (row.status === 'pending') {
		if (row.lastPolledAt && Date.now() - row.lastPolledAt.getTime() < DEVICE_INTERVAL * 1000)
			return err('slow_down', 'Poll less often.');
		await handle.db
			.update(deviceCode)
			.set({ lastPolledAt: new Date() })
			.where(eq(deviceCode.id, row.id));
		return err('authorization_pending', 'Waiting for the person to approve.');
	}
	if (!row.approvedBy || !row.approvedOrgId)
		return err('invalid_grant', 'The approval is incomplete.');
	// Marking it issued first, with a condition, makes sure two polls cannot both receive a token
	const claimed = await handle.db
		.update(deviceCode)
		.set({ status: 'issued' })
		.where(and(eq(deviceCode.id, row.id), eq(deviceCode.status, 'approved')))
		.returning({ id: deviceCode.id });
	if (claimed.length === 0) return err('invalid_grant', 'This device code was already used.');
	const minted = await withTenant(
		handle,
		{ orgId: row.approvedOrgId, userId: row.approvedBy },
		(tx) =>
			mintToken(tx, {
				orgId: row.approvedOrgId!,
				userId: row.approvedBy!,
				name: row.client,
				kind: 'device',
				caps: row.scopes as Capability[],
				ttlSeconds: DEVICE_TOKEN_DAYS * 86_400
			})
	);
	return {
		access_token: minted.token,
		token_type: 'Bearer',
		expires_in: DEVICE_TOKEN_DAYS * 86_400,
		scope: row.scopes.join(' ')
	};
}

// -- CONNECTED APPS (6.8) -- //

/** Everything signed in for the caller in this org: tools by OAuth, by device code and personal tokens, with the client's verified badge. */
export async function listConnections(ctx: Ctx) {
	return run(ctx, async (tx) => {
		const rows = await tx
			.select({
				id: apiToken.id,
				name: apiToken.name,
				kind: apiToken.kind,
				grantId: apiToken.grantId,
				prefix: apiToken.prefix,
				permissions: apiToken.permissions,
				expiresAt: apiToken.expiresAt,
				lastUsedAt: apiToken.lastUsedAt,
				revokedAt: apiToken.revokedAt,
				createdAt: apiToken.createdAt
			})
			.from(apiToken)
			.where(
				and(
					eq(apiToken.orgId, ctx.orgId),
					eq(apiToken.userId, ctx.actor.userId),
					isNull(apiToken.revokedAt),
					gt(apiToken.expiresAt, sql`now()`)
				)
			)
			.orderBy(desc(apiToken.createdAt));
		const grantIds = rows.map((r) => r.grantId).filter((g): g is string => !!g);
		const grants = grantIds.length
			? await tx
					.select({
						id: oauthGrant.id,
						clientId: oauthGrant.clientId,
						resource: oauthGrant.resource
					})
					.from(oauthGrant)
					.where(inArray(oauthGrant.id, grantIds))
			: [];
		const clients = grants.length
			? await handleClients(
					tx,
					grants.map((g) => g.clientId)
				)
			: [];
		return rows.map((r) => {
			const g = grants.find((x) => x.id === r.grantId);
			const c = clients.find((x) => x.id === g?.clientId);
			return {
				...r,
				verified: c?.verified ?? null,
				redirectHosts: c?.redirectUris.map(redirectHost) ?? [],
				/** The address the tool was approved for. Null for an older sign in (it used the plain /mcp) and for tokens and device sign ins. */
				resource: g?.resource ?? null
			};
		});
	});
}

async function handleClients(tx: Parameters<Parameters<typeof withTenant>[2]>[0], ids: string[]) {
	return tx.select().from(oauthClient).where(inArray(oauthClient.id, ids));
}

/** Ends one connection at once: the token, and for OAuth the whole grant with its refresh tokens. */
export async function revokeConnection(ctx: Ctx, tokenId: string) {
	return run(ctx, async (tx) => {
		const [t] = await tx
			.select()
			.from(apiToken)
			.where(
				and(
					eq(apiToken.id, tokenId),
					eq(apiToken.orgId, ctx.orgId),
					eq(apiToken.userId, ctx.actor.userId)
				)
			);
		if (!t) throw new OpError('NOT_FOUND', 'No such connection.');
		if (t.grantId) await revokeGrantIn(tx, ctx.orgId, t.grantId);
		await tx
			.update(apiToken)
			.set({ revokedAt: sql`coalesce(${apiToken.revokedAt}, now())` })
			.where(eq(apiToken.id, t.id));
		return { id: t.id, revoked: true };
	});
}
