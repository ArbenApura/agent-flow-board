// ORGANISATIONS AND MEMBERS. EVERY ORG HAS AT LEAST ONE OWNER, EVEN WHEN TWO PEOPLE LEAVE AT THE SAME MOMENT (L11).

// -- TYPES -- //
import type { DbHandle, Tx } from '../db/client';
import type { Role } from './roles';
// -- DEP-MODULES -- //
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
// -- MODULES -- //
import {
	apiToken,
	attachment,
	item,
	member,
	org,
	orgDeletionLog,
	project,
	projectMember,
	projectPin,
	runner,
	user,
	userPictureV
} from '../db/schema';
import { withTenant } from '../db/tenant';
import { orgInsert } from '../db/zod';
import { purgeAt, sameOrgName } from './deletion';
import { canAssignRole, canRemove, effectiveProjectRole } from './roles';

// -- TYPES -- //

export class OrgError extends Error {
	constructor(
		readonly code:
			'FORBIDDEN' | 'LAST_OWNER' | 'NOT_FOUND' | 'SLUG_TAKEN' | 'INVALID' | 'ORG_LOCKED',
		message: string
	) {
		super(message);
		this.name = 'OrgError';
	}
}
export type MemberRow = {
	userId: string;
	name: string;
	email: string;
	role: Role;
	/** Version of the avatar, or null. The picture itself is at /pictures/user/{userId}?v=. */
	imageV?: number | null;
};

// -- CONSTANTS -- //

/** Org addresses that would collide with a fixed route of the app. */
export const RESERVED_SLUGS = new Set([
	'sign-in',
	'sign-up',
	'sign-out',
	'verify',
	'reset',
	'invite',
	'dev',
	'api',
	'mcp',
	'healthz',
	'settings',
	'search',
	'connect',
	'oauth',
	'device',
	'org',
	'github',
	'internal',
	'admin',
	'static',
	'fonts',
	'favicon',
	'robots',
	'deleted',
	// The public mockup link (/m) and the signed mockup file (/mf)
	'm',
	'mf'
]);

// -- FUNCTIONS -- //

/** Creates an org and makes its creator the Owner, in one transaction. The new org id is set as the tenant first. */
export async function createOrg(
	handle: DbHandle,
	creatorId: string,
	input: { name: string; slug: string }
) {
	const parsed = orgInsert.pick({ name: true, slug: true }).safeParse(input);
	if (!parsed.success)
		throw new OrgError(
			'INVALID',
			parsed.error.issues[0]?.message ?? 'Check the name and the address.'
		);
	if (RESERVED_SLUGS.has(parsed.data.slug))
		throw new OrgError('INVALID', 'That address is reserved. Try another.');
	const orgId = randomUUID();
	try {
		return await withTenant(handle, { orgId, userId: creatorId }, async (tx) => {
			const [created] = await tx
				.insert(org)
				.values({ id: orgId, ...parsed.data })
				.returning();
			await tx.insert(member).values({ orgId, userId: creatorId, role: 'owner' });
			return created;
		});
	} catch (e) {
		const text =
			JSON.stringify(e, Object.getOwnPropertyNames(e as object)) +
			String((e as { cause?: { message?: string } }).cause?.message ?? '');
		if (/org_slug_unique|duplicate key/.test(text))
			throw new OrgError('SLUG_TAKEN', 'That address is already taken. Try another.');
		throw e;
	}
}

/**
 * The orgs a person belongs to, with their role in each. Found through their own memberships, before any org is chosen.
 * An org scheduled for deletion is listed with `deletedAt` set, so the owner can still reach its restore page.
 */
export async function listMyOrgs(handle: DbHandle, userId: string) {
	return withTenant(handle, { userId }, (tx) =>
		tx
			.select({
				id: org.id,
				name: org.name,
				slug: org.slug,
				role: member.role,
				logo: org.logo,
				palette: org.palette,
				deletedAt: org.deletedAt
			})
			.from(member)
			.innerJoin(org, eq(org.id, member.orgId))
			.where(eq(member.userId, userId))
			.orderBy(asc(org.name))
	);
}

