// THE PROJECT HEALTH PANEL: WHAT NEEDS ATTENTION IN ONE PLACE, AND NONE OF IT BLOCKS ANYTHING (SPEC 9.4)
// Stale claims, steps without evidence, quiet items, drift warnings and the failures of backups. Private items are left out for people who may not see them. Every list is capped so the page stays quick.

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, eq, isNull, lt } from 'drizzle-orm';
// -- MODULES -- //
import { backupHealth, type BackupHealth } from '../backup/run';
import { item } from '../db/schema';
import { requireCap, run } from './context';
import { findProject, visibleItemSql } from './resolve';
import { RUNNING_WINDOW_MINUTES, claimsIn, stepsWithoutEvidence } from './tracking';

// -- TYPES -- //

export type Health = Awaited<ReturnType<typeof projectHealth>>;

// -- CONSTANTS -- //

const CAP = 50;
const CLOSED = ['COMPLETED', 'REMOVED'];

// -- FUNCTIONS -- //

/** Everything that needs attention in one project, for the health page. */
export async function projectHealth(ctx: Ctx, projectKey: string, now = new Date()) {
	const base = await run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		const { role, caps } = await requireCap(tx, ctx, 'read', proj.id);
		const visible = visibleItemSql(ctx.actor.userId);
		const inProject = and(eq(item.projectId, proj.id), isNull(item.deletedAt), visible);
		const items = await tx
			.select({
				id: item.id,
				ref: item.ref,
				title: item.title,
				status: item.status,
				drift: item.health,
				lastActivityAt: item.lastActivityAt
			})
			.from(item)
			.where(inProject);
		const byId = new Map(items.map((i) => [i.id, i]));
		const claims = (await claimsIn(tx, proj.id)).filter((c) => byId.has(c.itemId));
		const noEvidence = (await stepsWithoutEvidence(tx, proj.id)).filter((s) => byId.has(s.itemId));
		const quietBefore = new Date(now.getTime() - proj.staleDays * 86_400_000);
		const quiet = await tx
			.select({ id: item.id, ref: item.ref, title: item.title, last: item.lastActivityAt })
			.from(item)
			.where(and(inProject, eq(item.status, 'IN PROGRESS'), lt(item.lastActivityAt, quietBefore)))
			.orderBy(item.lastActivityAt)
			.limit(CAP);
		return {
			proj,
			role,
			caps,
			items,
			byId,
			claims,
			noEvidence,
			quiet
		};
	});

	const idleCutoff = now.getTime() - RUNNING_WINDOW_MINUTES * 60_000;
	const refOf = (id: string) => base.byId.get(id)?.ref ?? '';
	// Only a server that makes backups can have a late one, so a server without them shows nothing here
	const backup: BackupHealth | null =
		base.caps.includes('manage') && ctx.services?.backups
			? await backupHealth(ctx.handle, ctx.orgId, now)
			: null;
	return {
		project: { key: base.proj.key, name: base.proj.name, staleDays: base.proj.staleDays },
		// A claim is listed when it is idle or its item closed, or when it left finished work unrecorded past the nudge time
		staleClaims: base.claims
			.filter(
				(c) =>
					c.lastSeenAt.getTime() < idleCutoff ||
					CLOSED.includes(c.status) ||
					c.staleMinutes !== null
			)
			.map((c) => {
				const idle = c.lastSeenAt.getTime() < idleCutoff || CLOSED.includes(c.status);
				return {
					sessionId: c.sessionId,
					tool: c.tool,
					itemRef: c.ref,
					phase: c.phase,
					lastSeenAt: c.lastSeenAt,
					kind: idle ? ('idle' as const) : ('unrecorded' as const),
					reason: CLOSED.includes(c.status)
						? 'The item is closed.'
						: c.lastSeenAt.getTime() < idleCutoff
							? `Not seen for ${Math.round((now.getTime() - c.lastSeenAt.getTime()) / 60_000)} minutes.`
							: `Work left unrecorded for ${c.staleMinutes} minutes. Record the finished steps.`
				};
			}),
		stepsWithoutEvidence: base.noEvidence.map((s) => ({
			itemRef: refOf(s.itemId),
			key: s.key,
			text: s.text,
			target: s.target
		})),
		quietItems: base.quiet.map((q) => ({
			ref: q.ref,
			title: q.title,
			days: Math.floor((now.getTime() - q.last.getTime()) / 86_400_000)
		})),
		drift: base.items
			.filter((i) => i.drift.drift.length > 0)
			.slice(0, CAP)
			.map((i) => ({ ref: i.ref, title: i.title, status: i.status, codes: i.drift.drift })),
		backup
	};
}
