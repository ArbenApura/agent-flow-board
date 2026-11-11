// ACTIVITY, UNDO AND TRASH VERBS (SPEC 6: "SAFETY NET IN PLACE OF APPROVALS", L14, L17)

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { undoEvent, type UndoResult } from '../db/events';
import {
	attachment,
	event,
	item,
	mockup,
	mockupVersion,
	note,
	noteFile,
	noteFolder,
	task
} from '../db/schema';
import { mockupUnreadError, planWorked, unreadForGate } from './mockupReads';
import { canSeeMockup } from './mockups';
import { OpError, requireCap, run } from './context';
import { lockTree } from './noteFolders';
import {
	canSeeItem,
	findItem,
	findProject,
	mayView,
	noteRoleOf,
	visibleItemSql,
	visibleNoteSql
} from './resolve';

// -- CONSTANTS -- //

export const TRASH_DAYS = 30;
export const eventsInput = z.object({
	project: z.string().min(1),
	item: z.string().optional(),
	sessionId: z.string().optional(),
	/** Events with an id above this one (a reconnecting page asks for what it missed). */
	afterId: z.number().int().optional(),
	limit: z.number().int().min(1).max(200).default(50)
});

// -- FUNCTIONS -- //

/** Longest body text a feed row carries. The stored event keeps the whole text, because undo needs it. */
const FEED_BODY_CHARS = 200;

/** The event data with any long `body` text cut short, marked with how long it was. */
function shortBody<T>(data: T): T {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
	const row = data as Record<string, unknown>;
	if (typeof row.body !== 'string' || row.body.length <= FEED_BODY_CHARS) return data;
	return {
		...row,
		body: row.body.slice(0, FEED_BODY_CHARS),
		bodyLength: row.body.length
	} as T;
}

/** The activity log of a project, newest first, each event labelled with whether it can still be undone. */
export async function listEvents(
	ctx: Ctx,
	raw: z.input<typeof eventsInput>,
	// A light read leaves the before and after patches in the database: the MCP feed shows who did what, not the data
	options: { light?: boolean } = {}
) {
	const input = eventsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		// One item's history, when asked for by name, id or old alias
		const onlyItem = input.item
			? (await findItem(tx, ctx, input.item, { includeTrashed: true })).id
			: undefined;
		// Notes are hidden from guests, and a private note's events from everyone but its creator (AFB-20261111-0035). An
		// event of a note that was purged is hidden too: nobody can tell any more whether it was private.
		const noteReader = !!(await noteRoleOf(tx, ctx, proj.id));
		const noteEvents = noteReader
			? sql`(${event.targetType} not in ('note', 'note_folder') or ${event.targetType} = 'note_folder' or exists (select 1 from note n where n.id::text = ${event.targetId} and (n.visibility = 'public' or n.created_by = ${ctx.actor.userId})))`
			: sql`${event.targetType} not in ('note', 'note_folder')`;
		const rows = await tx
			.select({
				id: event.id,
				verb: event.verb,
				targetType: event.targetType,
				targetId: event.targetId,
				itemId: event.itemId,
				actorLabel: event.actorLabel,
				actorUserId: event.actorUserId,
				tool: event.tool,
				sessionId: event.sessionId,
				before: options.light ? sql<typeof event.$inferSelect.before>`null` : event.before,
				after: options.light ? sql<typeof event.$inferSelect.after>`null` : event.after,
				undoable: event.undoable,
				external: event.external,
				createdAt: event.createdAt,
				undone: sql<boolean>`exists (select 1 from event u where u.undo_of = ${event.id})`
			})
			.from(event)
			.leftJoin(item, eq(item.id, event.itemId))
			.where(
				and(
					eq(event.projectId, proj.id),
					onlyItem ? eq(event.itemId, onlyItem) : undefined,
					input.sessionId ? eq(event.sessionId, input.sessionId) : undefined,
					input.afterId !== undefined ? gt(event.id, input.afterId) : undefined,
					sql`(${event.itemId} is null or ${visibleItemSql(ctx.actor.userId)})`,
					noteEvents
				)
			)
			.orderBy(desc(event.id))
			.limit(input.limit);
		return rows.map((r) => ({
			...r,
			// A long task description stays in the stored event for undo, but a feed page never carries it whole
			before: shortBody(r.before),
			after: shortBody(r.after),
			undoable: r.undoable && !r.external && !r.undone,
			label: r.external ? 'external' : r.undone ? 'undone' : r.undoable ? 'undoable' : 'final'
		}));
	});
}

