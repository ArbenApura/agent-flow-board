// THE LITE FLOW (AFB-20261105-0653): AN ITEM OF 1 TO 3 STEPS IS CREATED WITH ITS SPEC AND SETTLED DECISIONS IN ONE CALL, AND CLOSED IN ONE CALL.
// Both verbs only compose the existing ones (createItem, upsertSection, upsertDecision, recordSteps), so the live role check, the rate
// limits, the plan rules and the idempotency of each write stay where they are. A call is one transaction.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import { OpError, subRequest } from './context';
import { upsertDecision, upsertSection } from './docs';
import { tabNameSchema } from '../db/zod';
import { createItem } from './items';
import { recordSteps } from './steps';

// -- CONSTANTS -- //

/** The most steps a lite item may have. A longer plan is the full flow, which the server enforces so a flag cannot widen it. */
export const LITE_MAX_STEPS = 3;

export const liteInput = z.object({
	project: z.string().min(1),
	title: z.string().min(3).max(200),
	tabName: tabNameSchema.nullish(),
	stream: z.string().min(1).max(40).optional(),
	scope: z.string().min(1).max(40).optional(),
	steps: z.array(z.string().min(1).max(2000)).min(1),
	spec: z.string().min(1),
	validation: z.string().optional(),
	references: z.string().optional(),
	decisions: z
		.array(
			z.object({
				title: z.string().min(1),
				answer: z.string().min(1),
				source: z.string().min(1)
			})
		)
		.max(20)
		.default([])
});

// -- FUNCTIONS -- //

/** Creates the item with one phase of 1 to 3 steps, the spec (and validation, references) sections and the settled decisions. */
export async function createLiteItem(ctx: Ctx, raw: z.input<typeof liteInput>) {
	const input = liteInput.parse(raw);
	if (input.steps.length > LITE_MAX_STEPS)
		throw new OpError(
			'INVALID',
			`A lite item has at most ${LITE_MAX_STEPS} steps, this plan has ${input.steps.length}. Use item_new and the full flow for a plan of this size.`
		);
	const made = await createItem(subRequest(ctx, 'lite:item', input.project, input.title), {
		project: input.project,
		title: input.title,
		tabName: input.tabName,
		...(input.stream ? { stream: input.stream } : {}),
		...(input.scope ? { scope: input.scope } : {}),
		phases: [{ key: '1', title: 'Build', steps: input.steps.map((text) => ({ text })) }]
	} as never);
	const sections = [
		{ slug: 'spec', title: 'Spec', body: input.spec },
		...(input.validation
			? [{ slug: 'validation', title: 'Validation', body: input.validation }]
			: []),
		...(input.references
			? [{ slug: 'references', title: 'References', body: input.references }]
			: [])
	];
	for (const s of sections)
		await upsertSection(subRequest(ctx, `lite:section:${s.slug}`, made.ref), {
			item: made.ref,
			...s
		});
	for (const [i, d] of input.decisions.entries())
		await upsertDecision(subRequest(ctx, `lite:decision:${i}`, made.ref, d), {
			item: made.ref,
			kind: 'settled',
			...d
		} as never);
	return {
		ref: made.ref,
		id: made.id,
		steps: input.steps.length,
		decisions: input.decisions.length
	};
}

export const closeInput = z.object({
	item: z.string().min(1),
	keys: z.array(z.string()).default([]),
	log: z.string().min(3).optional(),
	lessons: z.string().min(1)
});

/**
 * The lessons first, then the last steps (so the item moves to IN REVIEW with its lessons written). recordSteps checks the
 * caller's live role even when no key is given, so a viewer can neither write the lessons nor release the claim that follows.
 */
export async function closeLiteItem(ctx: Ctx, raw: z.input<typeof closeInput>) {
	const input = closeInput.parse(raw);
	await upsertSection(subRequest(ctx, 'close:lessons', input.item), {
		item: input.item,
		slug: 'lessons',
		title: 'Lessons',
		body: input.lessons
	});
	// The lite close is an agent's call (the lite_close tool is its one caller), so the mockup gate applies
	return recordSteps(
		subRequest(ctx, 'close:steps', input.item, input.keys),
		{
			item: input.item,
			marks: input.keys.map((key) => ({ key, mark: 'done' as const })),
			log: input.log
		},
		{ agentGate: true }
	);
}
