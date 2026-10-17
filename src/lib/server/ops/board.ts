// READ VERBS BUILT FOR THE BOARD PAGES: ONE CALL PER PAGE, COUNTS FROM THE DATABASE, NOTHING THE VIEWER MAY NOT SEE (SPEC 11, 12)
// They sit in the operations layer so the web app, REST and MCP read the same rules. Private items are left out of every
// count, list and search hit for people who may not see them.

// -- TYPES -- //
import type { Running } from '../../board/rows';
import type { Ctx } from './context';
import type { Role } from '../orgs/roles';
// -- DEP-MODULES -- //
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
// -- MODULES -- //
import { event, item, member, project, projectMember, session, task } from '../db/schema';
import { searchAll } from '../db/search';
import { listMembers } from '../orgs/orgs';
import { effectiveProjectRole } from '../orgs/roles';
import { OpError, requireCap, run } from './context';
import { listAttachments } from './attachments';
import { listComments } from './docs';
import { listEvents } from './history';
import { pinnedProjectIds } from './pins';
import { canSeeItem, getItem } from './items';
import { findProject, visibleItemSql } from './resolve';
import { unrecordedCommits } from './tracking';

// -- CONSTANTS -- //

/** A session counts as running while it was seen within this time (Phase 9 settles stale sessions for good). */
export const RUNNING_WINDOW_MINUTES = 120;

// -- FUNCTIONS -- //