/** Resolves an org URL slug to the org, only when the person is a member. An org scheduled for deletion is not found. */
export async function orgForSlug(handle: DbHandle, slug: string, userId: string) {
	const found = await orgForSlugIncludingDeleted(handle, slug, userId);
	return found && !found.deletedAt ? found : null;
}

/** The same lookup, but an org scheduled for deletion is returned too. Only the locked page and the restore verb use it. */
export async function orgForSlugIncludingDeleted(handle: DbHandle, slug: string, userId: string) {
	return withTenant(handle, { orgSlug: slug, userId }, async (tx) => {
		const [row] = await tx
			.select({
				id: org.id,
				name: org.name,
				slug: org.slug,
				role: member.role,
				logo: org.logo,
				palette: org.palette,
				deletedAt: org.deletedAt,
				purgeStartedAt: org.purgeStartedAt
			})
			.from(org)
			.innerJoin(member, and(eq(member.orgId, org.id), eq(member.userId, userId)))
			.where(eq(org.slug, slug));
		return row ?? null;
	});
}

export async function roleOf(
	handle: DbHandle,
	orgId: string,
	userId: string
): Promise<Role | null> {
	return withTenant(handle, { orgId, userId }, async (tx) => {
		const [row] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, orgId), eq(member.userId, userId)));
		return row?.role ?? null;
	});
}

/**
 * The members as one person may see them. A guest is outside the organisation, so they see names and roles but not other
 * people's email addresses.
 */
export function membersFor(members: MemberRow[], viewerId: string): MemberRow[] {
	const me = members.find((m) => m.userId === viewerId);
	if (me?.role !== 'guest') return members;
	return members.map((m) => (m.userId === viewerId ? m : { ...m, email: '' }));
}

export async function listMembers(handle: DbHandle, orgId: string): Promise<MemberRow[]> {
	return withTenant(handle, { orgId }, (tx) =>
		tx
			.select({
				userId: member.userId,
				name: user.name,
				email: user.email,
				role: member.role,
				imageV: userPictureV
			})
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(eq(member.orgId, orgId))
			.orderBy(asc(user.name))
	);
}

/** Serialises changes to one org's membership, so the last owner rule holds under concurrency. */
async function lockOrg(tx: Tx, orgId: string) {
	await tx.execute(sql`select id from org where id = ${orgId} for update`);
}

async function ownerCount(tx: Tx, orgId: string) {
	const [r] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(member)
		.where(and(eq(member.orgId, orgId), eq(member.role, 'owner')));
	return r.n;
}

/** Changes a member's role. The actor's live role is read inside the transaction, never trusted from the caller. */
export async function changeRole(
	handle: DbHandle,
	orgId: string,
	actorId: string,
	targetId: string,
	newRole: Role
) {
	return withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		await lockOrg(tx, orgId);
		const rows = await tx
			.select({ userId: member.userId, role: member.role })
			.from(member)
			.where(eq(member.orgId, orgId));
		const actor = rows.find((r) => r.userId === actorId)?.role ?? null;
		const target = rows.find((r) => r.userId === targetId)?.role ?? null;
		if (!target)
			throw new OrgError('NOT_FOUND', 'That person is not a member of this organisation.');
		if (!canAssignRole(actor, target, newRole))
			throw new OrgError('FORBIDDEN', 'Your role does not allow that change.');
		if (target === 'owner' && newRole !== 'owner' && (await ownerCount(tx, orgId)) <= 1) {
			throw new OrgError(
				'LAST_OWNER',
				'An organisation always needs at least one Owner. Make someone else an Owner first.'
			);
		}
		await tx
			.update(member)
			.set({ role: newRole, updatedAt: sql`now()`, version: sql`${member.version} + 1` })
			.where(and(eq(member.orgId, orgId), eq(member.userId, targetId)));
		return { userId: targetId, role: newRole };
	});
}

