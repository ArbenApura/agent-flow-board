// ITEM VERBS: CREATE, READ, LIST, UPDATE, TRASH AND RESTORE (SPEC 5)

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { allocateItemNumber } from '../db/numbering';
import { RefSuffixesTaken, freeRefs, insertItemWithFreshRef } from '../db/flowId';
import { recalcItem } from '../db/calc';
import { appendEvent } from '../db/events';
import { syncMockupsOfItem } from '../db/mockupSync';
import {
	decision,
	item,
	itemAlias,
	manualCheck,
	member,
	phase,
	section,
	step,
	task,
	user
} from '../db/schema';
import { tabNameSchema } from '../db/zod';
import { tabNameFromTitle } from '../../shared/tabName';
import {
	OpError,
	idempotent,
	isLivePersonSession,
	rateLimit,
	requireCap,
	requireOrgMember,
	run
} from './context';
import { enforcePlanRules } from './planRules';
import { canSeeItem, findItem, findProject, visibleItemSql } from './resolve';
import { releaseOthersClaimsOn, requireCloseConfirmation } from './tracking';

// -- TYPES -- //

export type ItemRow = typeof item.$inferSelect;

// -- CONSTANTS -- //

/** Where an item goes when its creator names no stream or scope, and what project_rules reports for a project with none set. */
export const DEFAULT_STREAM = 'features';
export const DEFAULT_SCOPE = 'core';
/** An item with the same title as one made this recently in the project is refused as a likely duplicate. */
export const DUPLICATE_TITLE_WINDOW_MS = 10 * 60_000;

const stepIn = z.object({
	key: z
		.string()
		// The same rule as step_done, step_update and plan_add_steps, so a step saved here can always be recorded later
		.regex(
			/^[0-9A-Za-z]+\.[0-9]+[a-z]?$/,
			'A step key looks like 1.1: the phase key, a dot and the step number'
		)
		.optional(),
	text: z.string().min(1).max(2000),
	requiredTarget: z.enum(['dev', 'preview', 'deployed']).nullable().optional(),
	visible: z.boolean().nullable().optional(),
	files: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
	screens: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
	widths: z.array(z.number().int().min(200).max(4000)).max(10).optional()
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
	stream: z.string().min(1).max(40).default(DEFAULT_STREAM),
	scope: z.string().min(1).max(40).default(DEFAULT_SCOPE),
	visibility: z.enum(['public', 'private']).default('public'),
	branchNote: z.string().max(500).nullish(),
	assigneeId: z.string().nullish(),
	sliceGate: z.boolean().default(false),
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
	reviewerId: z.string().nullable().optional(),
	sliceGate: z.boolean().optional()
});

const PATCHABLE = [
	'title',
	'tabName',
	'stream',
	'scope',
	'visibility',
	'branchNote',
	'assigneeId',
	'reviewerId',
	'sliceGate'
] as const;

// -- FUNCTIONS -- //

export { canSeeItem };

const refsExhausted = () =>
	new OpError('CONFLICT', 'Every suffix for this minute is taken. Wait a minute and retry.');

/**
 * The first alias that equals, in any case, one of the references this item may take (the first free one, or a later one if a
 * concurrent create wins the first) or the reference of an item of the org.
 */
async function aliasClash(
	tx: Tx,
	orgId: string,
	aliases: string[],
	ownRefs: string[]
): Promise<string | null> {
	if (!aliases.length) return null;
	const mine = new Set(ownRefs.map((r) => r.toUpperCase()));
	const own = aliases.find((a) => mine.has(a.toUpperCase()));
	if (own) return own;
	const upper = aliases.map((a) => a.toUpperCase());
	const [hit] = await tx
		.select({ ref: item.ref })
		.from(item)
		.where(and(eq(item.orgId, orgId), inArray(sql`upper(${item.ref})`, upper)))
		.limit(1);
	return hit ? (aliases.find((a) => a.toUpperCase() === hit.ref.toUpperCase()) ?? hit.ref) : null;
}

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

/**
 * Creates an item. Its reference is the project key and the creation minute in UTC (HAPR-20261017-0950, -b when the minute is taken).
 * `now` is for tests that fix the clock; it is not part of the input, so a caller of the API cannot set it.
 */
