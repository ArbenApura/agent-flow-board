// PERSONAL ACCESS TOKENS (SPEC 6.2): SHOWN ONCE, STORED AS A HASH, PREFIXED FOR SECRET SCANNING, 90 DAYS AT MOST, SCOPED
// A token is `afb_<orgId>.<secret>`. The org id lets the lookup run inside that org's row level security.

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { Capability, Ctx } from './context';
// -- DEP-MODULES -- //
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { apiToken, member, org } from '../db/schema';
import { withTenant } from '../db/tenant';
import { ALL_CAPS, OpError, capsOf, run } from './context';
import { settingsOf } from './settings';

// -- CONSTANTS -- //

export const MAX_TOKEN_DAYS = 90;
export const TOKEN_PREFIX = 'afb_';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const tokenInput = z.object({
	name: z.string().min(2).max(80),
	days: z.number().int().min(1).max(MAX_TOKEN_DAYS).optional(),
	projectIds: z.array(z.string().uuid()).max(50).default([]),
	permissions: z.array(z.enum(ALL_CAPS as [Capability, ...Capability[]])).min(1)
});

// -- FUNCTIONS -- //

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Creates a token for the calling person. The plain token is returned once and never stored. */
export async function createToken(ctx: Ctx, raw: z.input<typeof tokenInput>) {
	const input = tokenInput.parse(raw);
	return run(ctx, async (tx) => {
		const [m] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, ctx.orgId), eq(member.userId, ctx.actor.userId)));
		if (!m) throw new OpError('FORBIDDEN', 'You are not a member of this organisation.');
		// A token may list only what its owner can do today, so a new token never starts above its user
		const allowed = capsOf(m.role);
		const extra = input.permissions.filter((p) => !allowed.includes(p));
		if (extra.length)
			throw new OpError('FORBIDDEN', `Your role does not allow tokens with: ${extra.join(', ')}.`);
		// The org may allow shorter lives than the platform maximum (Organisation settings)
		const [o] = await tx.select({ settings: org.settings }).from(org).where(eq(org.id, ctx.orgId));
		const max = settingsOf(o?.settings).tokenMaxDays;
		const days = input.days ?? Math.min(30, max);
		if (days > max)
			throw new OpError(
				'INVALID',
				`This organisation allows tokens to live ${max} ${max === 1 ? 'day' : 'days'} at most.`
			);
		const secret = randomBytes(32).toString('base64url');
		const token = `${TOKEN_PREFIX}${ctx.orgId}.${secret}`;
		const [row] = await tx
			.insert(apiToken)
			.values({
				orgId: ctx.orgId,
				userId: ctx.actor.userId,
				name: input.name,
				prefix: token.slice(0, TOKEN_PREFIX.length + 8),
				hash: hashOf(token),
				projectIds: input.projectIds,
				permissions: input.permissions,
				expiresAt: new Date(Date.now() + days * 86_400_000)
			})
			.returning();
		return {
			id: row.id,
			token,
			prefix: row.prefix,
			expiresAt: row.expiresAt,
			permissions: input.permissions
		};
	});
}

/** The caller's own tokens, never the secret. */
export async function listTokens(ctx: Ctx) {
	return run(ctx, (tx) =>
		tx
			.select({
				id: apiToken.id,
				name: apiToken.name,
				kind: apiToken.kind,
				prefix: apiToken.prefix,
				permissions: apiToken.permissions,
				projectIds: apiToken.projectIds,
				expiresAt: apiToken.expiresAt,
				lastUsedAt: apiToken.lastUsedAt,
				revokedAt: apiToken.revokedAt
			})
			.from(apiToken)
			.where(and(eq(apiToken.orgId, ctx.orgId), eq(apiToken.userId, ctx.actor.userId)))
			.orderBy(desc(apiToken.createdAt))
	);
}

/** Revokes one of the caller's tokens at once. */
export async function revokeToken(ctx: Ctx, tokenId: string) {
	return run(ctx, async (tx) => {
		const done = await tx
			.update(apiToken)
			.set({ revokedAt: sql`now()` })
			.where(
				and(
					eq(apiToken.id, tokenId),
					eq(apiToken.orgId, ctx.orgId),
					eq(apiToken.userId, ctx.actor.userId),
					isNull(apiToken.revokedAt)
				)
			)
			.returning({ id: apiToken.id });
		if (done.length === 0) throw new OpError('NOT_FOUND', 'No such token.');
		return { id: tokenId, revoked: true };
	});
}

export type TokenAuth = {
	orgId: string;
	userId: string;
	tokenId: string;
	caps: Capability[];
	projectIds: string[];
	name: string;
};

/**
 * Checks a presented token. Returns null for anything wrong (unknown, revoked, expired, malformed) without saying why.
 * The stored permissions are returned as an upper limit only; every call still reads the live role (L8).
 */
export async function authenticateToken(
	handle: DbHandle,
	presented: string
): Promise<TokenAuth | null> {
	if (!presented.startsWith(TOKEN_PREFIX)) return null;
	const orgId = presented.slice(TOKEN_PREFIX.length).split('.')[0];
	if (!UUID.test(orgId) || presented.length < 70) return null;
	const found = await withTenant(handle, { orgId }, async (tx) => {
		const [t] = await tx
			.select()
			.from(apiToken)
			.where(eq(apiToken.hash, hashOf(presented)));
		if (!t || t.revokedAt || t.expiresAt <= new Date()) return null;
		// Written at most once a minute, so reading with a token does not turn into a write on every call
		if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 60_000)
			await tx
				.update(apiToken)
				.set({ lastUsedAt: sql`now()` })
				.where(eq(apiToken.id, t.id));
		return t;
	});
	if (!found) return null;
	return {
		orgId,
		userId: found.userId,
		tokenId: found.id,
		caps: found.permissions as Capability[],
		projectIds: found.projectIds,
		name: found.name
	};
}

/**
 * Mints an access token inside an open transaction, for the OAuth and device flows. The plain token is returned once.
 * Unlike a personal access token it carries a kind and, for OAuth, the grant it belongs to.
 */
export async function mintToken(
	tx: Parameters<Parameters<typeof withTenant>[2]>[0],
	input: {
		orgId: string;
		userId: string;
		name: string;
		kind: 'oauth' | 'device';
		caps: Capability[];
		ttlSeconds: number;
		grantId?: string;
	}
) {
	const secret = randomBytes(32).toString('base64url');
	const token = `${TOKEN_PREFIX}${input.orgId}.${secret}`;
	const [row] = await tx
		.insert(apiToken)
		.values({
			orgId: input.orgId,
			userId: input.userId,
			name: input.name.slice(0, 80),
			prefix: token.slice(0, TOKEN_PREFIX.length + 8),
			hash: hashOf(token),
			kind: input.kind,
			grantId: input.grantId ?? null,
			permissions: input.caps,
			expiresAt: new Date(Date.now() + input.ttlSeconds * 1000)
		})
		.returning();
	return { token, id: row.id, expiresAt: row.expiresAt };
}
