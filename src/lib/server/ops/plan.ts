// PLAN VERBS: ADD PHASES, STEPS AND MANUAL CHECKS TO AN ITEM THAT ALREADY EXISTS (A PLAN GROWS AS THE WORK IS UNDERSTOOD)

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { recalcItem } from '../db/calc';
import { appendEvent } from '../db/events';
import { comment, manualCheck, phase, step } from '../db/schema';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields, checkVersion } from './items';
import { enforcePlanRules } from './planRules';
import { findItem } from './resolve';

// -- CONSTANTS -- //

const stepIn = z.object({
	key: z
		.string()
		.regex(/^[0-9A-Za-z]+\.[0-9]+[a-z]?$/)
		.optional(),
	text: z.string().min(1).max(2000),
	requiredTarget: z.enum(['dev', 'preview', 'deployed']).nullable().optional()
});

export const addPhaseInput = z.object({
	item: z.string().min(1),
	key: z
		.string()
		.min(1)
		.max(12)
		.regex(/^[0-9A-Za-z]+$/),
	title: z.string().min(1).max(200),
	steps: z.array(stepIn).max(200).default([]),
	expectVersion: z.number().int().optional()
});
export const addStepsInput = z.object({
	item: z.string().min(1),
	phase: z.string().min(1).max(12),
	steps: z.array(stepIn).min(1).max(200),
	expectVersion: z.number().int().optional()
});
export const addChecksInput = z.object({
	item: z.string().min(1),
	checks: z
		.array(
			z.object({
				key: z.string().regex(/^M[0-9]+$/),
				text: z.string().min(1).max(2000),
				auto: z.boolean().default(false)
			})
		)
		.min(1)
		.max(100),
	expectVersion: z.number().int().optional()
});

export const updateStepBody = z.object({
	item: z.string().min(1),
	key: z.string().regex(/^[0-9A-Za-z]+\.[0-9]+[a-z]?$/),
	/** The new wording of the step. */
	text: z.string().min(1).max(2000).optional(),
	/** Takes the step out of the plan. */
	remove: z.boolean().optional(),
	expectVersion: z.number().int().optional()
});
export const updateStepInput = updateStepBody.refine(
	(i) => (i.text !== undefined) !== (i.remove === true),
	{ message: 'Give the new text, or remove: true. Not both and not neither.' }
);

// -- FUNCTIONS -- //

/** Adds a phase (with steps) at the end of the plan. The item's percent and drift flags are recalculated at once. */
export async function addPhase(ctx: Ctx, raw: z.input<typeof addPhaseInput>) {
	const input = addPhaseInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			await enforcePlanRules(tx, it.projectId, {
				texts: [input.title, ...input.steps.map((x) => x.text)],
				browser: input.steps.some((x) => !!x.requiredTarget)
			});
			const [dupe] = await tx
				.select({ id: phase.id })
				.from(phase)
				.where(and(eq(phase.itemId, it.id), eq(phase.key, input.key)));
			if (dupe) throw new OpError('CONFLICT', `${it.ref} already has a phase ${input.key}.`);
			const [last] = await tx
				.select({ n: sql<number>`coalesce(max(${phase.position}), 0)::int` })
				.from(phase)
				.where(eq(phase.itemId, it.id));
			const [ph] = await tx
				.insert(phase)
				.values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					key: input.key,
					title: input.title,
					position: last.n + 1
				})
				.returning();
			let n = 0;
			for (const s of input.steps)
				await tx.insert(step).values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					phaseId: ph.id,
					key: s.key ?? `${input.key}.${++n}`,
					text: s.text,
					requiredTarget: s.requiredTarget ?? null,
					position: n || 1
				});
			const calc = await recalcItem(tx, it.id);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'phase.create',
				targetType: 'phase',
				targetId: ph.id,
				after: { key: ph.key, steps: input.steps.length } as never
			});
			return { phase: ph, percent: calc.percent };
		})
	);
}

