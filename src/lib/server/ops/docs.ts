// DOCUMENT VERBS: DECISIONS, SECTIONS, TASKS AND COMMENTS (SPEC 5)

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { allocateTaskNumber } from '../db/numbering';
import { appendEvent } from '../db/events';
import { comment, decision, item, section, task } from '../db/schema';
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

export const taskInput = z.object({
	project: z.string().min(1),
	title: z.string().min(3).max(200),
	status: z.enum(['TODO', 'IN PROGRESS', 'DONE', 'DROPPED', 'FUTURE']).default('TODO'),
	assigneeId: z.string().nullish(),
	linkedItems: z.array(z.string().min(1)).max(20).default([])
});

export const taskUpdateInput = z.object({
	task: z.string().uuid(),
	expectVersion: z.number().int().optional(),
	title: z.string().min(3).max(200).optional(),
	status: z.enum(['TODO', 'IN PROGRESS', 'DONE', 'DROPPED', 'FUTURE']).optional(),
	assigneeId: z.string().nullable().optional(),
	linkedItems: z.array(z.string().min(1)).max(20).optional()
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
			for (const k of ['title', 'status', 'assigneeId'] as const) {
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