/** Does this change carry who may see the item? Undo writes the row directly, so only the item's creator may reverse it. */
const changesVisibility = (ev: { before: unknown; after: unknown }) =>
	[ev.before, ev.after].some(
		(v) => typeof v === 'object' && v !== null && Object.hasOwn(v as object, 'visibility')
	);

/**
 * May this person undo a change to this item? A hidden item answers not-found, and a change of its visibility is the
 * creator's alone, the same rule as updateItem.
 */
async function undoGate(
	tx: Parameters<Parameters<typeof run>[1]>[0],
	ctx: Ctx,
	ev: { itemId: string | null; before: unknown; after: unknown }
): Promise<UndoResult | null> {
	if (!ev.itemId) return null;
	const [it] = await tx.select().from(item).where(eq(item.id, ev.itemId));
	if (!it) return null;
	if (!(await mayView(tx, ctx, it))) return { ok: false, reason: 'not-found' };
	if (changesVisibility(ev) && it.createdBy !== ctx.actor.userId)
		return { ok: false, reason: 'unsupported' };
	return null;
}

/**
 * The unread mockups that hold an agent's undo (AFB-20261111-0046): undoing the reopen of a step puts it back to done,
 * waived or superseded without passing the step verb, so it meets the same gate. Null for a person, for any other change
 * and when every mockup of the plan is read.
 */
async function undoMockupHold(
	tx: Parameters<Parameters<typeof run>[1]>[0],
	ctx: Ctx,
	ev: { itemId: string | null; verb: string; before: unknown; after: unknown }
) {
	if (ctx.actor.kind !== 'agent' || !ev.itemId) return null;
	const before = ev.before as { state?: string } | null;
	const after = ev.after as { state?: string; key?: string } | null;
	const closes =
		after?.state === 'open' &&
		typeof after.key === 'string' &&
		!/^M[0-9]+$/.test(after.key) &&
		['done', 'waived', 'superseded'].includes(before?.state ?? '');
	// Undoing the creation of a phase or a step deletes it with its open steps, which closes what is left. On a plan that
	// was worked on that is the same way round, so it is held too; on a plan that was only written it is plan editing
	const removes =
		(ev.verb === 'phase.create' || ev.verb === 'step.create') && (await planWorked(tx, ev.itemId));
	if (!closes && !removes) return null;
	const [it] = await tx.select().from(item).where(eq(item.id, ev.itemId));
	if (!it) return null;
	const { unread } = await unreadForGate(tx, ctx, it);
	return unread.length ? unread : null;
}

/** Reverses one change with a compensating event. A conflict (the thing changed again since) is reported, not forced. */
export async function undoChange(
	ctx: Ctx,
	eventId: number,
	options: { force?: boolean } = {}
): Promise<UndoResult> {
	return run(ctx, async (tx) => {
		const [ev] = await tx
			.select({
				projectId: event.projectId,
				itemId: event.itemId,
				verb: event.verb,
				before: event.before,
				after: event.after
			})
			.from(event)
			.where(eq(event.id, eventId));
		if (!ev) return { ok: false, reason: 'not-found' } as UndoResult;
		await requireCap(tx, ctx, 'write', ev.projectId);
		// A change to an item this person cannot see is not theirs to undo, and looks the same as one that does not exist
		const refused = await undoGate(tx, ctx, ev);
		if (refused) return refused;
		const held = await undoMockupHold(tx, ctx, ev);
		if (held) throw mockupUnreadError(held, 'change');
		return undoEvent(
			tx,
			{
				actorUserId: ctx.actor.userId,
				actorLabel: ctx.actor.label ?? null,
				tool: ctx.actor.tool ?? null,
				sessionId: ctx.actor.sessionId ?? null
			},
			eventId,
			options
		);
	});
}

/**
 * Undoes everything one session changed, newest first, stopping at the first change that cannot be reversed safely.
 * People may undo their own session, and admins any.
 */
