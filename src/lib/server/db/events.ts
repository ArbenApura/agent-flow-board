// THE APPEND ONLY EVENT LOG AND COMPENSATING UNDO (L14, L17)
// An undo never edits history. It writes a new event that reverses an earlier one, and says so when later events
// touched the same thing, so nothing is overwritten silently.

// -- TYPES -- //
import type { Tx } from './client';
import type { Patch } from './schema';
// -- DEP-MODULES -- //
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
// -- MODULES -- //
import { notifyChange } from '../realtime/notify';
import {
	attachment,
	decision,
	event,
	item,
	manualCheck,
	phase,
	section,
	step,
	task
} from './schema';

// -- TYPES -- //

export type NewEvent = {
	orgId: string;
	projectId: string;
	itemId?: string | null;
	actorUserId?: string | null;
	actorLabel?: string | null;
	tool?: string | null;
	tokenId?: string | null;
	sessionId?: string | null;
	verb: string;
	targetType: string;
	targetId?: string | null;
	before?: Patch;
	after?: Patch;
	undoable?: boolean;
	external?: boolean;
	requestId?: string | null;
	undoOf?: number | null;
};
export type UndoResult =
	| { ok: true; eventId: number }
	| {
			ok: false;
			reason: 'external' | 'already-undone' | 'not-found' | 'unsupported' | 'conflict';
			conflicts?: number[];
	  };

// -- CONSTANTS -- //

/** Tables an undo can restore, with whether a create is undone by trashing (deleted_at) or by removal. */
const TABLES: Record<string, { table: PgTable; soft: boolean }> = {
	item: { table: item, soft: true },
	task: { table: task, soft: true },
	attachment: { table: attachment, soft: true },
	step: { table: step, soft: false },
	phase: { table: phase, soft: false },
	manual_check: { table: manualCheck, soft: false },
	decision: { table: decision, soft: false },
	section: { table: section, soft: false }
};

// -- FUNCTIONS -- //

export async function appendEvent(tx: Tx, e: NewEvent): Promise<number> {
	const [row] = await tx
		.insert(event)
		.values({
			orgId: e.orgId,
			projectId: e.projectId,
			itemId: e.itemId ?? null,
			actorUserId: e.actorUserId ?? null,
			actorLabel: e.actorLabel ?? null,
			tool: e.tool ?? null,
			tokenId: e.tokenId ?? null,
			sessionId: e.sessionId ?? null,
			verb: e.verb,
			targetType: e.targetType,
			targetId: e.targetId ?? null,
			before: e.before ?? null,
			after: e.after ?? null,
			undoable: e.undoable ?? true,
			external: e.external ?? false,
			requestId: e.requestId ?? null,
			undoOf: e.undoOf ?? null
		})
		.returning({ id: event.id });
	await notifyChange(tx, {
		o: e.orgId,
		p: e.projectId,
		k: 'event',
		e: row.id,
		i: e.itemId ?? null,
		v: e.verb
	});
	return row.id;
}

/**
 * Events after `eventId` that touched the same target and still stand, and touched the same fields. An event does not
 * count when it was itself undone, when it is an undo of something that came after `eventId` (the two cancel out), or
 * when it changed other fields of the target (a status move does not block undoing a rename).
 */
export async function laterEventsOnTarget(
	tx: Tx,
	eventId: number,
	targetType: string,
	targetId: string,
	fields?: string[]
): Promise<number[]> {
	const rows = await tx
		.select({ id: event.id, undoOf: event.undoOf, before: event.before, after: event.after })
		.from(event)
		.where(
			and(eq(event.targetType, targetType), eq(event.targetId, targetId), gt(event.id, eventId))
		);
	if (rows.length === 0) return [];
	const undone = new Set(
		(
			await tx
				.select({ of: event.undoOf })
				.from(event)
				.where(and(isNotNull(event.undoOf), gt(event.id, eventId)))
		).map((r) => r.of)
	);
	return rows
		.filter((r) => !undone.has(r.id) && !(r.undoOf !== null && r.undoOf > eventId))
		.filter((r) => {
			// Without field information on both sides, any later change counts as a conflict
			if (!fields || fields.length === 0) return true;
			const touched = new Set([...Object.keys(r.before ?? {}), ...Object.keys(r.after ?? {})]);
			if (touched.size === 0) return true;
			return fields.some((f) => touched.has(f));
		})
		.map((r) => r.id);
}

/**
 * Reverses one event with a compensating event. Refuses events that reached outside the database, events already
 * undone, and (unless forced) events whose target changed again since.
 */
export async function undoEvent(
	tx: Tx,
	who: {
		actorUserId?: string | null;
		actorLabel?: string | null;
		tool?: string | null;
		sessionId?: string | null;
	},
	eventId: number,
	options: { force?: boolean } = {}
): Promise<UndoResult> {
	const [ev] = await tx.select().from(event).where(eq(event.id, eventId));
	if (!ev) return { ok: false, reason: 'not-found' };
	if (ev.external || !ev.undoable) return { ok: false, reason: 'external' };
	const [done] = await tx.select({ id: event.id }).from(event).where(eq(event.undoOf, eventId));
	if (done) return { ok: false, reason: 'already-undone' };
	const target = TABLES[ev.targetType];
	if (!target || !ev.targetId) return { ok: false, reason: 'unsupported' };
	if (!options.force) {
		const conflicts = await laterEventsOnTarget(
			tx,
			eventId,
			ev.targetType,
			ev.targetId,
			Object.keys(ev.before ?? ev.after ?? {}).filter((k) => k !== 'note')
		);
		if (conflicts.length) return { ok: false, reason: 'conflict', conflicts };
	}
	const cols = getTableColumns(target.table) as Record<string, { name: string }>;
	const idCol = (target.table as unknown as Record<string, unknown>).id as ReturnType<
		typeof sql.raw
	>;
	const verb = ev.verb.split('.')[1] ?? '';
	if (verb === 'update' && ev.before) {
		const set = Object.fromEntries(Object.entries(ev.before).filter(([k]) => k in cols));
		await tx
			.update(target.table)
			.set({ ...set, updatedAt: sql`now()` } as never)
			.where(eq(idCol as never, ev.targetId));
	} else if (verb === 'create') {
		if (target.soft)
			await tx
				.update(target.table)
				.set({ deletedAt: sql`now()` } as never)
				.where(eq(idCol as never, ev.targetId));
		else await tx.delete(target.table).where(eq(idCol as never, ev.targetId));
	} else if (verb === 'delete' && target.soft) {
		await tx
			.update(target.table)
			.set({ deletedAt: null } as never)
			.where(eq(idCol as never, ev.targetId));
	} else {
		return { ok: false, reason: 'unsupported' };
	}
	const id = await appendEvent(tx, {
		orgId: ev.orgId,
		projectId: ev.projectId,
		itemId: ev.itemId,
		...who,
		verb: `${ev.targetType}.undo`,
		targetType: ev.targetType,
		targetId: ev.targetId,
		before: ev.after,
		after: ev.before,
		undoable: false,
		undoOf: eventId
	});
	return { ok: true, eventId: id };
}
