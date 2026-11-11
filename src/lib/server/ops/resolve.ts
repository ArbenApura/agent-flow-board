// FINDING THINGS BY THE NAMES PEOPLE USE: AN ITEM BY ID, REFERENCE (HAPR-20261017-0950), OR AN OLD ALIAS (HAPR-142, FLOW-20261007-1441), A PROJECT BY KEY

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
import type { Role } from '../orgs/roles';
// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { NOTE_LIMITS } from '../../shared/notes';
import { item, itemAlias, note, project, projectCols, projectLogoV } from '../db/schema';
import { effectiveProjectRole } from '../orgs/roles';
import { OpError, orgRoleOf, projectAllowed, projectRoleOf } from './context';

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

/**
 * A private item is visible only to the person who created it, whatever their role: owners, admins and the assignee
 * included. An item with no creator (or whose creator left) stays hidden from everyone (ADR 1). The role is still taken so
 * callers read the same, and it never widens access.
 */
export function canSeeItem(
	_role: Role | null,
	it: Pick<typeof item.$inferSelect, 'visibility' | 'createdBy'>,
	userId: string
): boolean {
	if (it.visibility === 'public') return true;
	return it.createdBy !== null && it.createdBy === userId;
}

/** The visibility rule of canSeeItem as SQL, for lists, counts and activity. Every query that filters items uses this one. */
export const visibleItemSql = (userId: string) =>
	sql`(${item.visibility} = 'public' or ${item.createdBy} = ${userId})`;

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
	// Both roles are read once per transaction, however many items are checked
	const orgRole = await orgRoleOf(tx, ctx.orgId, actor.userId);
	if (!orgRole) throw notFound();
	const role = effectiveProjectRole(orgRole, await projectRoleOf(tx, row.projectId, actor.userId));
	if (!role || !canSeeItem(role, row, actor.userId)) throw notFound();
}

// -- NOTES (AFB-20261111-0035): EVERY READ PATH OF A NOTE USES THESE HELPERS AND NO OTHER FILTER -- //

/**
 * The role the caller holds for the notes of one project: their role on that project, and null for a guest there, for a
 * person with no access to the project and for a token limited to other projects. Notes are hidden from guests (rule 3),
 * so the role is always the project's, never the organisation's alone.
 */
export async function noteRoleOf(tx: Tx, ctx: Ctx, projectId: string): Promise<Role | null> {
	const actor = ctx.actor;
	if (!actor?.userId || !projectAllowed(actor, projectId)) return null;
	const orgRole = await orgRoleOf(tx, ctx.orgId, actor.userId);
	if (!orgRole) return null;
	const role = effectiveProjectRole(orgRole, await projectRoleOf(tx, projectId, actor.userId));
	return role && role !== 'guest' ? role : null;
}

/**
 * A shared note is seen by everyone on the project but guests. A private note is seen only by the person who created it,
 * whatever their role: owners and admins included (the rule of a private plan).
 */
export function canSeeNote(
	role: Role | null,
	n: Pick<typeof note.$inferSelect, 'visibility' | 'createdBy'>,
	userId: string
): boolean {
	if (!role || role === 'guest') return false;
	if (n.visibility === 'public') return true;
	return n.createdBy !== null && n.createdBy === userId;
}

/**
 * The folders that are hidden because they, or a folder above them, are in the trash: worked out once per query by walking
 * down from the trashed folders. UNION and the depth guard make it end even if the table ever held a loop.
 */
export const hiddenNoteFoldersSql = () =>
	sql`(with recursive hidden(id, depth) as (
		select id, 1 from note_folder where deleted_at is not null
		union
		select f.id, h.depth + 1 from note_folder f join hidden h on f.parent_id = h.id where h.depth < ${sql.raw(String(NOTE_LIMITS.folderDepth))}
	) select id from hidden)`;

/**
 * The rule of canSeeNote as SQL, with the trash: the note is not trashed, its folder is not hidden, and it is shared or
 * the caller's own. The caller's role (never a guest) is checked apart, with noteRoleOf. `trash: 'only'` gives the notes
 * that are themselves in the trash, for the Trash page.
 */
export const visibleNoteSql = (userId: string, options: { trash?: 'only' } = {}) =>
	options.trash === 'only'
		? sql`(${note.deletedAt} is not null and (${note.visibility} = 'public' or ${note.createdBy} = ${userId}))`
		: sql`(${note.deletedAt} is null and (${note.visibility} = 'public' or ${note.createdBy} = ${userId}) and (${note.folderId} is null or ${note.folderId} not in ${hiddenNoteFoldersSql()}))`;

/**
 * Refuses a note the caller may not see with the same NOT_FOUND as a note that does not exist, so a reference cannot be
 * used to probe for private notes. A system call with no person is not limited. Returns the caller's role on the project.
 */
export async function requireNoteVisible(
	tx: Tx,
	ctx: Ctx,
	row: Pick<typeof note.$inferSelect, 'projectId' | 'visibility' | 'createdBy' | 'folderId'>
): Promise<Role | null> {
	const actor = ctx.actor;
	if (!actor?.userId) return null;
	const notFound = () => new OpError('NOT_FOUND', 'No note with that name.');
	const role = await noteRoleOf(tx, ctx, row.projectId);
	if (!canSeeNote(role, row, actor.userId)) throw notFound();
	if (row.folderId) {
		const hidden = await tx.execute(
			sql`select 1 as hit where ${row.folderId}::uuid in ${hiddenNoteFoldersSql()}`
		);
		if ((hidden as unknown as { rows: unknown[] }).rows.length) throw notFound();
	}
	return role;
}

/** A project by its key (CKT) or id, inside the caller's org. */
export async function findProject(tx: Tx, ctx: Ctx, keyOrId: string) {
	const q = keyOrId.trim();
	const where = isUuid(q)
		? and(eq(project.id, q), eq(project.orgId, ctx.orgId))
		: and(eq(project.orgId, ctx.orgId), sql`upper(${project.key}) = ${q.toUpperCase()}`);
	// The logo is never read here: it is up to 270 KB and a page only needs its version
	const [row] = await tx
		.select({ ...projectCols, logoV: projectLogoV })
		.from(project)
		.where(where);
	if (!row || (ctx.actor && !projectAllowed(ctx.actor, row.id)))
		throw new OpError('NOT_FOUND', `No project named "${keyOrId}".`);
	return row;
}
