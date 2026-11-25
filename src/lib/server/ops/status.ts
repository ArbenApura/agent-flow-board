// STATUS: MANUAL CHANGES, THE AUTOMATIC MOVES OF SPEC 9.1, AND THE COMPLETED RULES (ADR-027, ADR-028)

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { computeHealthForItem, countsFor } from '../db/calc';
import { appendEvent } from '../db/events';
import { event, item, step, task } from '../db/schema';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields, checkVersion, type ItemRow } from './items';
import { closeBlock, markPlanFinished } from './qa';
import { findItem, visibleItemSql } from './resolve';
import { screensMissing } from './screens';
import { releaseClaimsOn, requireCloseConfirmation } from './tracking';

// -- TYPES -- //

export type Status = 'PLANNED' | 'IN PROGRESS' | 'IN REVIEW' | 'ON HOLD' | 'COMPLETED' | 'REMOVED';
export type StatusChange = { from: Status; to: Status; note: string };
/** A child plan that followed its master, and one that stayed where it was with the reason. */
export type FollowedChild = { ref: string; from: Status; to: Status };
export type SkippedChild = { ref: string; reason: 'screens-missing' | 'qa-broken' };
export type CascadeResult = { followed: FollowedChild[]; skipped: SkippedChild[] };

// -- CONSTANTS -- //

export const STATUS_LIST: Status[] = [
	'PLANNED',
	'IN PROGRESS',
	'IN REVIEW',
	'ON HOLD',
	'COMPLETED',
	'REMOVED'
];
const CLOSING: Status[] = ['COMPLETED', 'REMOVED'];

// -- FUNCTIONS -- //

/** The one place that decides which automatic status moves a changed step can cause (SPEC 9.1). */
export function automaticMoves(input: {
	status: Status;
	total: number;
	done: number;
	changedCounted: boolean;
	anyDone: boolean;
}): Status[] {
	if (!input.changedCounted) return [];
	const moves: Status[] = [];
	let status = input.status;
	// The first done step moves PLANNED to IN PROGRESS
	if (status === 'PLANNED' && input.anyDone) {
		moves.push('IN PROGRESS');
		status = 'IN PROGRESS';
	}
	// Counted steps at 100% move IN PROGRESS to IN REVIEW. An item with no counted steps is never at 100%.
	if (status === 'IN PROGRESS' && input.total > 0 && input.done === input.total) {
		moves.push('IN REVIEW');
	}
	return moves;
}

/** Linked tasks follow an item's progress, but a task is never set DONE by the board. */
export async function syncLinkedTasks(tx: Tx, itemId: string, status: Status) {
	const to =
		status === 'PLANNED'
			? 'TODO'
			: status === 'IN PROGRESS' || status === 'IN REVIEW'
				? 'IN PROGRESS'
				: null;
	if (!to) return;
	const from = to === 'TODO' ? 'IN PROGRESS' : 'TODO';
	await tx
		.update(task)
		.set({ status: to, updatedAt: sql`now()`, version: sql`${task.version} + 1` })
		.where(
			and(
				sql`${itemId}::uuid = any(${task.linkedItemIds})`,
				eq(task.status, from),
				sql`${task.deletedAt} is null`
			)
		);
}

/** Writes one status change as an event and syncs tasks. Returns the change for the reply. */
export async function applyStatus(
	tx: Tx,
	ctx: Ctx,
	it: Pick<ItemRow, 'id' | 'projectId' | 'status'> & { ref?: string },
	to: Status,
	note: string
): Promise<StatusChange> {
	const [row] = await tx
		.update(item)
		.set({
			status: to,
			updatedAt: sql`now()`,
			lastActivityAt: sql`now()`,
			version: sql`${item.version} + 1`
		})
		.where(eq(item.id, it.id))
		.returning({ health: item.health, legacyPercent: item.legacyPercent });
	// The drift warnings depend on the status, so they are worked out again for the new one (L18: frozen items have none)
	const health = await computeHealthForItem(tx, it.id, to, row.legacyPercent, row.health.flags);
	await tx.update(item).set({ health }).where(eq(item.id, it.id));
	await appendEvent(tx, {
		orgId: ctx.orgId,
		projectId: it.projectId,
		itemId: it.id,
		...actorFields(ctx),
		verb: 'item.status',
		targetType: 'item',
		targetId: it.id,
		before: { status: it.status },
		after: { status: to, note } as never,
		undoable: false
	});
	await syncLinkedTasks(tx, it.id, to);
	// The first move to IN REVIEW marks the QA features the plan touched as finished, so an older result means Needs retest
	if (to === 'IN REVIEW') await markPlanFinished(tx, it.id);
	// A closed item lets go of every claim on it in this same transaction (SPEC 9.2)
	if (CLOSING.includes(to)) {
		const ref =
			it.ref ?? (await tx.select({ ref: item.ref }).from(item).where(eq(item.id, it.id)))[0].ref;
		await releaseClaimsOn(
			tx,
			ctx,
			{ id: it.id, projectId: it.projectId, ref },
			to as 'COMPLETED' | 'REMOVED'
		);
	}
	return { from: it.status as Status, to, note };
}

