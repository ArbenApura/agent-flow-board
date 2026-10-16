// PLAN VERBS: ADD PHASES, STEPS AND MANUAL CHECKS TO AN ITEM THAT ALREADY EXISTS (A PLAN GROWS AS THE WORK IS UNDERSTOOD)

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { recalcItem } from '../db/calc';
import { appendEvent } from '../db/events';
import { manualCheck, phase, step } from '../db/schema';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields, checkVersion } from './items';
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
			let next = existing.length;
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
				after: { keys: made } as never
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
