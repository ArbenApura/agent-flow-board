// NOTE FOLDER VERBS: THE TREE, CREATE, RENAME, MOVE, TRASH AND RESTORE (AFB-20261111-0035)
// Every verb that changes the tree takes one lock for the project first and checks the tree only after it, so two moves
// at the same moment can never make a loop.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { NOTE_LIMITS } from '../../shared/notes';
import { appendEvent } from '../db/events';
import { NO_PARENT, note, noteFolder } from '../db/schema';
import { noteFolderInput } from '../db/zod';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import { findProject, isUuid, noteRoleOf, visibleNoteSql } from './resolve';

// -- TYPES -- //

export type FolderRow = {
	id: string;
	parentId: string | null;
	name: string;
	position: number;
	/** 1 at the top. */
	depth: number;
	/** The names from the top, joined with a slash: Research/Competitors. */
	path: string;
	/** The notes in this folder the caller may see. */
	notes: number;
};

// -- CONSTANTS -- //

const MAX_DEPTH = NOTE_LIMITS.folderDepth;

const folderName = z.object({
	project: z.string().min(1),
	/** A folder id, or its path from the top (Research/Competitors). */
	folder: z.string().min(1)
});
export const folderNewInput = noteFolderInput.extend({ project: z.string().min(1) });
export const folderRenameInput = folderName.extend({ name: noteFolderInput.shape.name });
export const folderMoveInput = folderName.extend({
	/** The folder to move it into, or null for the top. */
	parentId: z.string().uuid().nullable()
});
export const folderNameInput = folderName;
export const folderListInput = z.object({ project: z.string().min(1) });

// -- FUNCTIONS -- //

const rowsOf = <T>(res: unknown) => (res as { rows: T[] }).rows;
const noFolder = () => new OpError('NOT_FOUND', 'That folder does not exist.');
const taken = (name: string) =>
	new OpError('CONFLICT', `There is already a folder named "${name}" here. Pick another name.`);

