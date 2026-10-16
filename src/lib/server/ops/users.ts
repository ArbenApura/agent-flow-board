// DELETING A PERSON: THEIR ACCOUNT GOES, THE HISTORY STAYS BUT NO LONGER NAMES THEM (L19, ADR-025)

// -- TYPES -- //
import type { DbHandle } from '../db/client';
// -- DEP-MODULES -- //
import { eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { comment, event, item, member, step, user } from '../db/schema';
import { withTenant } from '../db/tenant';

// -- CONSTANTS -- //

export const FORMER_MEMBER = 'Former member';

// -- FUNCTIONS -- //

/**
 * Anonymises everything a person authored in every org they belong to, then deletes the account (sessions, accounts,
 * tokens and devices go with it by cascade). Events stay with the actor removed, so the audit trail keeps its shape.
 * Snapshots already published to a git history are outside the board's control and are not rewritten (ADR-025).
 * Refuses to leave an org without an Owner.
 */
export async function deleteUserAccount(
	handle: DbHandle,
	userId: string
): Promise<{ orgs: number; eventsAnonymised: number; soleOwnerOf: string[] }> {
	const memberships = await withTenant(handle, { userId }, (tx) =>
		tx
			.select({ orgId: member.orgId, role: member.role })
			.from(member)
			.where(eq(member.userId, userId))
	);
	const soleOwnerOf: string[] = [];
	for (const m of memberships.filter((x) => x.role === 'owner')) {
		const owners = await withTenant(handle, { orgId: m.orgId }, (tx) =>
			tx
				.select({ n: sql<number>`count(*)::int` })
				.from(member)
				.where(sql`${member.orgId} = ${m.orgId} and ${member.role} = 'owner'`)
		);
		if (owners[0].n <= 1) soleOwnerOf.push(m.orgId);
	}
	if (soleOwnerOf.length) return { orgs: 0, eventsAnonymised: 0, soleOwnerOf };
	let eventsAnonymised = 0;
	for (const m of memberships) {
		await withTenant(handle, { orgId: m.orgId, userId }, async (tx) => {
			const done = await tx
				.update(event)
				.set({ actorUserId: null, actorLabel: FORMER_MEMBER })
				.where(eq(event.actorUserId, userId))
				.returning({ id: event.id });
			eventsAnonymised += done.length;
			await tx.update(comment).set({ authorId: null }).where(eq(comment.authorId, userId));
			await tx.update(step).set({ doneBy: null }).where(eq(step.doneBy, userId));
			await tx.update(item).set({ createdBy: null }).where(eq(item.createdBy, userId));
			await tx.update(item).set({ deletedBy: null }).where(eq(item.deletedBy, userId));
			await tx.delete(member).where(eq(member.userId, userId));
		});
	}
	await handle.db.delete(user).where(eq(user.id, userId));
	return { orgs: memberships.length, eventsAnonymised, soleOwnerOf: [] };
}
