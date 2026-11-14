// DOCUMENT VERBS: DECISIONS, SECTIONS, TASKS AND COMMENTS (SPEC 5)

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { allocateTaskNumber } from '../db/numbering';
import { appendEvent } from '../db/events';
import {
	comment,
	decision,
	item,
	mockup,
	mockupVersion,
	project,
	section,
	task
} from '../db/schema';
import {
	extractMockupHooks,
	verifyDesignBriefHookCitations,
	type MockupDerivedAssets
} from '../mockups/derived';
import { OpError, idempotent, rateLimit, requireCap, requireOrgMember, run } from './context';
import { actorFields, canSeeItem, checkVersion } from './items';
import { findItem, findProject } from './resolve';

// -- CONSTANTS -- //

export const decisionInput = z.object({
	item: z.string().min(1),
	kind: z.enum(['adr', 'settled']).default('adr'),
	/** Leave out to take the next number for this item and kind. */
	number: z.number().int().min(1).optional(),
	title: z.string().min(1).max(200),
	context: z.string().max(20_000).default(''),
	decision: z.string().max(20_000).default(''),
	alternatives: z.string().max(20_000).default(''),
	consequences: z.string().max(20_000).default(''),
	/** For a settled row, the answer and where it came from. */
	answer: z.string().max(2000).nullish(),
	source: z.string().max(500).nullish(),
	expectVersion: z.number().int().optional()
});

export const deleteDecisionInput = z.object({
	item: z.string().min(1),
	kind: z.enum(['adr', 'settled']),
	number: z.number().int().min(1)
});

export const sectionInput = z.object({
	item: z.string().min(1),
	slug: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.max(40),
	title: z.string().min(1).max(120),
	body: z.string().max(200_000),
	expectVersion: z.number().int().optional()
});

const hasControl = (s: string) =>
	[...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** A group name or a priority: trimmed, blank means none, no control characters or line breaks. */
const taskLabel = (max: number) =>
	z
		.string()
		.max(max)
		.refine((v) => !hasControl(v), 'Use plain text on one line.')
		.transform((v) => v.trim() || null);

const TASK_STATUS = z.enum(['TODO', 'IN PROGRESS', 'DONE', 'DROPPED', 'FUTURE']);

export const taskInput = z.object({
	project: z.string().min(1),
	title: z.string().min(3).max(200),
	status: TASK_STATUS.default('TODO'),
	assigneeId: z.string().nullish(),
	linkedItems: z.array(z.string().min(1)).max(20).default([]),
	/** What the task asks, as Markdown. Always rendered as untrusted text. */
	body: z.string().max(20_000).default(''),
	groupName: taskLabel(120).nullish(),
	priority: taskLabel(20).nullish()
});

export const taskUpdateInput = z.object({
	task: z.string().uuid(),
	expectVersion: z.number().int().optional(),
	title: z.string().min(3).max(200).optional(),
	status: TASK_STATUS.optional(),
	/** Null unassigns. Leaving a field out leaves it alone. */
	assigneeId: z.string().nullable().optional(),
	linkedItems: z.array(z.string().min(1)).max(20).optional(),
	body: z.string().max(20_000).optional(),
	groupName: taskLabel(120).nullable().optional(),
	priority: taskLabel(20).nullable().optional()
});

export const taskDeleteInput = z.object({
	task: z.string().uuid(),
	expectVersion: z.number().int().optional()
});

export const commentInput = z.object({
	item: z.string().min(1),
	stepKey: z.string().max(20).optional(),
	body: z.string().min(1).max(20_000)
});

// -- DECISIONS -- //

/** Creates a decision or updates the one with this number. An ADR and a settled row have separate numbering. */
export async function upsertDecision(ctx: Ctx, raw: z.input<typeof decisionInput>) {
	const input = decisionInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			const number =
				input.number ??
				(
					await tx
						.select({ n: sql<number>`coalesce(max(${decision.number}), 0)::int` })
						.from(decision)
						.where(and(eq(decision.itemId, it.id), eq(decision.kind, input.kind)))
				)[0].n + 1;
			const [existing] = await tx
				.select()
				.from(decision)
				.where(
					and(
						eq(decision.itemId, it.id),
						eq(decision.kind, input.kind),
						eq(decision.number, number)
					)
				);
			const values = {
				title: input.title,
				context: input.context,
				decision: input.decision,
				alternatives: input.alternatives,
				consequences: input.consequences,
				answer: input.answer ?? null,
				source: input.source ?? null
			};
			if (existing) {
				checkVersion(existing, input.expectVersion);
				const [row] = await tx
					.update(decision)
					.set({ ...values, updatedAt: sql`now()`, version: sql`${decision.version} + 1` })
					.where(eq(decision.id, existing.id))
					.returning();
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'decision.update',
					targetType: 'decision',
					targetId: row.id,
					before: {
						title: existing.title,
						decision: existing.decision,
						answer: existing.answer
					} as never,
					after: { title: row.title, decision: row.decision, answer: row.answer } as never
				});
				return { decision: row, created: false };
			}
			const [row] = await tx
				.insert(decision)
				.values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					kind: input.kind,
					number,
					position: number,
					...values
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'decision.create',
				targetType: 'decision',
				targetId: row.id,
				after: { title: row.title } as never
			});
			return { decision: row, created: true };
		})
	);
}

