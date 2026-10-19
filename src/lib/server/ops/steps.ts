// RECORDING PROGRESS: MARKING STEPS AND MANUAL CHECKS, WITH THE AUTOMATIC STATUS MOVES AND THE NEXT PHASE (SPEC 9.1, 9.2)

// -- TYPES -- //
import type { Ctx } from './context';
import type { Status, StatusChange } from './status';
// -- DEP-MODULES -- //
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { recalcItem } from '../db/calc';
import { appendEvent } from '../db/events';
import { item, manualCheck, phase, step } from '../db/schema';
import { OpError, idempotent, maybeDry, rateLimit, requireCap } from './context';
import { actorFields, checkVersion } from './items';
import { findItem } from './resolve';
import { applyStatus, automaticMoves } from './status';
import { afterRecord, validateEvidence } from './tracking';

// -- TYPES -- //

export type Mark = z.infer<typeof markIn>;

// -- CONSTANTS -- //

const markIn = z.object({
	/** A step key such as 3.2, or a manual check key such as M2. */
	key: z.string().regex(/^(?:[0-9A-Za-z]+\.[0-9]+[a-z]?|M[0-9]+)$/),
	mark: z.enum(['done', 'open', 'waived', 'superseded']),
	reason: z.string().min(3).max(200).optional(),
	supersededBy: z.string().min(2).max(80).optional(),
	evidence: z
		.object({
			commit: z.string().max(80).optional(),
			checkRunId: z.string().max(80).optional(),
			target: z.enum(['dev', 'preview', 'deployed']).optional(),
			note: z.string().max(500).optional()
		})
		.optional()
});

export const recordInput = z.object({
	item: z.string().min(1),
	marks: z.array(markIn).max(60).default([]),
	/** One short line for the activity log. A call with only a log line changes no counted step and moves no status. */
	log: z.string().min(3).max(500).optional(),
	expectVersion: z.number().int().optional(),
	dryRun: z.boolean().optional()
});

// -- FUNCTIONS -- //

/**
 * Marks steps and manual checks, recalculates the item, and applies the automatic status moves, all in one
 * transaction with the item row locked. A replayed requestId returns the stored result. `dryRun` shows the result and
 * writes nothing.
 */