export async function undoSession(ctx: Ctx, sessionId: string) {
	return run(ctx, async (tx) => {
		const mine = await tx
			.select({
				id: event.id,
				projectId: event.projectId,
				itemId: event.itemId,
				verb: event.verb,
				before: event.before,
				after: event.after,
				actorUserId: event.actorUserId,
				undoable: event.undoable,
				external: event.external
			})
			.from(event)
			.where(
				and(
					eq(event.sessionId, sessionId),
					sql`not exists (select 1 from event u where u.undo_of = ${event.id})`,
					isNotNull(event.targetId)
				)
			)
			.orderBy(desc(event.id));
		const undone: number[] = [];
		const skipped: { id: number; reason: string }[] = [];
		for (const e of mine) {
			const { role } = await requireCap(tx, ctx, 'write', e.projectId);
			if (e.actorUserId !== ctx.actor.userId && role !== 'owner' && role !== 'admin')
				throw new OpError('FORBIDDEN', 'You can undo only your own session.');
			if (!e.undoable || e.external) {
				skipped.push({ id: e.id, reason: e.external ? 'external' : 'final' });
				continue;
			}
			// An item this person cannot see, or a visibility change that is not theirs, is skipped like one that does not exist
			const refused = await undoGate(tx, ctx, e);
			if (refused && !refused.ok) {
				skipped.push({ id: e.id, reason: refused.reason });
				continue;
			}
			// A step an agent would close again while the plan's mockup is unread stays as it is
			if (await undoMockupHold(tx, ctx, e)) {
				skipped.push({ id: e.id, reason: 'mockup-unread' });
				continue;
			}
			const r = await undoEvent(
				tx,
				{
					actorUserId: ctx.actor.userId,
					actorLabel: ctx.actor.label ?? null,
					tool: ctx.actor.tool ?? null,
					sessionId: ctx.actor.sessionId ?? null
				},
				e.id
			);
			if (r.ok) undone.push(e.id);
			else {
				skipped.push({ id: e.id, reason: r.reason });
				// Later undos would build on a change that is still in place, so stop here and say so
				if (r.reason === 'conflict') break;
			}
		}
		return { undone, skipped };
	});
}

/** Everything in the trash of a project, with how long each piece stays. */
export async function listTrash(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		const { role } = await requireCap(tx, ctx, 'delete', proj.id);
		const seeAll = role === 'owner' || role === 'admin';
		const items = (
			await tx
				.select()
				.from(item)
				.where(and(eq(item.projectId, proj.id), isNotNull(item.deletedAt)))
				.orderBy(desc(item.deletedAt))
		).filter((i) => canSeeItem(role, i, ctx.actor.userId));
		const tasks = await tx
			.select()
			.from(task)
			.where(and(eq(task.projectId, proj.id), isNotNull(task.deletedAt)))
			.orderBy(desc(task.deletedAt));
		const files = await tx
			.select()
			.from(attachment)
			.where(and(eq(attachment.projectId, proj.id), isNotNull(attachment.deletedAt)));
		// A file of an item this person cannot see is hidden with it, whatever the file's own flag says
		const fileItemIds = [...new Set(files.map((a) => a.itemId).filter((v): v is string => !!v))];
		const fileItems = fileItemIds.length
			? await tx.select().from(item).where(inArray(item.id, fileItemIds))
			: [];
		const hiddenItems = new Set(
			fileItems.filter((i) => !canSeeItem(role, i, ctx.actor.userId)).map((i) => i.id)
		);
		// A private file in the trash is for members, admins and owners, as it is on the item
		const visibleFiles = files.filter(
			(a) =>
				!(a.itemId && hiddenItems.has(a.itemId)) &&
				(a.visibility === 'public' || seeAll || role === 'member')
		);
		const daysLeft = (d: Date | null) =>
			Math.max(0, TRASH_DAYS - Math.floor((Date.now() - (d?.getTime() ?? 0)) / 86_400_000));
		// Mockups in the trash, shown only to the people who may see them while they were live
		const trashedMockups = await tx
			.select()
			.from(mockup)
			.where(and(eq(mockup.projectId, proj.id), isNotNull(mockup.trashedAt)))
			.orderBy(desc(mockup.trashedAt));
		const mockupPlanIds = [
			...new Set(trashedMockups.map((m) => m.itemId).filter((v): v is string => !!v))
		];
		const mockupPlans: (typeof item.$inferSelect)[] = mockupPlanIds.length
			? await tx.select().from(item).where(inArray(item.id, mockupPlanIds))
			: [];
		const planOfMockup = new Map(mockupPlans.map((p) => [p.id, p]));
		// Notes and folders in the trash, for the people notes are shared with; a private note only for its creator
		const noteReader = !!(await noteRoleOf(tx, ctx, proj.id));
		const trashedNotes = noteReader
			? await tx
					.select({
						id: note.id,
						number: note.number,
						title: note.title,
						deletedAt: note.deletedAt
					})
					.from(note)
					.where(
						and(eq(note.projectId, proj.id), visibleNoteSql(ctx.actor.userId, { trash: 'only' }))
					)
					.orderBy(desc(note.deletedAt))
			: [];
		const trashedFolders = noteReader
			? await tx
					.select({ id: noteFolder.id, name: noteFolder.name, deletedAt: noteFolder.deletedAt })
					.from(noteFolder)
					.where(and(eq(noteFolder.projectId, proj.id), isNotNull(noteFolder.deletedAt)))
					.orderBy(desc(noteFolder.deletedAt))
			: [];
		return {
			notes: trashedNotes.map((n) => ({
				id: n.id,
				ref: `N-${n.number}`,
				title: n.title,
				deletedAt: n.deletedAt,
				daysLeft: daysLeft(n.deletedAt)
			})),
			noteFolders: trashedFolders.map((f) => ({
				id: f.id,
				name: f.name,
				deletedAt: f.deletedAt,
				daysLeft: daysLeft(f.deletedAt)
			})),
			items: items.map((i) => ({
				id: i.id,
				ref: i.ref,
				title: i.title,
				deletedAt: i.deletedAt,
				deletedBy: i.deletedBy,
				daysLeft: daysLeft(i.deletedAt)
			})),
			tasks: tasks.map((t) => ({
				id: t.id,
				number: t.number,
				title: t.title,
				deletedAt: t.deletedAt,
				daysLeft: daysLeft(t.deletedAt)
			})),
			mockups: trashedMockups
				.filter((m) =>
					canSeeMockup(m, ctx.actor.userId, m.itemId ? (planOfMockup.get(m.itemId) ?? null) : null)
				)
				.map((m) => ({
					id: m.id,
					title: m.title,
					trashedAt: m.trashedAt,
					daysLeft: daysLeft(m.trashedAt)
				})),
			attachments: visibleFiles.map((a) => ({
				id: a.id,
				filename: a.filename,
				deletedAt: a.deletedAt,
				daysLeft: daysLeft(a.deletedAt)
			}))
		};
	});
}