/** Removes one decision row and records it. The caller has found the row and holds the transaction. */
async function dropDecision(tx: Tx, ctx: Ctx, row: typeof decision.$inferSelect) {
	await requireCap(tx, ctx, 'delete', row.projectId);
	await tx.delete(decision).where(eq(decision.id, row.id));
	await appendEvent(tx, {
		orgId: ctx.orgId,
		projectId: row.projectId,
		itemId: row.itemId,
		...actorFields(ctx),
		verb: 'decision.delete',
		targetType: 'decision',
		targetId: row.id,
		before: { title: row.title },
		undoable: false
	});
}

export async function deleteDecision(ctx: Ctx, decisionId: string) {
	return run(ctx, async (tx) => {
		const [row] = await tx.select().from(decision).where(eq(decision.id, decisionId));
		if (!row) throw new OpError('NOT_FOUND', 'No such decision.');
		await dropDecision(tx, ctx, row);
		return { id: decisionId, deleted: true };
	});
}

/** Removes a decision named by its item, kind and number (what a person or an agent sees), and can be retried safely. */
export async function deleteDecisionByNumber(ctx: Ctx, raw: z.input<typeof deleteDecisionInput>) {
	const input = deleteDecisionInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await rateLimit(tx, ctx, 'write');
			const [row] = await tx
				.select()
				.from(decision)
				.where(
					and(
						eq(decision.itemId, it.id),
						eq(decision.kind, input.kind),
						eq(decision.number, input.number)
					)
				);
			if (!row)
				throw new OpError('NOT_FOUND', `${it.ref} has no ${input.kind} decision ${input.number}.`);
			await dropDecision(tx, ctx, row);
			return { ref: it.ref, kind: input.kind, number: input.number, deleted: true };
		})
	);
}

// -- SECTIONS -- //