export async function recordSteps(ctx: Ctx, raw: z.input<typeof recordInput>) {
	const input = recordInput.parse(raw);
	return maybeDry(input.dryRun, ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			const stepKeys = input.marks.filter((m) => !/^M[0-9]+$/.test(m.key)).map((m) => m.key);
			const checkKeys = input.marks.filter((m) => /^M[0-9]+$/.test(m.key)).map((m) => m.key);
			const steps = stepKeys.length
				? await tx
						.select()
						.from(step)
						.where(and(eq(step.itemId, it.id), inArray(step.key, stepKeys)))
				: [];
			const checks = checkKeys.length
				? await tx
						.select()
						.from(manualCheck)
						.where(and(eq(manualCheck.itemId, it.id), inArray(manualCheck.key, checkKeys)))
				: [];
			const changed: { key: string; from: string; to: string }[] = [];
			const already: string[] = [];
			let changedCounted = false;
			let anyDone = false;
			for (const m of input.marks) {
				if (m.mark === 'waived' && !m.reason)
					throw new OpError('INVALID', `A waived mark needs a reason (${m.key}).`);
				if (m.mark === 'superseded' && !m.supersededBy)
					throw new OpError(
						'INVALID',
						`A superseded mark needs the item that replaces it (${m.key}).`
					);
				const isCheck = /^M[0-9]+$/.test(m.key);
				const row = isCheck
					? checks.find((c) => c.key === m.key)
					: steps.find((s) => s.key === m.key);
				if (!row)
					throw new OpError(
						'NOT_FOUND',
						`No ${isCheck ? 'manual check' : 'step'} "${m.key}" on ${it.ref}.`
					);
				if (row.state === m.mark) {
					already.push(m.key);
					continue;
				}
				// Evidence is checked by the server before a step is marked done (SPEC 9.4)
				if (!isCheck && m.mark === 'done') {
					const stepRow = row as typeof step.$inferSelect;
					if (m.evidence || stepRow.requiredTarget)
						await validateEvidence(tx, ctx, it, stepRow, m.evidence);
				}
				const reason =
					m.mark === 'waived'
						? m.reason!
						: m.mark === 'superseded'
							? `Replaced by ${m.supersededBy}`
							: null;
				const table = isCheck ? manualCheck : step;
				await tx
					.update(table)
					.set({
						state: m.mark,
						reason,
						...(isCheck
							? {}
							: {
									evidence: m.evidence ?? null,
									doneAt: m.mark === 'done' ? sql`now()` : null,
									doneBy: m.mark === 'done' ? ctx.actor.userId : null
								}),
						updatedAt: sql`now()`,
						version: sql`${table.version} + 1`
					} as never)
					.where(eq(table.id, row.id));
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: `${isCheck ? 'manual_check' : 'step'}.update`,
					targetType: isCheck ? 'manual_check' : 'step',
					targetId: row.id,
					before: { state: row.state } as never,
					after: {
						state: m.mark,
						key: m.key,
						...(m.evidence ? { evidence: m.evidence } : {})
					} as never
				});
				changed.push({ key: m.key, from: row.state, to: m.mark });
				if (!isCheck) {
					// Only a changed COUNTED step can move a status. A waived or superseded step is not counted.
					changedCounted = true;
					if (m.mark === 'done') anyDone = true;
				}
			}
			if (input.log) {
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'item.log',
					targetType: 'item',
					targetId: it.id,
					after: { text: input.log } as never,
					undoable: false
				});
			}
			const calc =
				changed.length || input.log
					? await recalcItem(tx, it.id)
					: {
							item: it,
							counts: { total: it.totalSteps, done: it.doneSteps, openManual: it.openManual },
							percent: it.percent
						};
			// Automatic status moves, in order, only when a counted step changed (ADR-028)
			const statusChanges: StatusChange[] = [];
			let status = it.status as Status;
			for (const to of automaticMoves({
				status,
				total: calc.counts.total,
				done: calc.counts.done,
				changedCounted,
				anyDone
			})) {
				statusChanges.push(
					await applyStatus(
						tx,
						ctx,
						{ id: it.id, projectId: it.projectId, status },
						to,
						'Automatic'
					)
				);
				status = to;
			}
			if (statusChanges.length) await recalcItem(tx, it.id);
			const phases = await tx
				.select()
				.from(phase)
				.where(eq(phase.itemId, it.id))
				.orderBy(asc(phase.position));
			const open = await tx
				.select({ key: step.key, text: step.text, phaseId: step.phaseId })
				.from(step)
				.innerJoin(phase, eq(phase.id, step.phaseId))
				.where(and(eq(step.itemId, it.id), eq(step.state, 'open')))
				.orderBy(asc(phase.position), asc(step.position));
			const phaseSummary = phases.map((p) => {
				const mine = open.filter((s) => s.phaseId === p.id);
				return { key: p.key, title: p.title, open: mine.length };
			});
			// The phase the work moves to: the first one that still has an open step (null when none is left)
			const nextPhase = phaseSummary.find((p) => p.open > 0)?.key ?? null;
			const touched = new Set(
				steps.filter((s) => changed.some((c) => c.key === s.key)).map((s) => s.phaseId)
			);
			const finishedPhases = phases
				.filter((p) => touched.has(p.id) && !open.some((s) => s.phaseId === p.id))
				.map((p) => p.key);
			const claim = await afterRecord(tx, ctx, it, {
				finishedPhases,
				nextPhase,
				changedAny: changed.length > 0
			});
			const [fresh] = await tx
				.select({ version: item.version })
				.from(item)
				.where(eq(item.id, it.id));
			return {
				id: it.id,
				ref: it.ref,
				changed,
				already,
				percent: calc.percent,
				status,
				statusChanges,
				phaseComplete: finishedPhases.length > 0,
				finishedPhases,
				nextPhase,
				nextOpen: open.slice(0, 3).map((s) => ({ key: s.key, text: s.text })),
				// Nothing left to record: say what comes next, so the claim is released and not forgotten
				...(open.length === 0
					? {
							reminder:
								'All counted steps are done. Run /flow-critic and /flow-audit, then call work_stop to release the claim.'
						}
					: {}),
				...(claim ? { claim } : {}),
				version: fresh.version
			};
		})
	);
}
