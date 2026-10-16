// FINDING THINGS BY THE NAMES PEOPLE USE: AN ITEM BY ID, REFERENCE (HAPR-142) OR OLD ALIAS (FLOW-20261007-1441), A PROJECT BY KEY

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
import type { Role } from '../orgs/roles';
// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { item, itemAlias, member, project, projectMember } from '../db/schema';
import { effectiveProjectRole } from '../orgs/roles';
import { OpError, projectAllowed } from './context';

// -- CONSTANTS -- //

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -- FUNCTIONS -- //

export const isUuid = (v: string) => UUID.test(v);

/**
 * Resolves an item inside the caller's org only (aliases never cross orgs, L15). An unknown name and another org's
 * item give the same NOT_FOUND, so a name cannot be used to probe other orgs.
 */
export async function findItem(
	tx: Tx,
	ctx: Ctx,
	nameOrId: string,
	options: { lock?: boolean; includeTrashed?: boolean } = {}
) {
	const q = nameOrId.trim();
	const trashed = options.includeTrashed ? undefined : sql`${item.deletedAt} is null`;
	let row: typeof item.$inferSelect | undefined;
	if (isUuid(q)) {
		const base = tx
			.select()
			.from(item)
			.where(and(eq(item.id, q), eq(item.orgId, ctx.orgId), trashed));
		[row] = options.lock ? await base.for('update') : await base;
	} else {
		const base = tx
			.select()
			.from(item)
			.where(and(eq(item.orgId, ctx.orgId), sql`upper(${item.ref}) = ${q.toUpperCase()}`, trashed));
		[row] = options.lock ? await base.for('update') : await base;
		if (!row) {
			const [a] = await tx
				.select({ itemId: itemAlias.itemId })
				.from(itemAlias)
				.where(
					and(eq(itemAlias.orgId, ctx.orgId), sql`upper(${itemAlias.alias}) = ${q.toUpperCase()}`)
				);
			if (a) {
				const base2 = tx
					.select()
					.from(item)
					.where(and(eq(item.id, a.itemId), trashed));
				[row] = options.lock ? await base2.for('update') : await base2;
			}
		}
	}
	if (!row) throw new OpError('NOT_FOUND', `No item named "${nameOrId}".`);
	await requireVisible(tx, ctx, row);
	return row;
}

/** Private items are visible to admins and owners, and to the person who made them or holds them. */
export function canSeeItem(
	role: Role | null,
	it: Pick<typeof item.$inferSelect, 'visibility' | 'createdBy' | 'assigneeId'>,
	userId: string
): boolean {
	if (it.visibility === 'public') return true;
	return (
		role === 'owner' || role === 'admin' || it.createdBy === userId || it.assigneeId === userId
	);
}

/**
 * Every verb that names an item comes through findItem, so the project, token and privacy rules are applied here, before
 * any change, and a hidden item gives the same NOT_FOUND as one that does not exist. A system call with no person
 * (the webhook that reads commits) has no actor and is not limited.
 */
export async function mayView(tx: Tx, ctx: Ctx, row: typeof item.$inferSelect): Promise<boolean> {
	try {
		await requireVisible(tx, ctx, row);
		return true;
	} catch (e) {
		if (e instanceof OpError) return false;
		throw e;
	}
}

async function requireVisible(tx: Tx, ctx: Ctx, row: typeof item.$inferSelect) {
	const actor = ctx.actor;
	if (!actor?.userId) return;
	const notFound = () => new OpError('NOT_FOUND', 'No item with that name.');
	if (!projectAllowed(actor, row.projectId)) throw notFound();
	const [m] = await tx
		.select({ role: member.role })
		.from(member)
		.where(and(eq(member.orgId, ctx.orgId), eq(member.userId, actor.userId)));
	if (!m) throw notFound();
	const [o] = await tx
		.select({ role: projectMember.role })
		.from(projectMember)
		.where(and(eq(projectMember.projectId, row.projectId), eq(projectMember.userId, actor.userId)));
	const role = effectiveProjectRole(m.role, o?.role ?? null);
	if (!role || !canSeeItem(role, row, actor.userId)) throw notFound();
}

/** A project by its key (CKT) or id, inside the caller's org. */
export async function findProject(tx: Tx, ctx: Ctx, keyOrId: string) {
	const q = keyOrId.trim();
	const where = isUuid(q)
		? and(eq(project.id, q), eq(project.orgId, ctx.orgId))
		: and(eq(project.orgId, ctx.orgId), sql`upper(${project.key}) = ${q.toUpperCase()}`);
	const [row] = await tx.select().from(project).where(where);
	if (!row || (ctx.actor && !projectAllowed(ctx.actor, row.id)))
		throw new OpError('NOT_FOUND', `No project named "${keyOrId}".`);
	return row;
}
