// INVITES BOUND TO ONE EMAIL ADDRESS (SPEC 6.1). THE TOKEN IS `<orgId>.<secret>`, ONLY ITS HASH IS STORED, IT IS MAILED ONCE.

// IMPORTED TYPES
import type { DbHandle } from '../db/client';
import type { Mailer } from '../email/mailer';
import type { Role } from './roles';
// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { invite, member, org, user } from '../db/schema';
import { withTenant } from '../db/tenant';
import { inviteMail } from '../email/templates';
import { OrgError } from './orgs';
import { canAssignRole } from './roles';

// -- CONSTANTS -- //

export const INVITE_DAYS = 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -- FUNCTIONS -- //

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const normal = (email: string) => email.trim().toLowerCase();

/** Splits a token into its org id and the whole token (the org id lets the lookup run inside that org's row level security). */
export function parseToken(token: string): { orgId: string } | null {
	const orgId = token.split('.')[0];
	return orgId && UUID.test(orgId) && token.length > 60 ? { orgId } : null;
}

/**
 * Creates an invite for one email address at one role and mails it. An earlier open invite for the same address is
 * replaced. A failed send is returned (emailFailed) together with the link, so the inviter can copy it and try again.
 */
export async function createInvite(
	handle: DbHandle,
	mailer: Mailer,
	baseUrl: string,
	orgId: string,
	actorId: string,
	input: { email: string; role: Role }
) {
	const email = normal(input.email);
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
		throw new OrgError('INVALID', 'Enter a full email address.');
	const secret = randomBytes(32).toString('base64url');
	const token = `${orgId}.${secret}`;
	const created = await withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		const [actor] = await tx
			.select({ role: member.role, name: user.name })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(and(eq(member.orgId, orgId), eq(member.userId, actorId)));
		if (!actor || !canAssignRole(actor.role, null, input.role))
			throw new OrgError('FORBIDDEN', 'Your role does not allow inviting at that role.');
		const [o] = await tx
			.select({ name: org.name, settings: org.settings, deletedAt: org.deletedAt })
			.from(org)
			.where(eq(org.id, orgId));
		if (o?.deletedAt)
			throw new OrgError('ORG_LOCKED', 'This organisation is scheduled for deletion.');
		if (input.role === 'guest' && o?.settings?.allowGuestInvites === false)
			throw new OrgError('FORBIDDEN', 'This organisation does not allow inviting guests.');
		// One open invite per address: the older ones stop working
		await tx
			.update(invite)
			.set({ revokedAt: sql`now()` })
			.where(
				and(
					eq(invite.orgId, orgId),
					eq(invite.email, email),
					isNull(invite.acceptedAt),
					isNull(invite.revokedAt)
				)
			);
		const [row] = await tx
			.insert(invite)
			.values({
				orgId,
				email,
				role: input.role,
				tokenHash: hashOf(token),
				invitedBy: actorId,
				expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000)
			})
			.returning();
		return { row, orgName: o?.name ?? 'the organisation', inviter: actor.name };
	});
	const url = `${baseUrl}/invite/${token}`;
	try {
		await mailer.send(inviteMail(email, created.orgName, created.inviter, input.role, url));
		return { inviteId: created.row.id, emailFailed: false as const, url };
	} catch (e) {
		await withTenant(handle, { orgId, userId: actorId }, (tx) =>
			tx.update(invite).set({ emailFailed: true }).where(eq(invite.id, created.row.id))
		);
		return {
			inviteId: created.row.id,
			emailFailed: true as const,
			url,
			reason: e instanceof Error ? e.message : 'The email could not be sent.'
		};
	}
}

export async function listInvites(handle: DbHandle, orgId: string, actorId: string) {
	return withTenant(handle, { orgId, userId: actorId }, (tx) =>
		tx
			.select()
			.from(invite)
			.where(and(eq(invite.orgId, orgId), isNull(invite.acceptedAt), isNull(invite.revokedAt)))
			.orderBy(desc(invite.createdAt))
	);
}