/** The status a held child had before its master put it on hold, read from its last status event. Null when it was held on its own. */
async function statusBeforeFollowedHold(
	tx: Tx,
	childId: string,
	masterRef: string
): Promise<Status | null> {
	const [ev] = await tx
		.select({ before: event.before, after: event.after })
		.from(event)
		.where(and(eq(event.itemId, childId), eq(event.verb, 'item.status')))
		.orderBy(desc(event.id))
		.limit(1);
	const after = ev?.after as { status?: unknown; note?: unknown } | null | undefined;
	const before = ev?.before as { status?: unknown } | null | undefined;
	if (!after || after.status !== 'ON HOLD') return null;
	// Only a hold this very master caused counts, so a note written by hand for another plan never resumes a child
	if (after.note !== `Followed master ${masterRef}`) return null;
	const prev = before?.status;
	return STATUS_LIST.includes(prev as Status) &&
		prev !== 'ON HOLD' &&
		!CLOSING.includes(prev as Status)
		? (prev as Status)
		: null;
}

/**
 * A master plan's manual status change carries to its suitable child plans in the same transaction (AFB-20261125-0906).
 * The children are locked in id order and read under the lock. A person's cascade skips the per-plan refusals; an agent's runs
 * the Screens and QA checks per child, skips the ones that fail and must confirm a COMPLETED cascade, because closing a child
 * releases the claims on it. A child's own change never moves its master, and a master's automatic moves do not cascade.
 */
export async function followMaster(
	tx: Tx,
	ctx: Ctx,
	master: { id: string; ref: string; projectId: string; parentId: string | null },
	to: Status,
	confirmed: boolean | undefined,
	ownerPerson: boolean
): Promise<CascadeResult> {
	const result: CascadeResult = { followed: [], skipped: [] };
	// Plans nest one level only, so a child plan has no children of its own
	if (master.parentId) return result;
	if (to === 'REMOVED') return result;
	const kids = await tx
		.select({
			id: item.id,
			ref: item.ref,
			title: item.title,
			status: item.status,
			projectId: item.projectId
		})
		.from(item)
		// A child the caller cannot see behaves as if it did not exist: it is never moved, named or counted
		.where(
			and(eq(item.parentId, master.id), isNull(item.deletedAt), visibleItemSql(ctx.actor.userId))
		)
		.orderBy(item.id)
		.for('update');
	const movers: { kid: (typeof kids)[number]; target: Status }[] = [];
	for (const kid of kids) {
		const from = kid.status as Status;
		if (from === to || from === 'COMPLETED' || from === 'REMOVED') continue;
		let target: Status | null = null;
		if (to === 'COMPLETED') target = 'COMPLETED';
		else if (to === 'ON HOLD') target = from === 'ON HOLD' ? null : 'ON HOLD';
		else if (to === 'IN REVIEW') {
			// Only a plan whose counted steps are all done is ready for review, so no drift warning is written
			const c = await countsFor(tx, kid.id);
			if (from === 'IN PROGRESS' && c.total > 0 && c.done === c.total) target = 'IN REVIEW';
		} else if (from === 'ON HOLD') {
			// IN PROGRESS or PLANNED: only a child this master held comes back, to the status it had
			target = await statusBeforeFollowedHold(tx, kid.id, master.ref);
		}
		if (!target) continue;
		if (target === 'COMPLETED') {
			// The Screens rule is for agents. A broken QA feature still blocks everyone but the owner at the board, who may close anyway
			if (ctx.actor.kind !== 'person' && (await screensMissing(tx, kid.id))) {
				result.skipped.push({ ref: kid.ref, reason: 'screens-missing' });
				continue;
			}
			if (!ownerPerson && (await closeBlock(tx, ctx, kid.id, kid.projectId))) {
				result.skipped.push({ ref: kid.ref, reason: 'qa-broken' });
				continue;
			}
		}
		movers.push({ kid, target });
	}
	// An agent confirms the children it closes, since their claims are released (ADR-029)
	if (ctx.actor.kind === 'agent' && !confirmed && movers.some((m) => m.target === 'COMPLETED'))
		throw new OpError(
			'CONFIRM_REQUIRED',
			`Setting ${master.ref} to COMPLETED also closes ${movers.length} child ${movers.length === 1 ? 'plan' : 'plans'}: ${movers.map((m) => `${m.kid.ref} (${m.kid.title})`).join(', ')}. Show this to the user and repeat the call with confirmed true only after they agree.`,
			{ alsoClosing: movers.map((m) => ({ ref: m.kid.ref, title: m.kid.title })) }
		);
	for (const { kid, target } of movers) {
		const change = await applyStatus(
			tx,
			ctx,
			{ id: kid.id, projectId: kid.projectId, status: kid.status, ref: kid.ref },
			target,
			`Followed master ${master.ref}`
		);
		result.followed.push({ ref: kid.ref, from: change.from, to: change.to });
	}
	return result;
}

