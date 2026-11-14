// PLAN VERBS: ADD PHASES, STEPS AND MANUAL CHECKS TO AN ITEM THAT ALREADY EXISTS (A PLAN GROWS AS THE WORK IS UNDERSTOOD)

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { effectiveStepVisible } from '../../shared/screenGlobs';
import { recalcItem } from '../db/calc';
import { appendEvent } from '../db/events';
import { comment, manualCheck, phase, step } from '../db/schema';
import { OpError, idempotent, isLivePersonSession, rateLimit, requireCap, run } from './context';
import { actorFields, checkVersion } from './items';
import { mockupUnreadError, unreadForGate } from './mockupReads';
import { enforcePlanRules } from './planRules';
import { findItem } from './resolve';
import { clearSliceWaitingForItem, inferStepVisible, loadItemVisualContext } from './visibleSteps';

// -- CONSTANTS -- //

const stepIn = z.object({
	key: z
		.string()
		.regex(/^[0-9A-Za-z]+\.[0-9]+[a-z]?$/)
		.optional(),
	text: z.string().min(1).max(2000),
	requiredTarget: z.enum(['dev', 'preview', 'deployed']).nullable().optional(),
	visible: z.boolean().nullable().optional(),
	files: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
	screens: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
	widths: z.array(z.number().int().min(200).max(4000)).max(10).optional()
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
	visible: z.boolean().nullable().optional(),
	files: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
	screens: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
	widths: z.array(z.number().int().min(200).max(4000)).max(10).optional(),
	expectVersion: z.number().int().optional()
});
export const updateStepInput = updateStepBody.refine(
	(i) =>
		!(i.remove === true && i.text !== undefined) &&
		(i.text !== undefined ||
			i.remove === true ||
			i.visible !== undefined ||
			i.files !== undefined ||
			i.screens !== undefined ||
			i.widths !== undefined),
	{ message: 'Give the new text, visibility/scope fields, or remove: true.' }
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
			if (!isLivePersonSession(ctx) && input.steps.some((s) => s.visible === false)) {
				throw new OpError(
					'FORBIDDEN',
					'Only a person in a live web session can mark a step as not visible.'
				);
			}
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
			const vis = await loadItemVisualContext(tx, ctx, it.id, it.projectId);
			let n = 0;
			for (const s of input.steps) {
				const files = s.files ?? [];
				const screens = s.screens ?? [];
				const widths = s.widths ?? [];
				const visibleInferred = inferStepVisible(vis, { text: s.text, files, screens });
				if (!isLivePersonSession(ctx) && s.visible === false && visibleInferred) {
					throw new OpError(
						'FORBIDDEN',
						'Only a person in a live web session can mark an inferred-visible step as not visible.'
					);
				}
				const [inserted] = await tx
					.insert(step)
					.values({
						orgId: ctx.orgId,
						projectId: it.projectId,
						itemId: it.id,
						phaseId: ph.id,
						key: s.key ?? `${input.key}.${++n}`,
						text: s.text,
						requiredTarget: s.requiredTarget ?? null,
						visible: s.visible ?? null,
						visibleInferred,
						files,
						screens,
						widths,
						position: n || 1
					})
					.returning({
						id: step.id,
						key: step.key,
						visible: step.visible,
						visibleInferred: step.visibleInferred
					});
				if (visibleInferred || (s.visible !== undefined && s.visible !== null)) {
					await appendEvent(tx, {
						orgId: ctx.orgId,
						projectId: it.projectId,
						itemId: it.id,
						...actorFields(ctx),
						verb: 'step.visibility',
						targetType: 'step',
						targetId: inserted.id,
						after: {
							key: inserted.key,
							visible: inserted.visible,
							visibleInferred: inserted.visibleInferred,
							effectiveVisible: effectiveStepVisible(inserted),
							source: s.visible !== undefined && s.visible !== null ? 'author' : 'inference'
						} as never,
						undoable: false
					});
				}
			}
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
			const vis = await loadItemVisualContext(tx, ctx, it.id, it.projectId);
			if (!isLivePersonSession(ctx) && input.steps.some((s) => s.visible === false)) {
				throw new OpError(
					'FORBIDDEN',
					'Only a person in a live web session can mark a step as not visible.'
				);
			}
			const made: string[] = [];
			for (const s of input.steps) {
				next++;
				position++;
				const key = s.key ?? `${input.phase}.${next}`;
				if (existing.some((e) => e.key === key) || made.includes(key))
					throw new OpError('CONFLICT', `${it.ref} already has a step ${key}.`);
				const files = s.files ?? [];
				const screens = s.screens ?? [];
				const widths = s.widths ?? [];
				const visibleInferred = inferStepVisible(vis, { text: s.text, files, screens });
				if (!isLivePersonSession(ctx) && s.visible === false && visibleInferred) {
					throw new OpError(
						'FORBIDDEN',
						`Step ${key}: only a person in a live web session can mark an inferred-visible step as not visible.`
					);
				}
				const [inserted] = await tx
					.insert(step)
					.values({
						orgId: ctx.orgId,
						projectId: it.projectId,
						itemId: it.id,
						phaseId: ph.id,
						key,
						text: s.text,
						requiredTarget: s.requiredTarget ?? null,
						visible: s.visible ?? null,
						visibleInferred,
						files,
						screens,
						widths,
						position
					})
					.returning({
						id: step.id,
						key: step.key,
						visible: step.visible,
						visibleInferred: step.visibleInferred
					});
				if (visibleInferred || (s.visible !== undefined && s.visible !== null)) {
					await appendEvent(tx, {
						orgId: ctx.orgId,
						projectId: it.projectId,
						itemId: it.id,
						...actorFields(ctx),
						verb: 'step.visibility',
						targetType: 'step',
						targetId: inserted.id,
						after: {
							key: inserted.key,
							visible: inserted.visible,
							visibleInferred: inserted.visibleInferred,
							effectiveVisible: effectiveStepVisible(inserted),
							source: s.visible !== undefined && s.visible !== null ? 'author' : 'inference'
						} as never,
						undoable: false
					});
				}
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
				if (!isLivePersonSession(ctx) && effectiveStepVisible(st)) {
					throw new OpError(
						'FORBIDDEN',
						`Step ${input.key} of ${it.ref} is visible. Only a person in a live web session can remove a visible step.`
					);
				}
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
				// Removing the last open step of a phase closes the phase, so an agent meets the mockup gate here too
				// (AFB-20261111-0046). A person is never held
				if (ctx.actor.kind === 'agent') {
					const [left] = await tx
						.select({ n: sql<number>`count(*)::int` })
						.from(step)
						.where(and(eq(step.phaseId, st.phaseId), eq(step.state, 'open'), ne(step.id, st.id)));
					// Only a phase that was worked on is closed by this: a phase whose every step is still open is plan editing
					const [worked] = await tx
						.select({ n: sql<number>`count(*)::int` })
						.from(step)
						.where(and(eq(step.phaseId, st.phaseId), ne(step.state, 'open')));
					if (left.n === 0 && worked.n > 0) {
						const { unread } = await unreadForGate(tx, ctx, it);
						if (unread.length) throw mockupUnreadError(unread, 'change');
					}
				}
				await tx.delete(step).where(eq(step.id, st.id));
				if (it.sliceGate) await clearSliceWaitingForItem(tx, ctx, it.id, it.projectId);
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
			if (!isLivePersonSession(ctx) && effectiveStepVisible(st)) {
				if (input.text !== undefined && input.text !== st.text) {
					throw new OpError(
						'FORBIDDEN',
						`Step ${input.key} of ${it.ref} is visible. Only a person in a live web session can reword a visible step.`
					);
				}
				if (input.visible !== undefined && input.visible !== st.visible) {
					throw new OpError(
						'FORBIDDEN',
						`Step ${input.key} of ${it.ref} is visible. Only a person in a live web session can change its visibility.`
					);
				}
				const droppedFile =
					input.files !== undefined && (st.files ?? []).some((f) => !input.files!.includes(f));
				const droppedScreen =
					input.screens !== undefined &&
					(st.screens ?? []).some((s) => !input.screens!.includes(s));
				const droppedWidth =
					input.widths !== undefined && (st.widths ?? []).some((w) => !input.widths!.includes(w));
				if (droppedFile || droppedScreen || droppedWidth) {
					throw new OpError(
						'FORBIDDEN',
						`Step ${input.key} of ${it.ref} is visible. Only a person in a live web session can remove files, screens, or widths from it.`
					);
				}
			}
			const nextText = input.text ?? st.text;
			const nextFiles = input.files ?? st.files ?? [];
			const nextScreens = input.screens ?? st.screens ?? [];
			const nextWidths = input.widths ?? st.widths ?? [];
			const nextVisible = input.visible !== undefined ? input.visible : st.visible;
			const vis = await loadItemVisualContext(tx, ctx, it.id, it.projectId);
			const nextInferred = inferStepVisible(vis, {
				text: nextText,
				files: nextFiles,
				screens: nextScreens
			});
			if (
				!isLivePersonSession(ctx) &&
				effectiveStepVisible(st) &&
				!effectiveStepVisible({ visible: nextVisible, visibleInferred: nextInferred })
			) {
				throw new OpError(
					'FORBIDDEN',
					`Step ${input.key} of ${it.ref} is visible. Only a person in a live web session can turn visibility off.`
				);
			}
			if (!isLivePersonSession(ctx) && input.visible === false) {
				throw new OpError(
					'FORBIDDEN',
					`Step ${input.key} of ${it.ref}: only a person in a live web session can set visible to false.`
				);
			}
			if (
				!isLivePersonSession(ctx) &&
				nextVisible === false &&
				(st.visibleInferred || nextInferred)
			) {
				throw new OpError(
					'FORBIDDEN',
					`Step ${input.key} of ${it.ref} is inferred visible. Only a person in a live web session can set visible to false.`
				);
			}
			const visChanged = nextVisible !== st.visible || nextInferred !== st.visibleInferred;
			const textChanged = nextText !== st.text;
			const metaChanged =
				JSON.stringify(nextFiles) !== JSON.stringify(st.files ?? []) ||
				JSON.stringify(nextScreens) !== JSON.stringify(st.screens ?? []) ||
				JSON.stringify(nextWidths) !== JSON.stringify(st.widths ?? []);
			if (!visChanged && !textChanged && !metaChanged)
				return { key: st.key, changed: false, percent: it.percent };
			await tx
				.update(step)
				.set({
					text: nextText,
					visible: nextVisible,
					visibleInferred: nextInferred,
					files: nextFiles,
					screens: nextScreens,
					widths: nextWidths,
					updatedAt: sql`now()`,
					version: sql`${step.version} + 1`
				})
				.where(eq(step.id, st.id));
			if (it.sliceGate && visChanged) {
				await clearSliceWaitingForItem(tx, ctx, it.id, it.projectId);
			}
			const calc = await recalcItem(tx, it.id);
			if (textChanged) {
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'step.update',
					targetType: 'step',
					targetId: st.id,
					before: { text: st.text } as never,
					after: { text: nextText } as never,
					undoable: !effectiveStepVisible(st)
				});
			}
			if (visChanged) {
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'step.visibility',
					targetType: 'step',
					targetId: st.id,
					before: {
						key: st.key,
						visible: st.visible,
						visibleInferred: st.visibleInferred,
						effectiveVisible: effectiveStepVisible(st)
					} as never,
					after: {
						key: st.key,
						visible: nextVisible,
						visibleInferred: nextInferred,
						effectiveVisible: effectiveStepVisible({
							visible: nextVisible,
							visibleInferred: nextInferred
						}),
						source: input.visible !== undefined ? 'override' : 'inference'
					} as never,
					undoable: false
				});
			}
			return { key: st.key, changed: true, percent: calc.percent };
		})
	);
}