/** Removes trashed things older than 30 days for good, and their files. An admin may run it by hand. */
export async function purgeTrash(ctx: Ctx, days = TRASH_DAYS) {
	return purgeTrashRows(ctx, days, true);
}

/**
 * The daily clean up of an org's trash, run by whoever opens the org first each day (no background process is needed, so it
 * works the same on any number of processes). One caller claims the day with a guarded update, so two at once purge once.
 */
// An org checked in the last hour is skipped without asking the database. Opening any page used to cost a transaction (four round
// trips) just to learn that the day was already claimed, which is slow when the database is far away
const checkedAt = new Map<string, number>();
const CHECK_EVERY_MS = 60 * 60 * 1000;

export async function purgeTrashIfDue(ctx: Ctx) {
	const last = checkedAt.get(ctx.orgId);
	if (last !== undefined && Date.now() - last < CHECK_EVERY_MS) return null;
	checkedAt.set(ctx.orgId, Date.now());
	const claimed = await run(ctx, async (tx) => {
		const res = await tx.execute(sql`
			update "org"
			   set "settings" = jsonb_set(coalesce("settings", '{}'::jsonb), '{trashPurgedAt}', to_jsonb(now()::text))
			 where "id" = ${ctx.orgId}
			   and ("settings"->>'trashPurgedAt' is null
			        or ("settings"->>'trashPurgedAt')::timestamptz < now() - interval '20 hours')
			returning "id"`);
		return (res as unknown as { rows: unknown[] }).rows.length > 0;
	});
	if (!claimed) return null;
	return purgeTrashRows(ctx, TRASH_DAYS, false);
}