/** Removes a member (or lets a person leave) and revokes their tokens for this org. */
export async function removeMember(
	handle: DbHandle,
	orgId: string,
	actorId: string,
	targetId: string
) {
	return withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		await lockOrg(tx, orgId);
		const rows = await tx
			.select({ userId: member.userId, role: member.role })
			.from(member)
			.where(eq(member.orgId, orgId));
		const actor = rows.find((r) => r.userId === actorId)?.role ?? null;
		const target = rows.find((r) => r.userId === targetId)?.role ?? null;
		if (!target)
			throw new OrgError('NOT_FOUND', 'That person is not a member of this organisation.');
		const leaving = actorId === targetId;
		if (!leaving && !canRemove(actor, target))
			throw new OrgError('FORBIDDEN', 'Your role does not allow removing this person.');
		if (target === 'owner' && (await ownerCount(tx, orgId)) <= 1) {
			throw new OrgError(
				'LAST_OWNER',
				'An organisation always needs at least one Owner. Make someone else an Owner first.'
			);
		}
		await tx.delete(member).where(and(eq(member.orgId, orgId), eq(member.userId, targetId)));
		await tx
			.delete(projectMember)
			.where(and(eq(projectMember.orgId, orgId), eq(projectMember.userId, targetId)));
		// Their pins go too, so a person who is added again later does not get old shortcuts back. A pin row is only visible
		// to its own person, so the delete runs as them for one statement and the request goes back to the actor right after
		await tx.execute(sql`select set_config('app.user_id', ${targetId}, true)`);
		await tx
			.delete(projectPin)
			.where(and(eq(projectPin.orgId, orgId), eq(projectPin.userId, targetId)));
		await tx.execute(sql`select set_config('app.user_id', ${actorId}, true)`);
		// Their tokens stop working at once (L8), on top of the live role check every call makes
		await tx
			.update(apiToken)
			.set({ revokedAt: sql`now()` })
			.where(
				and(
					eq(apiToken.orgId, orgId),
					eq(apiToken.userId, targetId),
					sql`${apiToken.revokedAt} is null`
				)
			);
		// A runner they made, and the token that comes with it, goes with them: they know the token, and it opens test accounts
		await tx.delete(runner).where(and(eq(runner.orgId, orgId), eq(runner.ownerId, targetId)));
		return { userId: targetId };
	});
}

/** A per project role override, or removes it when `role` is null. Owners and admins always keep admin rights. */
export async function setProjectRole(
	handle: DbHandle,
	orgId: string,
	actorId: string,
	projectId: string,
	targetId: string,
	role: Role | null
) {
	return withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		const [actorRow] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, orgId), eq(member.userId, actorId)));
		const [targetRow] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, orgId), eq(member.userId, targetId)));
		if (!targetRow)
			throw new OrgError('NOT_FOUND', 'That person is not a member of this organisation.');
		const [proj] = await tx
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.id, projectId), eq(project.orgId, orgId)));
		if (!proj) throw new OrgError('NOT_FOUND', 'That project does not exist in this organisation.');
		if (!canAssignRole(actorRow?.role ?? null, null, role ?? 'member'))
			throw new OrgError('FORBIDDEN', 'Your role does not allow that change.');
		if (role === null) {
			await tx
				.delete(projectMember)
				.where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, targetId)));
		} else {
			await tx
				.insert(projectMember)
				.values({ orgId, projectId, userId: targetId, role })
				.onConflictDoUpdate({
					target: [projectMember.projectId, projectMember.userId],
					set: { role, updatedAt: sql`now()` }
				});
		}
		return { projectId, userId: targetId, role };
	});
}

/** What someone can do inside one project, read live from the database on every call (L8). */
export async function projectRole(
	handle: DbHandle,
	orgId: string,
	projectId: string,
	userId: string
): Promise<Role | null> {
	return withTenant(handle, { orgId, projectId, userId }, async (tx) => {
		const [m] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, orgId), eq(member.userId, userId)));
		if (!m) return null;
		const [o] = await tx
			.select({ role: projectMember.role })
			.from(projectMember)
			.where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, userId)));
		return effectiveProjectRole(m.role, o?.role ?? null);
	});
}

// -- DELETING AN ORGANISATION (FLOW-20261017-0007) -- //

export type OrgDeletionSummary = { projects: number; items: number; files: number };

