// ACTIVITY, UNDO AND TRASH VERBS (SPEC 6: "SAFETY NET IN PLACE OF APPROVALS", L14, L17)

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { undoEvent, type UndoResult } from '../db/events';
import { attachment, event, item, task } from '../db/schema';
import { OpError, requireCap, run } from './context';
import { canSeeItem, findItem, findProject, mayView } from './resolve';

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

/** The activity log of a project, newest first, each event labelled with whether it can still be undone. */
export async function listEvents(ctx: Ctx, raw: z.input<typeof eventsInput>) {
	const input = eventsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		const { role } = await requireCap(tx, ctx, 'read', proj.id);
		const seeAll = role === 'owner' || role === 'admin';
		// One item's history, when asked for by name, id or old alias
		const onlyItem = input.item
			? (await findItem(tx, ctx, input.item, { includeTrashed: true })).id
			: undefined;
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
				before: event.before,
				after: event.after,
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
					seeAll
						? undefined
						: sql`(${event.itemId} is null or ${item.visibility} = 'public' or ${item.createdBy} = ${ctx.actor.userId} or ${item.assigneeId} = ${ctx.actor.userId})`
				)
			)
			.orderBy(desc(event.id))
			.limit(input.limit);
		return rows.map((r) => ({
			...r,
			undoable: r.undoable && !r.external && !r.undone,
			label: r.external ? 'external' : r.undone ? 'undone' : r.undoable ? 'undoable' : 'final'
		}));
	});
}

/** Reverses one change with a compensating event. A conflict (the thing changed again since) is reported, not forced. */
export async function undoChange(
	ctx: Ctx,
	eventId: number,
	options: { force?: boolean } = {}
): Promise<UndoResult> {
	return run(ctx, async (tx) => {
		const [ev] = await tx
			.select({ projectId: event.projectId, itemId: event.itemId })
			.from(event)
			.where(eq(event.id, eventId));
		if (!ev) return { ok: false, reason: 'not-found' } as UndoResult;
		await requireCap(tx, ctx, 'write', ev.projectId);
		// A change to an item this person cannot see is not theirs to undo, and looks the same as one that does not exist
		if (ev.itemId) {
			const [it] = await tx.select().from(item).where(eq(item.id, ev.itemId));
			if (it && !(await mayView(tx, ctx, it)))
				return { ok: false, reason: 'not-found' } as UndoResult;
		}
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
		// A private file in the trash is for members, admins and owners, as it is on the item
		const visibleFiles = files.filter(
			(a) => a.visibility === 'public' || seeAll || role === 'member'
		);
		const daysLeft = (d: Date | null) =>
			Math.max(0, TRASH_DAYS - Math.floor((Date.now() - (d?.getTime() ?? 0)) / 86_400_000));
		return {
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
 * works the same on a server and on a Worker). One caller claims the day with a guarded update, so two at once purge once.
 */
export async function purgeTrashIfDue(ctx: Ctx) {
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
		return { items: delItems.length, tasks: delTasks.length, keys: keys.map((k) => k.key) };
	});
	// Files go after the rows, so a failure leaves a stray file and never a row pointing at nothing
	for (const key of removed.keys) await ctx.services?.storage?.delete(key).catch(() => undefined);
	return { items: removed.items, tasks: removed.tasks, files: removed.keys.length };
}