export async function createItem(ctx: Ctx, raw: CreateItemInput, options: { now?: Date } = {}) {
	const input = createItemInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			await rateLimit(tx, ctx, 'create');
			await requireOrgMember(tx, ctx, input.assigneeId);
			// The project's own plan rules (forbidden wording, no browser steps) refuse the plan before anything is written
			await enforcePlanRules(tx, proj.id, {
				texts: [
					input.title,
					...input.phases.flatMap((p) => [p.title, ...p.steps.map((x) => x.text)]),
					...input.manualChecks.map((c) => c.text)
				],
				browser:
					input.phases.some((p) => p.steps.some((x) => !!x.requiredTarget)) ||
					input.manualChecks.some((c) => !!c.auto)
			});
			// The window is measured on the real clock because created_at comes from the database, not from options.now.
			// An agent that creates the same title again soon after is almost always retrying a write that failed, so it is refused.
			// A person in the web app may name two items alike on purpose, so only calls that come from a tool are checked
			const [twin] = ctx.actor.tool
				? await tx
						.select({ ref: item.ref })
						.from(item)
						.where(
							and(
								eq(item.projectId, proj.id),
								isNull(item.deletedAt),
								// A private item the caller cannot see neither blocks nor is named in the refusal
								visibleItemSql(ctx.actor.userId),
								sql`lower(btrim(${item.title})) = lower(btrim(${input.title}))`,
								gt(item.createdAt, new Date(Date.now() - DUPLICATE_TITLE_WINDOW_MS))
							)
						)
						.limit(1)
				: [];
			if (twin)
				throw new OpError(
					'CONFLICT',
					`${twin.ref} already has this title and was created in the last ${DUPLICATE_TITLE_WINDOW_MS / 60_000} minutes. Continue that item, or give the new one a different title.`,
					{ existingRef: twin.ref }
				);
			if (
				!isLivePersonSession(ctx) &&
				input.phases.some((p) => p.steps.some((s) => s.visible === false))
			) {
				throw new OpError(
					'FORBIDDEN',
					'Only a person in a live web session can mark a step as not visible.'
				);
			}
			const { number } = await allocateItemNumber(tx, ctx.orgId, proj.id);
			const candidates = await freeRefs(tx, ctx.orgId, proj.key, options.now ?? new Date());
			if (!candidates.length) throw refsExhausted();
			// An alias that equals the reference of an item would be shadowed by it, so it is refused
			const clash = await aliasClash(tx, ctx.orgId, input.aliases, candidates);
			if (clash)
				throw new OpError(
					'INVALID',
					`"${clash}" is already the reference of an item, so it cannot be an alias.`
				);
			let created: ItemRow;
			try {
				created = await insertItemWithFreshRef(tx, candidates, {
					orgId: ctx.orgId,
					projectId: proj.id,
					number,
					title: input.title,
					tabName: input.tabName ?? tabNameFromTitle(input.title),
					stream: input.stream,
					scope: input.scope,
					visibility: input.visibility,
					branchNote: input.branchNote ?? null,
					assigneeId: input.assigneeId ?? null,
					sliceGate: input.sliceGate,
					createdBy: ctx.actor.userId
				});
			} catch (error) {
				if (error instanceof RefSuffixesTaken) throw refsExhausted();
				throw error;
			}
			const ref = created.ref;
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
						visible: s.visible ?? null,
						files: s.files ?? [],
						screens: s.screens ?? [],
						widths: s.widths ?? [],
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

/**
 * Who made the item, as a name only: no id and no email leave here. The name is read through the org's own members, so a
 * person who left the org, or an item with no creator (a system write), gives null.
 */
async function loadCreator(tx: Tx, orgId: string, it: ItemRow): Promise<{ name: string } | null> {
	if (!it.createdBy) return null;
	const [c] = await tx
		.select({ name: user.name })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(and(eq(member.orgId, orgId), eq(member.userId, it.createdBy)));
	return c ? { name: c.name } : null;
}

async function loadDetail(tx: Tx, ctx: Ctx, it: ItemRow) {
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
		creator: await loadCreator(tx, ctx.orgId, it),
		/** Only the person who made the item may change who sees it, so the page asks the server and never compares ids. */
		canSetVisibility: !!ctx.actor?.userId && it.createdBy === ctx.actor.userId,
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
		return loadDetail(tx, ctx, it);
	});
}

