// STATUS: MANUAL CHANGES, THE AUTOMATIC MOVES OF SPEC 9.1, AND THE COMPLETED RULES (ADR-027, ADR-028)

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { effectiveStepVisible } from '../../shared/screenGlobs';
import { computeHealthForItem } from '../db/calc';
import { appendEvent } from '../db/events';
import { item, project, step, task } from '../db/schema';
import { OpError, idempotent, isLivePersonSession, rateLimit, requireCap, run } from './context';
import { actorFields, checkVersion, type ItemRow } from './items';
import { findItem } from './resolve';
import { releaseClaimsOn, requireCloseConfirmation } from './tracking';
import { compareCommandHint } from './visibleSteps';

// -- TYPES -- //

export type Status = 'PLANNED' | 'IN PROGRESS' | 'IN REVIEW' | 'ON HOLD' | 'COMPLETED' | 'REMOVED';
export type StatusChange = { from: Status; to: Status; note: string };

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
	// The drift warnings and visual-evidence health depend on the status, so they are worked out again for the new one (L18: frozen items have none)
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

export const setStatusInput = z.object({
	item: z.string().min(1),
	status: z.enum(STATUS_LIST as [Status, ...Status[]]),
	note: z.string().min(3).max(160),
	expectVersion: z.number().int().optional(),
	/** Closing an item the session is not bound to asks first (Phase 9). */
	confirmed: z.boolean().optional()
});

/**
 * A manual status change. COMPLETED needs every counted step closed, needs the "complete" capability, and is refused to
 * agents where the project keeps it for people (ADR-027). The automatic moves never reach COMPLETED or REMOVED.
 */
export async function setStatus(ctx: Ctx, raw: z.input<typeof setStatusInput>) {
	const input = setStatusInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(
				tx,
				ctx,
				CLOSING.includes(input.status) ? 'complete' : 'write',
				it.projectId
			);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			if (it.status === input.status)
				return { item: it, statusChanges: [] as StatusChange[], already: true };
			const [proj] = await tx
				.select({
					agentsMayComplete: project.agentsMayComplete,
					visualEvidenceGate: project.visualEvidenceGate
				})
				.from(project)
				.where(eq(project.id, it.projectId));
			if (proj?.visualEvidenceGate) {
				const openSteps = await tx
					.select({
						key: step.key,
						visible: step.visible,
						visibleInferred: step.visibleInferred,
						screens: step.screens,
						widths: step.widths
					})
					.from(step)
					.where(and(eq(step.itemId, it.id), eq(step.state, 'open')));
				const openVisible = openSteps.filter((s) => effectiveStepVisible(s));
				if (openVisible.length) {
					if (input.status === 'IN REVIEW') {
						const first = openVisible[0];
						const cmd = compareCommandHint(
							it.ref,
							first.key,
							first.screens ?? [],
							first.widths ?? []
						);
						throw new OpError(
							'VISUAL_EVIDENCE_REQUIRED',
							`${it.ref} has ${openVisible.length} open visible step(s) (first: ${first.key}) and cannot move to IN REVIEW until they have compare evidence or owner waiver. Run: ${cmd}`,
							{
								reason: 'visual-evidence',
								step: first.key,
								openVisible: openVisible.map((s) => s.key)
							}
						);
					}
					if (input.status === 'REMOVED' && !isLivePersonSession(ctx)) {
						throw new OpError(
							'FORBIDDEN',
							`${it.ref} has open visible steps. Only a person in a live web session can set it to REMOVED.`
						);
					}
				}
			}
			if (input.status === 'COMPLETED') {
				if (ctx.actor.kind === 'agent' && !proj.agentsMayComplete) {
					throw new OpError(
						'COMPLETED_REFUSED',
						'This project keeps COMPLETED for people. Ask a person to close the item from the board.',
						{ reason: 'people-only' }
					);
				}
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
			}
			// An agent closing an item its session is not bound to is asked first, never refused (ADR-029). The refusals above come
			// first, so nobody is asked to confirm something that would be refused anyway.
			if (CLOSING.includes(input.status))
				await requireCloseConfirmation(tx, ctx, it, input.confirmed);
			const change = await applyStatus(tx, ctx, it, input.status, input.note);
			const [updated] = await tx.select().from(item).where(eq(item.id, it.id));
			return { item: updated, statusChanges: [change], already: false };
		})
	);
}