/** One lock per project for every change to its folder tree, held until the transaction ends. */
export const lockTree = (tx: Tx, projectId: string) =>
	tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`note_tree:${projectId}`}))`);

/** The live folders of a project as a flat list in path order, read in one recursive query. Hidden folders are left out. */
export async function readTree(tx: Tx, projectId: string): Promise<Omit<FolderRow, 'notes'>[]> {
	const res = await tx.execute(sql`
		with recursive tree(id, parent_id, name, position, depth, path) as (
			select id, parent_id, name, position, 1, name::text
			from note_folder where project_id = ${projectId}::uuid and parent_id is null and deleted_at is null
			union all
			select f.id, f.parent_id, f.name, f.position, t.depth + 1, t.path || '/' || f.name
			from note_folder f join tree t on f.parent_id = t.id
			where f.deleted_at is null and t.depth < ${sql.raw(String(MAX_DEPTH))}
		)
		select id, parent_id as "parentId", name, position, depth, path from tree order by lower(path), id`);
	return rowsOf<Omit<FolderRow, 'notes'>>(res);
}

/** A live folder of the project by id or by path, compared without case. */
export async function findFolder(tx: Tx, projectId: string, idOrPath: string) {
	const q = idOrPath.trim();
	const tree = await readTree(tx, projectId);
	const hit = isUuid(q)
		? tree.find((f) => f.id === q)
		: tree.find((f) => f.path.toLowerCase() === q.replace(/^\/+|\/+$/g, '').toLowerCase());
	if (!hit) throw noFolder();
	return hit;
}

/** The folder and every folder above it, nearest first. Ends even if the table held a loop. */
async function chainUp(tx: Tx, folderId: string): Promise<string[]> {
	const res = await tx.execute(sql`
		with recursive up(id, parent_id, depth) as (
			select id, parent_id, 1 from note_folder where id = ${folderId}::uuid
			union
			select f.id, f.parent_id, u.depth + 1 from note_folder f join up u on f.id = u.parent_id
			where u.depth <= ${sql.raw(String(MAX_DEPTH))}
		)
		select id from up order by depth`);
	return rowsOf<{ id: string }>(res).map((r) => r.id);
}

/** The folder and every folder under it, with how many levels the deepest sits below it (1 for the folder alone). */
async function subtree(tx: Tx, folderId: string): Promise<{ ids: string[]; height: number }> {
	const res = await tx.execute(sql`
		with recursive down(id, depth) as (
			select id, 1 from note_folder where id = ${folderId}::uuid
			union
			select f.id, d.depth + 1 from note_folder f join down d on f.parent_id = d.id
			where d.depth <= ${sql.raw(String(MAX_DEPTH))}
		)
		select id, depth from down`);
	const rows = rowsOf<{ id: string; depth: number }>(res);
	return {
		ids: [...new Set(rows.map((r) => r.id))],
		height: Math.max(1, ...rows.map((r) => Number(r.depth)))
	};
}

/** Refuses a name another live folder of the same parent already has, whatever the case. */
async function requireFreeName(
	tx: Tx,
	projectId: string,
	parentId: string | null,
	name: string,
	exceptId?: string
) {
	const res = await tx.execute(sql`
		select id from note_folder
		where project_id = ${projectId}::uuid and deleted_at is null
			and coalesce(parent_id, ${NO_PARENT}::uuid) = coalesce(${parentId}::uuid, ${NO_PARENT}::uuid)
			and lower(name) = lower(${name})`);
	if (rowsOf<{ id: string }>(res).some((r) => r.id !== exceptId)) throw taken(name);
}

/** The database's own unique error (a name taken between the check and the write) is the same CONFLICT. */
async function uniqueAsConflict<T>(name: string, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		for (
			let err = e as { code?: string; cause?: unknown } | undefined;
			err;
			err = err.cause as typeof err
		)
			if (err.code === '23505') throw taken(name);
		throw e;
	}
}

const folderEvent = (
	tx: Tx,
	ctx: Ctx,
	row: { id: string; projectId: string },
	verb: string,
	patch: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {}
) =>
	appendEvent(tx, {
		orgId: ctx.orgId,
		projectId: row.projectId,
		...actorFields(ctx),
		verb,
		targetType: 'note_folder',
		targetId: row.id,
		before: patch.before as never,
		after: patch.after as never,
		undoable: false
	});

// -- READ -- //

/** The folder tree of a project with, for each folder, the number of notes in it the caller may see. */
export async function listFolders(ctx: Ctx, raw: z.input<typeof folderListInput>) {
	const input = folderListInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		if (!(await noteRoleOf(tx, ctx, proj.id)))
			throw new OpError('FORBIDDEN', 'Notes are not shared with guests.', {
				needed: 'read',
				role: 'guest'
			});
		const tree = await readTree(tx, proj.id);
		const counts = await tx
			.select({
				folderId: note.folderId,
				n: sql<number>`count(*)::int`,
				// The caller's own stars, so the tree can show how many favourites there are
				starred: sql<number>`(count(*) filter (where exists (select 1 from note_favourite nf where nf.note_id = ${note.id} and nf.user_id = ${ctx.actor.userId})))::int`
			})
			.from(note)
			.where(and(eq(note.projectId, proj.id), visibleNoteSql(ctx.actor.userId)))
			.groupBy(note.folderId);
		const byFolder = new Map(counts.map((c) => [c.folderId, c.n]));
		const folders: FolderRow[] = tree.map((f) => ({
			...f,
			depth: Number(f.depth),
			notes: byFolder.get(f.id) ?? 0
		}));
		return {
			project: { id: proj.id, key: proj.key },
			folders,
			/** The notes that sit in no folder. */
			top: byFolder.get(null) ?? 0,
			/** The notes the caller starred. */
			favourites: counts.reduce((sum, c) => sum + c.starred, 0)
		};
	});
}

/**
 * The id of a live folder named by id or by path, for a tool that names folders the way a person reads them. An empty
 * name, a single slash and the word "top" mean no folder.
 */
export async function resolveFolderId(
	ctx: Ctx,
	project: string,
	idOrPath: string | null | undefined
): Promise<string | null | undefined> {
	if (idOrPath === undefined) return undefined;
	const q = (idOrPath ?? '').trim();
	const isTop = q === '' || q === '/' || q.toLowerCase() === 'top';
	// A folder really named "top" wins over the word: the name is looked up first, and only a miss means no folder
	if (q === '') return null;
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, project);
		await requireCap(tx, ctx, 'read', proj.id);
		if (!(await noteRoleOf(tx, ctx, proj.id))) throw noFolder();
		try {
			return (await findFolder(tx, proj.id, q)).id;
		} catch (e) {
			if (isTop && e instanceof OpError && e.code === 'NOT_FOUND') return null;
			throw e;
		}
	});
}

// -- CREATE AND RENAME -- //

export async function createFolder(ctx: Ctx, raw: z.input<typeof folderNewInput>) {
	const input = folderNewInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			await lockTree(tx, proj.id);
			const parentId = input.parentId ?? null;
			if (parentId) {
				const parent = await findFolder(tx, proj.id, parentId);
				if (Number(parent.depth) + 1 > MAX_DEPTH)
					throw new OpError('INVALID', `A folder can sit at most ${MAX_DEPTH} levels deep.`);
			}
			await requireFreeName(tx, proj.id, parentId, input.name);
			const [row] = await uniqueAsConflict(input.name, () =>
				tx
					.insert(noteFolder)
					.values({
						orgId: ctx.orgId,
						projectId: proj.id,
						parentId,
						name: input.name,
						createdBy: ctx.actor.userId
					})
					.returning()
			);
			await folderEvent(tx, ctx, row, 'note_folder.create', { after: { name: row.name } });
			return { id: row.id, name: row.name, parentId: row.parentId };
		})
	);
}

export async function renameFolder(ctx: Ctx, raw: z.input<typeof folderRenameInput>) {
	const input = folderRenameInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			await lockTree(tx, proj.id);
			const f = await findFolder(tx, proj.id, input.folder);
			if (f.name === input.name) return { id: f.id, name: f.name, parentId: f.parentId };
			await requireFreeName(tx, proj.id, f.parentId, input.name, f.id);
			await uniqueAsConflict(input.name, () =>
				tx
					.update(noteFolder)
					.set({ name: input.name, updatedAt: sql`now()` })
					.where(eq(noteFolder.id, f.id))
			);
			await folderEvent(tx, ctx, { id: f.id, projectId: proj.id }, 'note_folder.update', {
				before: { name: f.name },
				after: { name: input.name }
			});
			return { id: f.id, name: input.name, parentId: f.parentId };
		})
	);
}

// -- MOVE -- //

export async function moveFolder(ctx: Ctx, raw: z.input<typeof folderMoveInput>) {
	const input = folderMoveInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			// The lock comes first: the checks below read the tree as it will be when this move lands
			await lockTree(tx, proj.id);
			const f = await findFolder(tx, proj.id, input.folder);
			if (input.parentId === f.parentId) return { id: f.id, name: f.name, parentId: f.parentId };
			if (input.parentId) {
				await findFolder(tx, proj.id, input.parentId);
				const above = await chainUp(tx, input.parentId);
				if (above.includes(f.id))
					throw new OpError(
						'INVALID',
						'A folder cannot be moved into itself or a folder inside it.'
					);
				const { height } = await subtree(tx, f.id);
				if (above.length + height > MAX_DEPTH)
					throw new OpError('INVALID', `A folder can sit at most ${MAX_DEPTH} levels deep.`);
			}
			await requireFreeName(tx, proj.id, input.parentId, f.name, f.id);
			await uniqueAsConflict(f.name, () =>
				tx
					.update(noteFolder)
					.set({ parentId: input.parentId, updatedAt: sql`now()` })
					.where(eq(noteFolder.id, f.id))
			);
			await folderEvent(tx, ctx, { id: f.id, projectId: proj.id }, 'note_folder.update', {
				before: { parentId: f.parentId },
				after: { parentId: input.parentId }
			});
			return { id: f.id, name: f.name, parentId: input.parentId };
		})
	);
}

// -- TRASH AND RESTORE -- //

/**
 * Moves a folder to the trash. Its sub-folders and notes are hidden by this folder's state alone, not trashed one by
 * one, so a restore brings them back as they were. The public link of every note under it is switched off, and stays off.
 */
export async function trashFolder(ctx: Ctx, raw: z.input<typeof folderNameInput>) {
	const input = folderNameInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'delete', proj.id);
			await rateLimit(tx, ctx, 'write');
			await lockTree(tx, proj.id);
			const f = await findFolder(tx, proj.id, input.folder);
			const { ids } = await subtree(tx, f.id);
			// A private note of someone else may sit in any folder under this one. Hiding it would hide a note its owner
			// never agreed to move, so only the person who wrote it may trash the folder.
			const foreign = await tx.execute(sql`
				select 1 as hit from note
				where project_id = ${proj.id}::uuid and visibility = 'private' and created_by is distinct from ${ctx.actor.userId}
					and folder_id in (${sql.join(
						ids.map((i) => sql`${i}::uuid`),
						sql`, `
					)})
				limit 1`);
			if (rowsOf(foreign).length)
				throw new OpError(
					'CONFLICT',
					'A note in this folder belongs to someone else and is private, so only the person who wrote it can trash the folder.'
				);
			await tx
				.update(noteFolder)
				.set({ deletedAt: sql`now()`, deletedBy: ctx.actor.userId, updatedAt: sql`now()` })
				.where(eq(noteFolder.id, f.id));
			const closed = await tx
				.update(note)
				.set({ publicEnabled: false, publicTokenHash: null })
				.where(
					and(
						eq(note.projectId, proj.id),
						sql`${note.folderId} in (${sql.join(
							ids.map((i) => sql`${i}::uuid`),
							sql`, `
						)})`,
						eq(note.publicEnabled, true)
					)
				)
				.returning({ id: note.id });
			await folderEvent(tx, ctx, { id: f.id, projectId: proj.id }, 'note_folder.delete', {
				before: { name: f.name }
			});
			return { id: f.id, name: f.name, trashed: true, linksClosed: closed.length };
		})
	);
}

export async function restoreFolder(ctx: Ctx, raw: { project: string; folderId: string }) {
	const input = z.object({ project: z.string().min(1), folderId: z.string().uuid() }).parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'delete', proj.id);
			await rateLimit(tx, ctx, 'write');
			await lockTree(tx, proj.id);
			const [f] = await tx
				.select()
				.from(noteFolder)
				.where(
					and(
						eq(noteFolder.id, input.folderId),
						eq(noteFolder.projectId, proj.id),
						sql`${noteFolder.deletedAt} is not null`
					)
				);
			if (!f) throw noFolder();
			// A folder whose parent is gone or still in the trash comes back at the top
			let parentId = f.parentId;
			if (parentId) {
				const tree = await readTree(tx, proj.id);
				if (!tree.some((t) => t.id === parentId)) parentId = null;
			}
			await requireFreeName(tx, proj.id, parentId, f.name, f.id);
			await uniqueAsConflict(f.name, () =>
				tx
					.update(noteFolder)
					.set({ deletedAt: null, deletedBy: null, parentId, updatedAt: sql`now()` })
					.where(eq(noteFolder.id, f.id))
			);
			await folderEvent(tx, ctx, f, 'note_folder.restore', { after: { name: f.name } });
			return { id: f.id, name: f.name, parentId, trashed: false };
		})
	);
}
