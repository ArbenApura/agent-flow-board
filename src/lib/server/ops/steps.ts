// RECORDING PROGRESS: MARKING STEPS AND MANUAL CHECKS, WITH THE AUTOMATIC STATUS MOVES AND THE NEXT PHASE (SPEC 9.1, 9.2)

// -- TYPES -- //
import type { Ctx } from './context';
import type { Status, StatusChange } from './status';
// -- DEP-MODULES -- //
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { recalcItem } from '../db/calc';
import { appendEvents, type NewEvent } from '../db/events';
import { item, manualCheck, phase, step } from '../db/schema';
import { OpError, idempotent, maybeDry, rateLimit, requireCap } from './context';
import { actorFields, checkVersion } from './items';
import { gatedState, mockupUnreadError, unreadForGate, unreadLine } from './mockupReads';
import { findItem } from './resolve';
import { applyStatus, automaticMoves } from './status';
import { afterRecord, validateEvidence } from './tracking';

// -- TYPES -- //

export type Mark = z.infer<typeof markIn>;

/** How a caller wants the step verb to behave beyond its input. */
export type RecordOptions = {
	/**
	 * Set by the agent entry points (the MCP step tools, the lite close and the older flow_record). The last open step of a
	 * phase is then refused with MOCKUP_UNREAD while a mockup of the plan is not read to the end. A person's tick through
	 * the API and the runner's tick after a passing check leave it unset.
	 */
	agentGate?: boolean;
};

// -- CONSTANTS -- //

// The activity log keeps 500 characters. A longer line is accepted up to LOG_MAX_INPUT and cut with a notice in the reply, so a long
// line costs no retry (it was refused before).
export const LOG_MAX = 500;
const LOG_MAX_INPUT = 5000;

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
	log: z.string().min(3).max(LOG_MAX_INPUT).optional(),
	expectVersion: z.number().int().optional(),
	dryRun: z.boolean().optional()
});

// -- FUNCTIONS -- //

/**
 * Marks steps and manual checks, recalculates the item, and applies the automatic status moves, all in one
 * transaction with the item row locked. A replayed requestId returns the stored result. `dryRun` shows the result and
 * writes nothing.
 */
export async function recordSteps(
	ctx: Ctx,
	raw: z.input<typeof recordInput>,
	options: RecordOptions = {}
) {
	const input = recordInput.parse(raw);
	// Cut by code points, so a multibyte character is never split
	const logChars = input.log ? [...input.log] : [];
	const logCut = logChars.length > LOG_MAX;
	const logText = logCut ? logChars.slice(0, LOG_MAX).join('') : (input.log ?? '');
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
			const writes = new Map<
				string,
				{
					isCheck: boolean;
					mark: Mark['mark'];
					reason: string | null;
					evidence: Mark['evidence'] | null;
					ids: string[];
				}
			>();
			const events: NewEvent[] = [];
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
				// Rows with the same new state, reason and evidence are written by one update after the loop
				const groupKey = JSON.stringify([isCheck, m.mark, reason, m.evidence ?? null]);
				const group = writes.get(groupKey) ?? {
					isCheck,
					mark: m.mark,
					reason,
					evidence: m.evidence ?? null,
					ids: []
				};
				if (!group.ids.includes(row.id)) group.ids.push(row.id);
				writes.set(groupKey, group);
				events.push({
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
			// One update per group of identical changes, then one insert for all the events and one change notice
			for (const g of writes.values()) {
				const table = g.isCheck ? manualCheck : step;
				await tx
					.update(table)
					.set({
						state: g.mark,
						reason: g.reason,
						...(g.isCheck
							? {}
							: {
									evidence: g.evidence,
									doneAt: g.mark === 'done' ? sql`now()` : null,
									doneBy: g.mark === 'done' ? ctx.actor.userId : null
								}),
						updatedAt: sql`now()`,
						version: sql`${table.version} + 1`
					} as never)
					.where(inArray(table.id, g.ids));
			}
			if (input.log) {
				events.push({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'item.log',
					targetType: 'item',
					targetId: it.id,
					after: { text: logText } as never,
					undoable: false
				});
			}
			await appendEvents(tx, events);
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
			// THE MOCKUP GATE (AFB-20261110-2331): an agent may not close a phase while the plan's mockup is unread. A person's
			// tick and the runner's own tick never pass agentGate, so they are never held. Reopening a step closes nothing
			let mockupNotice: string | null = null;
			if (options.agentGate) {
				// The cheap state is enough for the notice. The stored file is looked for only when a phase is about to close,
				// so an ordinary step never pays for reading a file
				const state = (await gatedState(tx, ctx, it)).filter((s) => !s.readComplete);
				if (state.length) {
					const closing = finishedPhases.length > 0;
					const { unread } = closing ? await unreadForGate(tx, ctx, it) : { unread: state };
					if (unread.length) {
						if (closing && !input.dryRun) throw mockupUnreadError(unread);
						mockupNotice = unreadLine(unread);
					}
				}
			}
			const claim = await afterRecord(tx, ctx, it, {
				finishedPhases,
				nextPhase,
				// A progress log line is a record too: the Stop hook accepts "one log line saying what changed", so the unrecorded edit count and its badge clear the same way
				changedAny: changed.length > 0 || Boolean(input.log)
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
				...(mockupNotice ? { mockupNotice } : {}),
				...(logCut
					? {
							logNotice: `The log line was cut to ${LOG_MAX} characters (it had ${logChars.length}).`
						}
					: {}),
				version: fresh.version
			};
		})
	);
}
