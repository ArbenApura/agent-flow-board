// ITEM VERBS: CREATE, READ, LIST, UPDATE, TRASH AND RESTORE (SPEC 5)

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { allocateItemNumber } from '../db/numbering';
import { recalcItem } from '../db/calc';
import { appendEvent } from '../db/events';
import { decision, item, itemAlias, manualCheck, phase, section, step, task } from '../db/schema';
import { tabNameSchema } from '../db/zod';
import { tabNameFromTitle } from '../../shared/uiChange';
import { OpError, idempotent, rateLimit, requireCap, requireOrgMember, run } from './context';
import { canSeeItem, findItem, findProject } from './resolve';

// -- TYPES -- //

export type ItemRow = typeof item.$inferSelect;

// -- CONSTANTS -- //

const stepIn = z.object({
	key: z
		.string()
		.regex(/^[0-9A-Za-z]+(\.[0-9]+[a-z]?)?$/)
		.optional(),
	text: z.string().min(1).max(2000),
	requiredTarget: z.enum(['dev', 'preview', 'deployed']).nullable().optional()
});
const phaseIn = z.object({
	key: z
		.string()
		.min(1)
		.max(12)
		.regex(/^[0-9A-Za-z]+$/),
	title: z.string().min(1).max(200),
	steps: z.array(stepIn).max(200).default([])
});

/** The plan of an item as an agent or person writes it when creating it. */
export const createItemInput = z.object({
	project: z.string().min(1),
	title: z.string().min(3).max(200),
	tabName: tabNameSchema.nullish(),
	stream: z.string().min(1).max(40).default('features'),
	scope: z.string().min(1).max(40).default('core'),
	visibility: z.enum(['public', 'private']).default('public'),
	branchNote: z.string().max(500).nullish(),
	assigneeId: z.string().nullish(),
	phases: z.array(phaseIn).max(60).default([]),
	manualChecks: z
		.array(
			z.object({
				key: z.string().regex(/^M[0-9]+$/),
				text: z.string().min(1).max(2000),
				auto: z.boolean().default(false)
			})
		)
		.max(100)
		.default([]),
	aliases: z.array(z.string().min(2).max(80)).max(10).default([]),
	sections: z
		.array(
			z.object({
				slug: z
					.string()
					.regex(/^[a-z0-9-]+$/)
					.max(40),
				title: z.string().min(1).max(120),
				body: z.string().max(200_000).default('')
			})
		)
		.max(30)
		.default([])
});
export type CreateItemInput = z.input<typeof createItemInput>;

export const updateItemInput = z.object({
	item: z.string().min(1),
	expectVersion: z.number().int().optional(),
	title: z.string().min(3).max(200).optional(),
	tabName: tabNameSchema.nullable().optional(),
	stream: z.string().min(1).max(40).optional(),
	scope: z.string().min(1).max(40).optional(),
	visibility: z.enum(['public', 'private']).optional(),
	branchNote: z.string().max(500).nullable().optional(),
	assigneeId: z.string().nullable().optional(),
	reviewerId: z.string().nullable().optional()
});

const PATCHABLE = [
	'title',
	'tabName',
	'stream',
	'scope',
	'visibility',
	'branchNote',
	'assigneeId',
	'reviewerId'
] as const;

// -- FUNCTIONS -- //

export { canSeeItem };

/** Everything an event needs to say who acted. */
export function actorFields(ctx: Ctx) {
	return {
		actorUserId: ctx.actor.userId,
		actorLabel: ctx.actor.label ?? null,
		tool: ctx.actor.tool ?? null,
		tokenId: ctx.actor.tokenId ?? null,
		sessionId: ctx.actor.sessionId ?? null,
		requestId: ctx.requestId ?? null
	};
}

/** Bumps the optimistic version and checks it against what the caller read (L16). */
export function checkVersion(
	current: { version: number; updatedAt: Date },
	expected: number | undefined
) {
	if (expected !== undefined && expected !== current.version) {
		throw new OpError(
			'STALE_VERSION',
			'This was changed by someone else since you opened it. Reload to see the newer version.',
			{
				currentVersion: current.version,
				expectedVersion: expected,
				changedAt: current.updatedAt.toISOString()
			}
		);
	}
}