export async function revokeInvite(
	handle: DbHandle,
	orgId: string,
	actorId: string,
	inviteId: string
) {
	return withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		const [actor] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, orgId), eq(member.userId, actorId)));
		if (!actor || (actor.role !== 'owner' && actor.role !== 'admin'))
			throw new OrgError('FORBIDDEN', 'Your role does not allow revoking invitations.');
		await tx
			.update(invite)
			.set({ revokedAt: sql`now()` })
			.where(and(eq(invite.id, inviteId), isNull(invite.acceptedAt)));
	});
}

export type AcceptResult =
	| { ok: true; orgSlug: string; role: Role }
	| {
			ok: false;
			code: 'INVALID' | 'EXPIRED' | 'USED' | 'WRONG_EMAIL' | 'UNVERIFIED';
			message: string;
	  };

/**
 * Accepts an invite for the signed in person. It works only for the invited email address, only once, and only
 * for an account whose email is verified. The invite is locked while it is used, so two clicks cannot both win.
 */
export async function acceptInvite(
	handle: DbHandle,
	token: string,
	person: { id: string; email: string; emailVerified: boolean }
): Promise<AcceptResult> {
	const parsed = parseToken(token);
	if (!parsed) return { ok: false, code: 'INVALID', message: 'This invitation link is not valid.' };
	return withTenant(handle, { orgId: parsed.orgId, userId: person.id }, async (tx) => {
		const [row] = await tx
			.select()
			.from(invite)
			.where(eq(invite.tokenHash, hashOf(token)))
			.for('update');
		if (!row)
			return { ok: false, code: 'INVALID', message: 'This invitation link is not valid.' } as const;
		if (row.revokedAt || row.acceptedAt)
			return {
				ok: false,
				code: 'USED',
				message: 'This invitation was already used or was withdrawn. Ask for a new one.'
			} as const;
		if (row.expiresAt <= new Date())
			return {
				ok: false,
				code: 'EXPIRED',
				message: 'This invitation has expired. Ask for a new one.'
			} as const;
		if (!person.emailVerified)
			return {
				ok: false,
				code: 'UNVERIFIED',
				message: 'Confirm your email address first, then open the link again.'
			} as const;
		if (normal(person.email) !== row.email)
			return {
				ok: false,
				code: 'WRONG_EMAIL',
				message: `This invitation is for ${row.email}. Sign in with that address to accept it.`
			} as const;
		const [live] = await tx
			.select({ deletedAt: org.deletedAt })
			.from(org)
			.where(eq(org.id, row.orgId));
		if (!live || live.deletedAt)
			return {
				ok: false,
				code: 'INVALID',
				message:
					'This organisation is scheduled for deletion, so the invitation cannot be accepted.'
			} as const;
		await tx
			.insert(member)
			.values({ orgId: row.orgId, userId: person.id, role: row.role })
			.onConflictDoNothing();
		await tx
			.update(invite)
			.set({ acceptedAt: sql`now()` })
			.where(eq(invite.id, row.id));
		const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, row.orgId));
		return { ok: true, orgSlug: o.slug, role: row.role } as const;
	});
}

/** What an invite link is for, shown before accepting. It reveals only what the token holder is already given. */
export async function describeInvite(handle: DbHandle, token: string) {
	const parsed = parseToken(token);
	if (!parsed) return null;
	return withTenant(handle, { orgId: parsed.orgId }, async (tx) => {
		const [row] = await tx
			.select({
				email: invite.email,
				role: invite.role,
				expiresAt: invite.expiresAt,
				acceptedAt: invite.acceptedAt,
				revokedAt: invite.revokedAt,
				orgName: org.name,
				orgDeletedAt: org.deletedAt
			})
			.from(invite)
			.innerJoin(org, eq(org.id, invite.orgId))
			.where(eq(invite.tokenHash, hashOf(token)));
		// An org scheduled for deletion shows the same page as a link that does not exist
		if (!row || row.orgDeletedAt) return null;
		const state =
			row.revokedAt || row.acceptedAt
				? ('used' as const)
				: row.expiresAt <= new Date()
					? ('expired' as const)
					: ('open' as const);
		return { email: row.email, role: row.role as Role, orgName: row.orgName, state };
	});
}