async function runningIn(
	tx: Parameters<Parameters<typeof run>[1]>[0],
	projectId: string,
	userId: string
): Promise<Running[]> {
	const rows = await tx
		.select({
			itemId: item.id,
			itemRef: item.ref,
			tabName: item.tabName,
			phase: session.claimedPhase,
			tool: session.tool,
			sessionId: session.id
		})
		.from(session)
		.innerJoin(item, eq(item.id, session.claimedItemId))
		.where(
			and(
				eq(item.projectId, projectId),
				isNull(item.deletedAt),
				sql`${session.lastSeenAt} > now() - make_interval(mins => ${RUNNING_WINDOW_MINUTES})`,
				visibleItemSql(userId)
			)
		)
		.orderBy(sql`${session.lastSeenAt} desc`);
	// Two sessions of one tool on the same item and phase show one badge, the newest wins
	const seen = new Set<string>();
	return rows
		.filter((r) => {
			const key = `${r.itemId}|${r.phase ?? ''}|${r.tool}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((r) => ({
			itemId: r.itemId,
			itemRef: r.itemRef,
			phase: r.phase,
			tool: r.tool,
			title: `${r.tabName ?? 'ITEM'}: ${r.itemRef}`,
			sessionId: r.sessionId
		}));
}

/** Counts by status and by area for a project, and who is running now. One transaction, a few index scans. */
export async function projectSummary(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		const { role, caps } = await requireCap(tx, ctx, 'read', proj.id);
		const base = and(
			eq(item.projectId, proj.id),
			isNull(item.deletedAt),
			visibleItemSql(ctx.actor.userId)
		);
		const byStatusRows = await tx
			.select({ status: item.status, n: sql<number>`count(*)::int` })
			.from(item)
			.where(base)
			.groupBy(item.status);
		const areaRows = await tx
			.select({ stream: item.stream, scope: item.scope, n: sql<number>`count(*)::int` })
			.from(item)
			.where(base)
			.groupBy(item.stream, item.scope)
			.orderBy(item.stream, item.scope);
		const byStatus: Record<string, number> = {};
		let total = 0;
		for (const r of byStatusRows) {
			byStatus[r.status] = r.n;
			total += r.n;
		}
		return {
			project: proj,
			role,
			caps,
			total,
			byStatus,
			areas: areaRows,
			running: await runningIn(tx, proj.id, ctx.actor.userId)
		};
	});
}

/**
 * Everything the org home needs: each project the person can see, with its counts, how many sessions are running, whether
 * the person pinned it, when it was made and when a visible item last changed.
 */
export async function orgOverview(ctx: Ctx) {
	return run(ctx, async (tx) => {
		const [m] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, ctx.orgId), eq(member.userId, ctx.actor.userId)));
		if (!m) throw new OpError('FORBIDDEN', 'You are not a member of this organisation.');
		const projects = await tx
			.select()
			.from(project)
			.where(eq(project.orgId, ctx.orgId))
			.orderBy(project.key);
		const overrides = await tx
			.select()
			.from(projectMember)
			.where(eq(projectMember.userId, ctx.actor.userId));
		const visible = projects
			.map((p) => ({
				p,
				role: effectiveProjectRole(
					m.role,
					overrides.find((o) => o.projectId === p.id)?.role ?? null
				)
			}))
			.filter((x) => x.role !== null);
		const ids = visible.map((x) => x.p.id);
		if (!ids.length) return [];
		// Pins of projects the person can no longer see are never returned: only visible projects are looked up
		const pins = await pinnedProjectIds(tx, ctx);
		const counts = await tx
			.select({
				projectId: item.projectId,
				status: item.status,
				visibility: item.visibility,
				createdBy: item.createdBy,
				n: sql<number>`count(*)::int`,
				lastChange: sql<Date | null>`max(${item.updatedAt})`
			})
			.from(item)
			.where(and(inArray(item.projectId, ids), isNull(item.deletedAt)))
			.groupBy(item.projectId, item.status, item.visibility, item.createdBy);
		const out = [];
		for (const { p, role } of visible) {
			const byStatus: Record<string, number> = {};
			let total = 0;
			let lastActivityAt: Date | null = null;
			for (const c of counts.filter((c) => c.projectId === p.id)) {
				if (!canSeeItem(role, c, ctx.actor.userId)) continue;
				byStatus[c.status] = (byStatus[c.status] ?? 0) + c.n;
				total += c.n;
				// Only items the person may see move this, so a private item never shows through
				const changed = c.lastChange ? new Date(c.lastChange) : null;
				if (changed && (!lastActivityAt || changed > lastActivityAt)) lastActivityAt = changed;
			}
			const running = await runningIn(tx, p.id, ctx.actor.userId);
			out.push({
				project: p,
				role: role!,
				total,
				byStatus,
				running: running.length,
				pinned: pins.has(p.id),
				createdAt: p.createdAt,
				lastActivityAt
			});
		}
		return out;
	});
}

/** The part of an item page that shows first: the plan, decisions, documents, who is running it, and the people's names. */
export async function itemCore(ctx: Ctx, nameOrId: string) {
	const detail = await getItem(ctx, nameOrId);
	const [summary, members, unrecorded] = await Promise.all([
		projectSummary(ctx, detail.item.projectId),
		listMembers(ctx.handle, ctx.orgId),
		run(ctx, (tx) => unrecordedCommits(tx, [detail.item.id]))
	]);
	return {
		...detail,
		/** Commits of this item nobody recorded a step for, newest first (SPEC 9.4). */
		unrecorded: unrecorded.map((c) => ({
			sha: c.sha,
			message: c.message.split('\n')[0] ?? '',
			at: c.committedAt ?? c.createdAt
		})),
		project: summary.project,
		role: summary.role,
		caps: summary.caps,
		running: summary.running.filter((r) => r.itemId === detail.item.id),
		/** Names for the authors of comments and the people on the item. */
		people: Object.fromEntries(members.map((m) => [m.userId, m.name]))
	};
}

/** The part that can arrive after the first paint: discussion, files and recent activity. */
export async function itemExtras(ctx: Ctx, it: { id: string; projectId: string }) {
	const [comments, attachments, events] = await Promise.all([
		listComments(ctx, it.id),
		listAttachments(ctx, it.id),
		listEvents(ctx, { project: it.projectId, item: it.id, limit: 30 })
	]);
	return { comments, attachments, events };
}

/** One item page in a single call, for callers that want everything at once. */
export async function itemPage(ctx: Ctx, nameOrId: string) {
	const core = await itemCore(ctx, nameOrId);
	const extras = await itemExtras(ctx, core.item);
	return { ...core, ...extras };
}

export type SearchResult = {
	kind: 'item' | 'section' | 'decision' | 'task';
	id: string;
	title: string;
	/** Where the hit leads: an item reference and its project key, or a task number. */
	itemRef: string | null;
	projectKey: string;
	rank: number;
};

/** Search across items, sections, decisions and tasks, limited to what the caller may see and to one project when given. */
export async function searchBoard(
	ctx: Ctx,
	query: string,
	options: { project?: string; limit?: number } = {}
): Promise<SearchResult[]> {
	return run(ctx, async (tx) => {
		const hits = await searchAll(tx, query, { limit: (options.limit ?? 30) * 3 });
		if (!hits.length) return [];
		const itemIds = [...new Set(hits.map((h) => h.itemId).filter((v): v is string => !!v))];
		const taskIds = hits.filter((h) => h.kind === 'task').map((h) => h.id);
		const items = itemIds.length
			? await tx
					.select({
						id: item.id,
						ref: item.ref,
						projectId: item.projectId,
						visibility: item.visibility,
						createdBy: item.createdBy,
						deletedAt: item.deletedAt
					})
					.from(item)
					.where(inArray(item.id, itemIds))
			: [];
		const tasks = taskIds.length
			? await tx
					.select({ id: task.id, projectId: task.projectId })
					.from(task)
					.where(inArray(task.id, taskIds))
			: [];
		const projectIds = [...new Set([...items, ...tasks].map((x) => x.projectId))];
		const projects = projectIds.length
			? await tx.select().from(project).where(inArray(project.id, projectIds))
			: [];
		// The caller's role per project, once each. A project they cannot read drops every hit inside it.
		const roles = new Map<string, string | null>();
		for (const p of projects) {
			try {
				roles.set(p.id, (await requireCap(tx, ctx, 'read', p.id)).role);
			} catch {
				roles.set(p.id, null);
			}
		}
		const keyOf = new Map(projects.map((p) => [p.id, p.key]));
		const only = options.project?.toUpperCase();
		const out: SearchResult[] = [];
		for (const h of hits) {
			const it = h.itemId ? items.find((i) => i.id === h.itemId) : undefined;
			// The sections and decisions of a trashed item are gone with it
			if (it?.deletedAt) continue;
			const tk = h.kind === 'task' ? tasks.find((t) => t.id === h.id) : undefined;
			const projectId = it?.projectId ?? tk?.projectId;
			const role = projectId ? roles.get(projectId) : null;
			if (!projectId || !role) continue;
			if (it && !canSeeItem(role as Role, it, ctx.actor.userId)) continue;
			const projectKey = keyOf.get(projectId)!;
			if (only && projectKey.toUpperCase() !== only) continue;
			out.push({
				kind: h.kind,
				id: h.id,
				title: h.title,
				itemRef: it?.ref ?? null,
				projectKey,
				rank: h.rank
			});
			if (out.length >= (options.limit ?? 30)) break;
		}
		return out;
	});
}

/**
 * May this person still read the project, and the item a change touched? Asked when a stream opens and on every change,
 * so a removed member or a demoted guest stops receiving at the next event (SPEC 11).
 */
export async function mayReceive(ctx: Ctx, projectId: string, itemId?: string | null) {
	try {
		return await run(ctx, async (tx) => {
			const { role } = await requireCap(tx, ctx, 'read', projectId);
			if (!itemId) return true;
			const [it] = await tx
				.select({
					visibility: item.visibility,
					createdBy: item.createdBy
				})
				.from(item)
				.where(eq(item.id, itemId));
			// A deleted item is gone for everyone, and the stream only tells pages to refetch
			return !it || canSeeItem(role, it, ctx.actor.userId);
		});
	} catch (e) {
		if (e instanceof OpError) return false;
		throw e;
	}
}

/** The newest event id of a project, so a stream can tell a page where "now" is. */
export async function latestEventId(ctx: Ctx, projectId: string): Promise<number> {
	return run(ctx, async (tx) => {
		const [row] = await tx
			.select({ id: sql<number>`coalesce(max(${event.id}), 0)::int` })
			.from(event)
			.where(eq(event.projectId, projectId));
		return row?.id ?? 0;
	});
}

/** References of items by id, for pages that show links (tasks, the activity log). Private items stay hidden from people who may not see them. */
export async function refsFor(
	ctx: Ctx,
	projectKey: string,
	ids: string[]
): Promise<Record<string, string>> {
	const wanted = [...new Set(ids)];
	if (!wanted.length) return {};
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		const { role } = await requireCap(tx, ctx, 'read', proj.id);
		const rows = await tx
			.select({
				id: item.id,
				ref: item.ref,
				visibility: item.visibility,
				createdBy: item.createdBy
			})
			.from(item)
			.where(and(inArray(item.id, wanted), eq(item.projectId, proj.id)));
		return Object.fromEntries(
			rows.filter((r) => canSeeItem(role, r, ctx.actor.userId)).map((r) => [r.id, r.ref])
		);
	});
}