export async function createItem(ctx: Ctx, raw: CreateItemInput) {
	const input = createItemInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			await rateLimit(tx, ctx, 'create');
			await requireOrgMember(tx, ctx, input.assigneeId);
			const { number, ref } = await allocateItemNumber(tx, ctx.orgId, proj.id);
			const [created] = await tx
				.insert(item)
				.values({
					orgId: ctx.orgId,
					projectId: proj.id,
					number,
					ref,
					title: input.title,
					tabName: input.tabName ?? tabNameFromTitle(input.title),
					stream: input.stream,
					scope: input.scope,
					visibility: input.visibility,
					branchNote: input.branchNote ?? null,
					assigneeId: input.assigneeId ?? null,
					createdBy: ctx.actor.userId
				})
				.returning();
			let position = 0;
			for (const p of input.phases) {
				const [ph] = await tx
					.insert(phase)
					.values({
						orgId: ctx.orgId,
						projectId: proj.id,
						itemId: created.id,
						key: p.key,
						title: p.title,
						position: ++position
					})
					.returning();
				let n = 0;
				for (const s of p.steps) {
					n++;
					await tx.insert(step).values({
						orgId: ctx.orgId,
						projectId: proj.id,
						itemId: created.id,
						phaseId: ph.id,
						key: s.key ?? `${p.key}.${n}`,
						text: s.text,
						requiredTarget: s.requiredTarget ?? null,
						position: n
					});
				}
			}
			let m = 0;
			for (const c of input.manualChecks)
				await tx.insert(manualCheck).values({
					orgId: ctx.orgId,
					projectId: proj.id,
					itemId: created.id,
					key: c.key,
					text: c.text,
					auto: c.auto,
					position: ++m
				});
			for (const s of input.sections)
				await tx.insert(section).values({
					orgId: ctx.orgId,
					projectId: proj.id,
					itemId: created.id,
					slug: s.slug,
					title: s.title,
					body: s.body
				});
			for (const a of input.aliases)
				await tx
					.insert(itemAlias)
					.values({ orgId: ctx.orgId, projectId: proj.id, itemId: created.id, alias: a });
			const calc = await recalcItem(tx, created.id);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				itemId: created.id,
				...actorFields(ctx),
				verb: 'item.create',
				targetType: 'item',
				targetId: created.id,
				after: { title: created.title, ref }
			});
			return { item: calc.item, ref, id: created.id };
		})
	);
}

export type ItemDetail = Awaited<ReturnType<typeof loadDetail>>;

async function loadDetail(tx: Tx, it: ItemRow) {
	const phases = await tx
		.select()
		.from(phase)
		.where(eq(phase.itemId, it.id))
		.orderBy(asc(phase.position));
	const steps = await tx
		.select()
		.from(step)
		.where(eq(step.itemId, it.id))
		.orderBy(asc(step.position));
	const checks = await tx
		.select()
		.from(manualCheck)
		.where(eq(manualCheck.itemId, it.id))
		.orderBy(asc(manualCheck.position));
	const decisions = await tx
		.select()
		.from(decision)
		.where(eq(decision.itemId, it.id))
		.orderBy(asc(decision.kind), asc(decision.number));
	const sections = await tx
		.select()
		.from(section)
		.where(eq(section.itemId, it.id))
		.orderBy(asc(section.position));
	return {
		item: it,
		phases: phases.map((p) => ({ ...p, steps: steps.filter((s) => s.phaseId === p.id) })),
		manualChecks: checks,
		decisions,
		sections
	};
}

/** One item with its phases, steps, checks, decisions and sections. Private items answer NOT_FOUND to people who may not see them. */
export async function getItem(ctx: Ctx, nameOrId: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, nameOrId);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${nameOrId}".`);
		return loadDetail(tx, it);
	});
}

export const listItemsInput = z.object({
	project: z.string().min(1),
	status: z
		.array(
			z.enum(['PLANNED', 'IN PROGRESS', 'TESTING', 'IN REVIEW', 'ON HOLD', 'COMPLETED', 'REMOVED'])
		)
		.optional(),
	stream: z.string().max(40).optional(),
	scope: z.string().max(40).optional(),
	/** Matches a reference prefix or words of the title, for the registry filter box. */
	q: z.string().max(100).optional(),
	/** The item number to continue from (keyset paging, so page 200 costs the same as page 1). */
	cursor: z.number().int().optional(),
	order: z.enum(['asc', 'desc']).default('desc'),
	limit: z.number().int().min(1).max(200).default(50),
	trashed: z.boolean().default(false)
});

const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