export const listItemsInput = z.object({
	project: z.string().min(1),
	status: z
		.array(z.enum(['PLANNED', 'IN PROGRESS', 'IN REVIEW', 'ON HOLD', 'COMPLETED', 'REMOVED']))
		.optional(),
	stream: z.string().max(40).optional(),
	scope: z.string().max(40).optional(),
	/** Matches a reference prefix or words of the title, for the registry filter box. */
	q: z.string().max(100).optional(),
	/** The item number to continue from (keyset paging, so page 200 costs the same as page 1). */
	cursor: z.number().int().optional(),
	order: z.enum(['asc', 'desc']).default('desc'),
	/** 'activity' puts the most recently touched first (newest only, the cursor is still the last item's number). */
	sort: z.enum(['number', 'activity']).default('number'),
	limit: z.number().int().min(1).max(200).default(50),
	trashed: z.boolean().default(false)
});

const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');

/** A page of items, newest first by default, by keyset. Items the caller may not see are left out. */
export async function listItems(ctx: Ctx, raw: z.input<typeof listItemsInput>) {
	const input = listItemsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		const filter = and(
			eq(item.projectId, proj.id),
			input.trashed ? isNotNull(item.deletedAt) : isNull(item.deletedAt),
			input.status?.length ? inArray(item.status, input.status) : undefined,
			input.stream ? eq(item.stream, input.stream) : undefined,
			input.scope ? eq(item.scope, input.scope) : undefined,
			input.q?.trim()
				? sql`(${item.ref} ilike ${escapeLike(input.q.trim()) + '%'} or ${item.title} ilike ${'%' + escapeLike(input.q.trim()) + '%'} or exists (select 1 from item_alias a where a.item_id = ${item.id} and a.alias ilike ${escapeLike(input.q.trim()) + '%'}))`
				: undefined,
			visibleItemSql(ctx.actor.userId)
		);
		const where = and(
			filter,
			input.cursor === undefined
				? undefined
				: input.sort === 'activity'
					? // Rows after the cursor item in (last activity, number) order, read from the cursor item itself
						sql`(${item.lastActivityAt}, ${item.number}) < (select c.last_activity_at, c.number from item c where c.project_id = ${proj.id} and c.number = ${input.cursor})`
					: input.order === 'desc'
						? lt(item.number, input.cursor)
						: gt(item.number, input.cursor)
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
			.orderBy(
				...(input.sort === 'activity'
					? [desc(item.lastActivityAt), desc(item.number)]
					: [input.order === 'desc' ? desc(item.number) : asc(item.number)])
			)
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
			// Who may see an item is the creator's to change, so a patch that carries a different visibility is refused whole
			if (
				input.visibility !== undefined &&
				input.visibility !== it.visibility &&
				it.createdBy !== ctx.actor.userId
			)
				throw new OpError(
					'FORBIDDEN',
					'Only the person who created this item can make it private or public.'
				);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, input.expectVersion);
			if (!isLivePersonSession(ctx) && input.sliceGate === false && it.sliceGate) {
				throw new OpError(
					'FORBIDDEN',
					'Only a person in a live web session can turn off the vertical-slice gate.'
				);
			}
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
			// Other people's sessions that were working on the item lose the claim the moment it turns private
			if (after.visibility === 'private')
				await releaseOthersClaimsOn(tx, ctx, updated, it.createdBy);
			// Its mockups take the same visibility, and a private plan turns their public links off
			if (after.visibility)
				await syncMockupsOfItem(tx, it.id, {
					visibility: after.visibility as 'public' | 'private'
				});
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'item.update',
				targetType: 'item',
				targetId: it.id,
				before: before as never,
				after: after as never,
				...(Object.hasOwn(after, 'sliceGate') ? { undoable: false } : {})
			});
			return { item: updated, changed: true };
		})
	);
}

/** Moves an item to the trash for 30 days. Nothing is lost, and the event can be undone. */
export async function trashItem(
	ctx: Ctx,
	nameOrId: string,
	expectVersion?: number,
	confirmed?: boolean
) {
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, nameOrId, { lock: true });
			await requireCap(tx, ctx, 'delete', it.projectId);
			await rateLimit(tx, ctx, 'write');
			checkVersion(it, expectVersion);
			// An agent trashing an item its session is not bound to is asked first, like a close
			await requireCloseConfirmation(tx, ctx, it, confirmed);
			await tx
				.update(item)
				.set({
					deletedAt: sql`now()`,
					deletedBy: ctx.actor.userId,
					version: sql`${item.version} + 1`
				})
				.where(eq(item.id, it.id));
			await syncMockupsOfItem(tx, it.id, { trashed: true });
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