/** Adds steps to the end of one phase. */
export async function addSteps(ctx: Ctx, raw: z.input<typeof addStepsInput>) {
	const input = addStepsInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			await enforcePlanRules(tx, it.projectId, {
				texts: input.steps.map((x) => x.text),
				browser: input.steps.some((x) => !!x.requiredTarget)
			});
			const [ph] = await tx
				.select()
				.from(phase)
				.where(and(eq(phase.itemId, it.id), eq(phase.key, input.phase)));
			if (!ph) throw new OpError('NOT_FOUND', `${it.ref} has no phase ${input.phase}.`);
			const existing = await tx
				.select({ key: step.key, position: step.position })
				.from(step)
				.where(eq(step.phaseId, ph.id))
				.orderBy(asc(step.position));
			let position = existing.reduce((m, s) => Math.max(m, s.position), 0);
			// The next default key follows the highest number in use, so a removed step never makes a new key collide
			let next = existing.reduce((m, e) => {
				const n = Number(/\.(\d+)[a-z]?$/.exec(e.key)?.[1]);
				return Number.isFinite(n) ? Math.max(m, n) : m;
			}, 0);
			const made: string[] = [];
			for (const s of input.steps) {
				next++;
				position++;
				const key = s.key ?? `${input.phase}.${next}`;
				if (existing.some((e) => e.key === key) || made.includes(key))
					throw new OpError('CONFLICT', `${it.ref} already has a step ${key}.`);
				await tx.insert(step).values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					phaseId: ph.id,
					key,
					text: s.text,
					requiredTarget: s.requiredTarget ?? null,
					position
				});
				made.push(key);
			}
			const calc = await recalcItem(tx, it.id);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'step.create',
				targetType: 'phase',
				targetId: ph.id,
				after: { keys: made } as never,
				// Undoing a create would delete the whole phase, which is not what "undo these steps" means
				undoable: false
			});
			return { keys: made, percent: calc.percent };
		})
	);
}

/** Adds manual checks (M1, M2 ...). They are never counted toward the percent. */
export async function addManualChecks(ctx: Ctx, raw: z.input<typeof addChecksInput>) {
	const input = addChecksInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			await enforcePlanRules(tx, it.projectId, {
				texts: input.checks.map((x) => x.text),
				browser: input.checks.some((x) => x.auto)
			});
			const existing = await tx
				.select({ key: manualCheck.key, position: manualCheck.position })
				.from(manualCheck)
				.where(eq(manualCheck.itemId, it.id));
			let position = existing.reduce((m, c) => Math.max(m, c.position), 0);
			for (const c of input.checks) {
				if (existing.some((e) => e.key === c.key))
					throw new OpError('CONFLICT', `${it.ref} already has a check ${c.key}.`);
				await tx.insert(manualCheck).values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					key: c.key,
					text: c.text,
					auto: c.auto,
					position: ++position
				});
			}
			const calc = await recalcItem(tx, it.id);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'manual_check.create',
				targetType: 'item',
				targetId: it.id,
				after: { keys: input.checks.map((c) => c.key) } as never,
				undoable: false
			});
			return { keys: input.checks.map((c) => c.key), openManual: calc.counts.openManual };
		})
	);
}

/**
 * Changes the wording of an open step, or takes an open step out of the plan. A step that is done, waived or superseded is
 * a record of work and stays as it is. A wording change can be undone; a removal cannot.
 */
export async function updateStep(ctx: Ctx, raw: z.input<typeof updateStepInput>) {
	const input = updateStepInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			if (input.text !== undefined)
				await enforcePlanRules(tx, it.projectId, { texts: [input.text], browser: false });
			const [st] = await tx
				.select()
				.from(step)
				.where(and(eq(step.itemId, it.id), eq(step.key, input.key)));
			if (!st) throw new OpError('NOT_FOUND', `${it.ref} has no step ${input.key}.`);
			if (st.state !== 'open')
				throw new OpError(
					'CONFLICT',
					`Step ${input.key} of ${it.ref} is ${st.state}. Only an open step can be changed.`
				);
			if (input.remove) {
				// Comments on a step go with it (the column cascades), so a step that has any is kept
				const [talk] = await tx
					.select({ n: sql<number>`count(*)::int` })
					.from(comment)
					.where(eq(comment.stepId, st.id));
				if (talk.n > 0)
					throw new OpError(
						'CONFLICT',
						`Step ${input.key} of ${it.ref} has ${talk.n} comment${talk.n === 1 ? '' : 's'}. Reword it instead of removing it.`
					);
				await tx.delete(step).where(eq(step.id, st.id));
				const calc = await recalcItem(tx, it.id);
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'step.delete',
					targetType: 'step',
					targetId: st.id,
					before: { key: st.key, text: st.text } as never,
					undoable: false
				});
				return { key: st.key, removed: true, percent: calc.percent };
			}
			if (input.text === st.text) return { key: st.key, changed: false, percent: it.percent };
			await tx
				.update(step)
				.set({ text: input.text, updatedAt: sql`now()`, version: sql`${step.version} + 1` })
				.where(eq(step.id, st.id));
			const calc = await recalcItem(tx, it.id);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'step.update',
				targetType: 'step',
				targetId: st.id,
				before: { text: st.text } as never,
				after: { text: input.text } as never
			});
			return { key: st.key, changed: true, percent: calc.percent };
		})
	);
}