/** A page of items, newest first by default, by keyset. Items the caller may not see are left out. */
export async function listItems(ctx: Ctx, raw: z.input<typeof listItemsInput>) {
	const input = listItemsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		const { role } = await requireCap(tx, ctx, 'read', proj.id);
		const seeAll = role === 'owner' || role === 'admin';
		const filter = and(
			eq(item.projectId, proj.id),
			input.trashed ? isNotNull(item.deletedAt) : isNull(item.deletedAt),
			input.status?.length ? inArray(item.status, input.status) : undefined,
			input.stream ? eq(item.stream, input.stream) : undefined,
			input.scope ? eq(item.scope, input.scope) : undefined,
			input.q?.trim()
				? sql`(${item.ref} ilike ${escapeLike(input.q.trim()) + '%'} or ${item.title} ilike ${'%' + escapeLike(input.q.trim()) + '%'})`
				: undefined,
			seeAll
				? undefined
				: sql`(${item.visibility} = 'public' or ${item.createdBy} = ${ctx.actor.userId} or ${item.assigneeId} = ${ctx.actor.userId})`
		);
		const where = and(
			filter,
			input.cursor !== undefined
				? input.order === 'desc'
					? lt(item.number, input.cursor)
					: gt(item.number, input.cursor)
				: undefined
		);
		// The first page also says how many items match, so a list can size its scroll bar before the rest is loaded
		const total =
			input.cursor === undefined
				? (
						await tx
							.select({ n: sql<number>`count(*)::int` })
							.from(item)
							.where(filter)
					)[0].n
				: undefined;
		const rows = await tx
			.select()
			.from(item)
			.where(where)
			.orderBy(input.order === 'desc' ? desc(item.number) : asc(item.number))
			.limit(input.limit + 1);
		const page = rows.slice(0, input.limit);
		return {
			items: page,
			nextCursor: rows.length > input.limit ? page[page.length - 1].number : null,
			...(total !== undefined ? { total } : {})
		};
	});
}

export async function updateItem(ctx: Ctx, raw: z.input<typeof updateItemInput>) {
	const input = updateItemInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			const before: Record<string, unknown> = {};
			const after: Record<string, unknown> = {};
			for (const k of PATCHABLE) {
				const v = input[k];
				if (v !== undefined && v !== it[k]) {
					before[k] = it[k];
					after[k] = v;
				}
			}
			if (Object.keys(after).length === 0) return { item: it, changed: false };
			await requireOrgMember(tx, ctx, after.assigneeId as string | null | undefined);
			await requireOrgMember(tx, ctx, after.reviewerId as string | null | undefined);
			const [updated] = await tx
				.update(item)
				.set({
					...after,
					updatedAt: sql`now()`,
					lastActivityAt: sql`now()`,
					version: sql`${item.version} + 1`
				})
				.where(eq(item.id, it.id))
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'item.update',
				targetType: 'item',
				targetId: it.id,
				before: before as never,
				after: after as never
			});
			return { item: updated, changed: true };
		})
	);
}

/** Moves an item to the trash for 30 days. Nothing is lost, and the event can be undone. */
export async function trashItem(ctx: Ctx, nameOrId: string, expectVersion?: number) {
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, nameOrId, { lock: true });
			await requireCap(tx, ctx, 'delete', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, expectVersion);
			await tx
				.update(item)
				.set({
					deletedAt: sql`now()`,
					deletedBy: ctx.actor.userId,
					version: sql`${item.version} + 1`
				})
				.where(eq(item.id, it.id));
			await tx
				.update(task)
				.set({ linkedItemIds: sql`array_remove(${task.linkedItemIds}, ${it.id}::uuid)` })
				.where(sql`${it.id}::uuid = any(${task.linkedItemIds})`);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'item.delete',
				targetType: 'item',
				targetId: it.id,
				before: { title: it.title }
			});
			return { id: it.id, ref: it.ref, trashed: true };
		})
	);
}

export async function restoreItem(ctx: Ctx, nameOrId: string) {
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, nameOrId, { lock: true, includeTrashed: true });
			await requireCap(tx, ctx, 'delete', it.projectId);
			if (!it.deletedAt) return { id: it.id, ref: it.ref, restored: false };
			await tx
				.update(item)
				.set({ deletedAt: null, deletedBy: null, version: sql`${item.version} + 1` })
				.where(eq(item.id, it.id));
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'item.restore',
				targetType: 'item',
				targetId: it.id,
				undoable: false
			});
			return { id: it.id, ref: it.ref, restored: true };
		})
	);
}