/** Reads the owner's live role inside the open transaction. Only an Owner may delete or restore. */
async function requireOwner(tx: Tx, orgId: string, actorId: string): Promise<string> {
	const [row] = await tx
		.select({ role: member.role, name: user.name })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(and(eq(member.orgId, orgId), eq(member.userId, actorId)));
	if (row?.role !== 'owner')
		throw new OrgError('FORBIDDEN', 'Only an Owner can delete or restore an organisation.');
	return row.name;
}

/** What deleting the org would remove, for the confirmation dialog. Read only, Owner only. */
export async function orgDeletionSummary(
	handle: DbHandle,
	orgId: string,
	actorId: string
): Promise<OrgDeletionSummary> {
	return withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		await requireOwner(tx, orgId, actorId);
		const one = async (query: Promise<{ n: number }[]>) => (await query)[0].n;
		return {
			projects: await one(
				tx
					.select({ n: sql<number>`count(*)::int` })
					.from(project)
					.where(eq(project.orgId, orgId))
			),
			items: await one(
				tx
					.select({ n: sql<number>`count(*)::int` })
					.from(item)
					.where(eq(item.orgId, orgId))
			),
			files: await one(
				tx
					.select({ n: sql<number>`count(*)::int` })
					.from(attachment)
					.where(and(eq(attachment.orgId, orgId), isNull(attachment.deletedAt)))
			)
		};
	});
}

/**
 * Locks the org: it disappears for everyone, and it is erased once the grace period ends unless an Owner restores it.
 * The live role is read inside the transaction, the typed name is checked here and not only in the dialog, and a second
 * call changes nothing (the first date stands).
 */
export async function deleteOrg(
	handle: DbHandle,
	orgId: string,
	actorId: string,
	typedName: string
): Promise<{ deletedAt: Date; purgeAt: Date }> {
	return withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		await lockOrg(tx, orgId);
		const label = await requireOwner(tx, orgId, actorId);
		const [row] = await tx
			.select({ name: org.name, slug: org.slug, deletedAt: org.deletedAt })
			.from(org)
			.where(eq(org.id, orgId));
		if (!row) throw new OrgError('NOT_FOUND', 'That organisation does not exist.');
		if (row.deletedAt) return { deletedAt: row.deletedAt, purgeAt: purgeAt(row.deletedAt) };
		if (!sameOrgName(typedName, row.name))
			throw new OrgError('INVALID', 'Type the exact name of the organisation to delete it.');
		const [done] = await tx
			.update(org)
			.set({ deletedAt: sql`now()`, updatedAt: sql`now()`, version: sql`${org.version} + 1` })
			.where(and(eq(org.id, orgId), isNull(org.deletedAt)))
			.returning({ deletedAt: org.deletedAt });
		await tx.insert(orgDeletionLog).values({
			orgId,
			orgName: row.name,
			orgSlug: row.slug,
			event: 'deleted',
			actorUserId: actorId,
			actorLabel: label
		});
		return { deletedAt: done.deletedAt!, purgeAt: purgeAt(done.deletedAt!) };
	});
}

/** Brings a deleted org back. Refused once the purge has claimed it. */
export async function restoreOrg(handle: DbHandle, orgId: string, actorId: string) {
	return withTenant(handle, { orgId, userId: actorId }, async (tx) => {
		await lockOrg(tx, orgId);
		const label = await requireOwner(tx, orgId, actorId);
		const [row] = await tx
			.select({
				name: org.name,
				slug: org.slug,
				deletedAt: org.deletedAt,
				purgeStartedAt: org.purgeStartedAt
			})
			.from(org)
			.where(eq(org.id, orgId));
		if (!row) throw new OrgError('NOT_FOUND', 'That organisation does not exist.');
		if (!row.deletedAt) return { restored: false };
		if (row.purgeStartedAt)
			throw new OrgError(
				'INVALID',
				'This organisation is being erased and can no longer be restored.'
			);
		await tx
			.update(org)
			.set({ deletedAt: null, updatedAt: sql`now()`, version: sql`${org.version} + 1` })
			.where(eq(org.id, orgId));
		await tx.insert(orgDeletionLog).values({
			orgId,
			orgName: row.name,
			orgSlug: row.slug,
			event: 'restored',
			actorUserId: actorId,
			actorLabel: label
		});
		return { restored: true };
	});
}