async function purgeTrashRows(ctx: Ctx, days: number, checkRole: boolean) {
	const cutoff = new Date(Date.now() - days * 86_400_000);
	const removed = await run(ctx, async (tx) => {
		if (checkRole) await requireCap(tx, ctx, 'manage');
		const files = await tx
			.select({ id: attachment.id, key: attachment.storageKey })
			.from(attachment)
			.where(and(isNotNull(attachment.deletedAt), lt(attachment.deletedAt, cutoff)));
		const itemFiles = await tx
			.select({ id: attachment.id, key: attachment.storageKey })
			.from(attachment)
			.innerJoin(item, eq(item.id, attachment.itemId))
			.where(and(isNotNull(item.deletedAt), lt(item.deletedAt, cutoff)));
		const keys = [...files, ...itemFiles];
		// A purged plan's mockups go to the mockup trash first (AFB-20261110-2338): the plan link is dropped with the row, and
		// without this they would come back as standalone mockups. Their files stay until the mockup itself is purged
		await tx
			.update(mockup)
			.set({ trashedAt: sql`now()`, updatedAt: sql`now()`, version: sql`${mockup.version} + 1` })
			.where(
				and(
					isNull(mockup.trashedAt),
					sql`${mockup.itemId} in (select ${item.id} from ${item} where ${item.deletedAt} is not null and ${item.deletedAt} < ${cutoff})`
				)
			);
		const delItems = await tx
			.delete(item)
			.where(and(isNotNull(item.deletedAt), lt(item.deletedAt, cutoff)))
			.returning({ id: item.id });
		const delTasks = await tx
			.delete(task)
			.where(and(isNotNull(task.deletedAt), lt(task.deletedAt, cutoff)))
			.returning({ id: task.id });
		const ids = files.map((f) => f.id);
		if (ids.length) await tx.delete(attachment).where(inArray(attachment.id, ids));
		// A mockup in the trash for 30 days goes with its versions and pins (cascade) and every file they own
		const oldMockups = await tx
			.select({ id: mockup.id })
			.from(mockup)
			.where(and(isNotNull(mockup.trashedAt), lt(mockup.trashedAt, cutoff)));
		const mockupKeys: string[] = [];
		if (oldMockups.length) {
			const mids = oldMockups.map((m) => m.id);
			const versions = await tx
				.select({ key: mockupVersion.storageKey, shot: mockupVersion.screenshotKey })
				.from(mockupVersion)
				.where(inArray(mockupVersion.mockupId, mids));
			for (const v of versions) mockupKeys.push(v.key, ...(v.shot ? [v.shot] : []));
			await tx.delete(mockup).where(inArray(mockup.id, mids));
		}
		// NOTES (AFB-20261111-0035). A folder in the trash for 30 days goes with every folder and note under it. Those notes
		// were never trashed themselves, so they are deleted here, first, and their picture keys are collected before the rows go:
		// a cascade alone would leave the stored files behind. UNION on the id alone ends even if the table held a loop.
		// The tree lock of every project with an old trashed folder is taken first, in a fixed order, so a move or a restore
		// at the same moment cannot change the tree between finding the doomed folders and deleting them
		const lockedProjects = (
			(await tx.execute(sql`
				select distinct project_id from note_folder
				where deleted_at is not null and deleted_at < ${cutoff} order by project_id`)) as unknown as {
				rows: { project_id: string }[];
			}
		).rows;
		for (const p of lockedProjects) await lockTree(tx, p.project_id);
		const doomed = (
			(await tx.execute(sql`
				with recursive down(id) as (
					select id from note_folder where deleted_at is not null and deleted_at < ${cutoff}
					union
					select f.id from note_folder f join down d on f.parent_id = d.id
				) select id from down`)) as unknown as { rows: { id: string }[] }
		).rows.map((r) => r.id);
		const oldNotes = await tx
			.select({ id: note.id })
			.from(note)
			.where(
				doomed.length
					? sql`((${note.deletedAt} is not null and ${note.deletedAt} < ${cutoff}) or ${inArray(note.folderId, doomed)})`
					: and(isNotNull(note.deletedAt), lt(note.deletedAt, cutoff))
			);
		const noteKeys: string[] = [];
		if (oldNotes.length) {
			const nids = oldNotes.map((n) => n.id);
			const pictures = await tx
				.select({ key: noteFile.storageKey })
				.from(noteFile)
				.where(inArray(noteFile.noteId, nids));
			noteKeys.push(...pictures.map((p) => p.key));
			// Versions, links, pictures, favourites and live updates go with the note (cascade)
			await tx.delete(note).where(inArray(note.id, nids));
		}
		if (doomed.length) await tx.delete(noteFolder).where(inArray(noteFolder.id, doomed));
		// A link that pointed at something this run (or an earlier one) removed for good is removed with it
		if (delItems.length || delTasks.length || oldMockups.length || oldNotes.length)
			await tx.execute(sql`
				delete from note_link l where
					(l.target_kind = 'item' and not exists (select 1 from item x where x.id = l.target_id))
					or (l.target_kind = 'task' and not exists (select 1 from task x where x.id = l.target_id))
					or (l.target_kind = 'mockup' and not exists (select 1 from mockup x where x.id = l.target_id))
					or (l.target_kind = 'note' and not exists (select 1 from note x where x.id = l.target_id))`);
		return {
			items: delItems.length,
			tasks: delTasks.length,
			notes: oldNotes.length,
			keys: [...keys.map((k) => k.key), ...mockupKeys, ...noteKeys]
		};
	});
	// Files go after the rows, so a failure leaves a stray file and never a row pointing at nothing
	for (const key of removed.keys) await ctx.services?.storage?.delete(key).catch(() => undefined);
	return {
		items: removed.items,
		tasks: removed.tasks,
		files: removed.keys.length
	};
}
