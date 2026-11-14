// WAITING-FOR-A-PERSON BLOCKER STATE (STEP D.5): FIRST-CLASS SESSION BLOCKER THAT HALTS CARRY-ON STOP REMINDERS UNTIL CLEARED

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
import type { WaitingBlocker, WaitingKind } from '../db/schema/activity';
// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { item, session, WAITING_KINDS } from '../db/schema';
import { notifyChange } from '../realtime/notify';
import { OpError, requireCap, run } from './context';
import { logSessionEvent } from './sessionEvents';

// -- CONSTANTS -- //

export const waitingInput = z.object({
	sessionId: z.string().min(1).optional(),
	kind: z.enum(WAITING_KINDS),
	detail: z.string().trim().min(3).max(240),
	target: z.string().trim().min(1).max(120).optional()
});

export const clearWaitingInput = z.object({
	sessionId: z.string().min(1).optional()
});

// -- FUNCTIONS -- //

/** Plain message shown by Stop hooks and status outputs while waiting for a person (never says carry on). */
export function formatWaitingBlocker(w: WaitingBlocker, itemRef?: string | null): string {
	const prefix = itemRef ? `${itemRef} is waiting` : 'Waiting';
	const suffix = w.target ? ` (${w.target})` : '';
	return `${prefix} for a person (${w.kind}): ${w.detail}${suffix}.`;
}

/** Sets or clears `session.waiting` inside an open transaction for a verified session row, logging & notifying. */
export async function setSessionWaitingTx(
	tx: Tx,
	ctx: Ctx,
	sessionId: string,
	blocker: { kind: WaitingKind; detail: string; target?: string } | null
): Promise<{ sessionId: string; waiting: WaitingBlocker | null }> {
	const [row] = await tx
		.select()
		.from(session)
		.where(
			and(
				eq(session.id, sessionId),
				eq(session.orgId, ctx.orgId),
				eq(session.userId, ctx.actor.userId)
			)
		);
	if (!row) {
		throw new OpError('INVALID', 'Unknown session. Call session_start again.', {
			needsSession: true
		});
	}
	const next: WaitingBlocker | null = blocker
		? {
				kind: blocker.kind,
				detail: blocker.detail.trim(),
				...(blocker.target?.trim() ? { target: blocker.target.trim() } : {}),
				setAt: new Date().toISOString()
			}
		: null;
	await tx
		.update(session)
		.set({ waiting: next, lastSeenAt: sql`now()`, updatedAt: sql`now()` })
		.where(eq(session.id, row.id));
	await logSessionEvent(tx, {
		orgId: ctx.orgId,
		sessionId: row.id,
		itemId: row.claimedItemId,
		tool: row.tool,
		kind: next ? 'waiting_set' : 'waiting_clear',
		detail: next ? `${next.kind}: ${next.detail}`.slice(0, 200) : undefined
	});
	if (row.claimedItemId) {
		const [it] = await tx
			.select({ projectId: item.projectId })
			.from(item)
			.where(eq(item.id, row.claimedItemId));
		if (it)
			await notifyChange(tx, { o: ctx.orgId, p: it.projectId, k: 'claim', i: row.claimedItemId });
	}
	return { sessionId: row.id, waiting: next };
}

/** Records a first-class waiting-for-a-person blocker on the caller's active session. */
export async function setWaitingForPerson(ctx: Ctx, raw: z.input<typeof waitingInput>) {
	const input = waitingInput.parse(raw);
	const sid = input.sessionId ?? ctx.actor.sessionId;
	if (!sid) {
		throw new OpError(
			'INVALID',
			'Call session_start first and pass its sessionId to mark a waiting blocker.',
			{ needsSession: true }
		);
	}
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'write');
		return setSessionWaitingTx(tx, ctx, sid, {
			kind: input.kind,
			detail: input.detail,
			target: input.target
		});
	});
}

/** Clears the caller's waiting-for-a-person blocker so normal stop reminders and work resume. */
export async function clearWaitingForPerson(ctx: Ctx, raw: z.input<typeof clearWaitingInput> = {}) {
	const input = clearWaitingInput.parse(raw);
	const sid = input.sessionId ?? ctx.actor.sessionId;
	if (!sid) {
		throw new OpError(
			'INVALID',
			'Call session_start first and pass its sessionId to clear a waiting blocker.',
			{ needsSession: true }
		);
	}
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'write');
		return setSessionWaitingTx(tx, ctx, sid, null);
	});
}