/** Creates or replaces one document section of an item (Spec, As built, Resume here, Blockers or a custom document). */
export async function upsertSection(ctx: Ctx, raw: z.input<typeof sectionInput>) {
	const input = sectionInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			if (input.slug === 'design-brief') {
				const linkedMockups = await tx
					.select({ id: mockup.id, currentVersion: mockup.currentVersion })
					.from(mockup)
					.where(
						and(eq(mockup.itemId, it.id), eq(mockup.orgId, ctx.orgId), isNull(mockup.trashedAt))
					);
				if (linkedMockups.length) {
					const [proj] = await tx
						.select({ visualEvidenceGate: project.visualEvidenceGate })
						.from(project)
						.where(eq(project.id, it.projectId));
					const versions = await tx
						.select({
							mockupId: mockupVersion.mockupId,
							number: mockupVersion.number,
							derived: mockupVersion.derived,
							storageKey: mockupVersion.storageKey
						})
						.from(mockupVersion)
						.where(
							inArray(
								mockupVersion.mockupId,
								linkedMockups.map((m) => m.id)
							)
						);
					const knownHooks = new Set<string>();
					for (const lm of linkedMockups) {
						const v = versions.find((r) => r.mockupId === lm.id && r.number === lm.currentVersion);
						if (!v) continue;
						const derived = v.derived as MockupDerivedAssets | null;
						const hooks = derived?.outline?.hooks;
						if (hooks?.length) {
							for (const h of hooks) {
								knownHooks.add(h);
								knownHooks.add(h.toLowerCase());
							}
						} else if (ctx.services?.storage) {
							const bytes = await ctx.services.storage.get(v.storageKey).catch(() => null);
							if (bytes) {
								for (const h of extractMockupHooks(new TextDecoder().decode(bytes))) {
									knownHooks.add(h);
									knownHooks.add(h.toLowerCase());
								}
							}
						}
					}
					const check = verifyDesignBriefHookCitations(
						input.body,
						knownHooks,
						Boolean(proj?.visualEvidenceGate)
					);
					if (check.missingHooks.length) {
						throw new OpError(
							'INVALID',
							`Design-brief cites mockup hook(s) not found in the linked mockup HTML: ${check.missingHooks.join(', ')}.`,
							{ missingHooks: check.missingHooks }
						);
					}
					if (check.uncitedLines.length) {
						throw new OpError(
							'INVALID',
							`Every Mockup inventory line in design-brief must cite a mockup hook (e.g. data-ref="..." or hook: name). Uncited: ${check.uncitedLines[0]}`,
							{ uncitedLines: check.uncitedLines }
						);
					}
				}
			}
			const [existing] = await tx
				.select()
				.from(section)
				.where(and(eq(section.itemId, it.id), eq(section.slug, input.slug)));
			if (existing) {
				checkVersion(existing, input.expectVersion);
				if (existing.body === input.body && existing.title === input.title)
					return { section: existing, changed: false };
				const [row] = await tx
					.update(section)
					.set({
						title: input.title,
						body: input.body,
						updatedAt: sql`now()`,
						version: sql`${section.version} + 1`
					})
					.where(eq(section.id, existing.id))
					.returning();
				await tx
					.update(item)
					.set({ lastActivityAt: sql`now()` })
					.where(eq(item.id, it.id));
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'section.update',
					targetType: 'section',
					targetId: row.id,
					before: { title: existing.title, body: existing.body } as never,
					after: { title: row.title, body: row.body } as never
				});
				return { section: row, changed: true };
			}
			const [row] = await tx
				.insert(section)
				.values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					slug: input.slug,
					title: input.title,
					body: input.body
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'section.create',
				targetType: 'section',
				targetId: row.id,
				after: { slug: row.slug } as never
			});
			return { section: row, changed: true };
		})
	);
}

// -- TASKS -- //

async function linkIds(
	ctx: Ctx,
	tx: Parameters<Parameters<typeof run>[1]>[0],
	names: string[]
): Promise<string[]> {
	const ids: string[] = [];
	for (const n of names) ids.push((await findItem(tx, ctx, n)).id);
	return ids;
}

export async function createTask(ctx: Ctx, raw: z.input<typeof taskInput>) {
	const input = taskInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			await requireOrgMember(tx, ctx, input.assigneeId);
			const number = await allocateTaskNumber(tx, ctx.orgId, proj.id);
			const [row] = await tx
				.insert(task)
				.values({
					orgId: ctx.orgId,
					projectId: proj.id,
					number,
					title: input.title,
					status: input.status,
					assigneeId: input.assigneeId ?? null,
					body: input.body,
					groupName: input.groupName ?? null,
					priority: input.priority ?? null,
					linkedItemIds: await linkIds(ctx, tx, input.linkedItems)
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				...actorFields(ctx),
				verb: 'task.create',
				targetType: 'task',
				targetId: row.id,
				after: { title: row.title } as never
			});
			return { task: row, ref: `T-${number}` };
		})
	);
}

export async function updateTask(ctx: Ctx, raw: z.input<typeof taskUpdateInput>) {
	const input = taskUpdateInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const [t] = await tx
				.select()
				.from(task)
				.where(and(eq(task.id, input.task), sql`${task.deletedAt} is null`))
				.for('update');
			if (!t) throw new OpError('NOT_FOUND', 'No such task.');
			await requireCap(tx, ctx, 'write', t.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(t, input.expectVersion);
			await requireOrgMember(tx, ctx, input.assigneeId);
			const set: Record<string, unknown> = {};
			const before: Record<string, unknown> = {};
			for (const k of ['title', 'status', 'assigneeId', 'body', 'groupName', 'priority'] as const) {
				if (input[k] !== undefined && input[k] !== t[k]) {
					before[k] = t[k];
					set[k] = input[k];
				}
			}
			if (input.linkedItems) {
				before.linkedItemIds = t.linkedItemIds;
				set.linkedItemIds = await linkIds(ctx, tx, input.linkedItems);
			}
			if (Object.keys(set).length === 0) return { task: t, changed: false };
			const [row] = await tx
				.update(task)
				.set({ ...set, updatedAt: sql`now()`, version: sql`${task.version} + 1` })
				.where(eq(task.id, t.id))
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: t.projectId,
				...actorFields(ctx),
				verb: 'task.update',
				targetType: 'task',
				targetId: t.id,
				before: before as never,
				after: set as never
			});
			return { task: row, changed: true };
		})
	);
}