export const setStatusInput = z.object({
	item: z.string().min(1),
	status: z.enum(STATUS_LIST as [Status, ...Status[]]),
	note: z.string().min(3).max(160),
	expectVersion: z.number().int().optional(),
	/** Closing an item the session is not bound to asks first (Phase 9). */
	confirmed: z.boolean().optional(),
	/** The owner's reason for closing while a QA feature the plan touched is broken (AFB-20261125-0442). A person only. */
	override: z.object({ reason: z.string().trim().min(3).max(160) }).optional()
});

/**
 * A manual status change. COMPLETED needs every counted step closed and the "complete" capability, and an agent closing an
 * item its session is not bound to is asked to confirm first (ADR-029). The automatic moves never reach COMPLETED or REMOVED.
 */
export async function setStatus(ctx: Ctx, raw: z.input<typeof setStatusInput>) {
	const input = setStatusInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			const { role } = await requireCap(
				tx,
				ctx,
				CLOSING.includes(input.status) ? 'complete' : 'write',
				it.projectId
			);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			// Closing anyway is the owner's word at the web app, never an agent's: an agent that sends it is refused, not ignored
			if (input.override && (ctx.actor.kind !== 'person' || role !== 'owner'))
				throw new OpError(
					'FORBIDDEN',
					'Only the owner, at the board, can close a plan while a feature it touched is broken.'
				);
			// The same status again still catches up the children of a master (one that was hidden, added or restored since)
			if (it.status === input.status) {
				const cascade = await followMaster(
					tx,
					ctx,
					it,
					input.status,
					input.confirmed,
					ctx.actor.kind === 'person' && role === 'owner'
				);
				return { item: it, statusChanges: [] as StatusChange[], already: true, ...cascade };
			}
			if (input.status === 'COMPLETED') {
				const [open] = await tx
					.select({ n: sql<number>`count(*) filter (where ${step.state} = 'open')::int` })
					.from(step)
					.where(eq(step.itemId, it.id));
				if (open.n > 0)
					throw new OpError(
						'COMPLETED_REFUSED',
						`${open.n} counted ${open.n === 1 ? 'step is' : 'steps are'} still open. Close or waive ${open.n === 1 ? 'it' : 'them'} first.`,
						{ reason: 'open-steps', openSteps: open.n }
					);
				// A plan that changes what a person sees cannot be closed by an agent with an empty Screens tab unless a
				// screens-waiver names why (the owner's rule, 2026-11-25, AFB-20261125-0625). A person closing by hand is never
				// refused for it (AFB-20261125-0906). The agent adds the waiver section; it is never an override
				if (ctx.actor.kind !== 'person' && (await screensMissing(tx, it.id)))
					throw new OpError(
						'COMPLETED_REFUSED',
						"This plan changes what a person sees but its Screens tab is empty. Capture the finished screens first, or record a screens waiver that names why they can't be captured.",
						{ reason: 'screens-missing' }
					);
				// A plan cannot close while a feature it touched broke since it started (the owner's rule, 2026-11-25)
				const block = await closeBlock(tx, ctx, it.id, it.projectId);
				if (block && !input.override) {
					const names = block.features.map((f) => f.name);
					const what =
						names.length > 0
							? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} broken`
							: 'a feature it touched is broken';
					const more =
						block.hidden > 0 && names.length > 0 ? `, and ${block.hidden} more you can't see` : '';
					throw new OpError(
						'COMPLETED_REFUSED',
						`This plan can't close: ${what}${more}. Fix it and rerun QA first.`,
						{ reason: 'qa-broken', ...block }
					);
				}
				if (block && input.override)
					await appendEvent(tx, {
						orgId: ctx.orgId,
						projectId: it.projectId,
						itemId: it.id,
						...actorFields(ctx),
						verb: 'qa.close.override',
						targetType: 'item',
						targetId: it.id,
						after: {
							reason: input.override.reason,
							features: block.features.map((f) => f.key),
							hidden: block.hidden
						} as never,
						undoable: false
					});
			}
			// An agent closing an item its session is not bound to is asked first, never refused (ADR-029). The refusals above come
			// first, so nobody is asked to confirm something that would be refused anyway.
			if (CLOSING.includes(input.status))
				await requireCloseConfirmation(tx, ctx, it, input.confirmed);
			const change = await applyStatus(tx, ctx, it, input.status, input.note);
			// The master's children follow in this same transaction; an agent's confirmation comes before any child closes
			const cascade = await followMaster(
				tx,
				ctx,
				it,
				input.status,
				input.confirmed,
				ctx.actor.kind === 'person' && role === 'owner'
			);
			const [updated] = await tx.select().from(item).where(eq(item.id, it.id));
			return { item: updated, statusChanges: [change], already: false, ...cascade };
		})
	);
}