/** Moves a task to the trash. The delete right is needed, as for an item, and the caller's version may be checked. */
export async function deleteTask(ctx: Ctx, raw: z.input<typeof taskDeleteInput>) {
	const input = taskDeleteInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const [t] = await tx.select().from(task).where(eq(task.id, input.task)).for('update');
			if (!t) throw new OpError('NOT_FOUND', 'No such task.');
			// The right is checked before anything about the task is said, so a refused caller learns nothing
			await requireCap(tx, ctx, 'delete', t.projectId);
			await rateLimit(tx, ctx, 'write');
			if (t.deletedAt) return { task: t, deleted: true, changed: false };
			checkVersion(t, input.expectVersion);
			const [row] = await tx
				.update(task)
				.set({ deletedAt: sql`now()`, updatedAt: sql`now()`, version: sql`${task.version} + 1` })
				.where(eq(task.id, t.id))
				.returning();
			// Not undoable through the generic undo: restoreTask is the one way back, so the right and the version are checked
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: t.projectId,
				...actorFields(ctx),
				verb: 'task.delete',
				targetType: 'task',
				targetId: t.id,
				before: { title: t.title, status: t.status } as never,
				after: { deleted: true } as never,
				undoable: false
			});
			return { task: row, deleted: true, changed: true };
		})
	);
}

/** Brings a task back from the trash. */
export async function restoreTask(ctx: Ctx, taskId: string) {
	const id = z.string().uuid().parse(taskId);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const [t] = await tx.select().from(task).where(eq(task.id, id)).for('update');
			if (!t) throw new OpError('NOT_FOUND', 'No such task.');
			await requireCap(tx, ctx, 'delete', t.projectId);
			await rateLimit(tx, ctx, 'write');
			if (!t.deletedAt) return { task: t, deleted: false, changed: false };
			const [row] = await tx
				.update(task)
				.set({ deletedAt: null, updatedAt: sql`now()`, version: sql`${task.version} + 1` })
				.where(eq(task.id, t.id))
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: t.projectId,
				...actorFields(ctx),
				verb: 'task.restore',
				targetType: 'task',
				targetId: t.id,
				after: { title: t.title, status: t.status } as never,
				undoable: false
			});
			return { task: row, deleted: false, changed: true };
		})
	);
}

export async function listTasks(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'read', proj.id);
		return tx
			.select()
			.from(task)
			.where(and(eq(task.projectId, proj.id), sql`${task.deletedAt} is null`))
			.orderBy(asc(task.number));
	});
}

// -- COMMENTS -- //

/** Adds a comment. A guest's text is marked untrusted, so an agent that reads it knows not to follow instructions in it (L3). */
export async function addComment(ctx: Ctx, raw: z.input<typeof commentInput>) {
	const input = commentInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item);
			const { role } = await requireCap(tx, ctx, 'comment', it.projectId);
			if (!canSeeItem(role, it, ctx.actor.userId))
				throw new OpError('NOT_FOUND', `No item named "${input.item}".`);
			await rateLimit(tx, ctx, 'write');
			const [row] = await tx
				.insert(comment)
				.values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					authorId: ctx.actor.userId,
					body: input.body,
					untrusted: role === 'guest'
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'comment.create',
				targetType: 'comment',
				targetId: row.id,
				after: { length: input.body.length } as never,
				undoable: false
			});
			return { comment: row };
		})
	);
}

export async function listComments(ctx: Ctx, nameOrId: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, nameOrId);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${nameOrId}".`);
		return tx
			.select()
			.from(comment)
			.where(eq(comment.itemId, it.id))
			.orderBy(desc(comment.createdAt));
	});
}
