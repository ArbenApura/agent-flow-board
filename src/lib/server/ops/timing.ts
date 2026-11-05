// THE SLOWEST MCP CALLS OF A PROJECT (AFB-20261105-0653): READS WHAT src/lib/server/mcp/timing.ts WRITES. ADMINS ONLY, AND ONLY THE PROJECTS THE TOKEN MAY SEE.

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { mcpCallTiming } from '../db/schema';
import { OpError, projectAllowed, requireCap, run } from './context';
import { findProject } from './resolve';

// -- CONSTANTS -- //

export const slowCallsInput = z.object({
	/** A project key or id. Left out, the whole organisation (refused for a token limited to some projects). */
	project: z.string().min(1).optional(),
	days: z.number().int().min(1).max(14).default(7),
	limit: z.number().int().min(1).max(50).default(15)
});

// -- FUNCTIONS -- //

/** The slowest calls and, per tool, the call count, median, 90th percentile and maximum. */
export async function slowestCalls(ctx: Ctx, raw: z.input<typeof slowCallsInput>) {
	const input = slowCallsInput.parse(raw);
	return run(ctx, async (tx) => {
		let projectId: string | null = null;
		if (input.project) {
			const p = await findProject(tx, ctx, input.project);
			projectId = p.id;
			await requireCap(tx, ctx, 'manage', p.id);
		} else {
			if (ctx.actor.tokenProjects?.length)
				throw new OpError('FORBIDDEN', 'This token is limited to some projects: name one.');
			await requireCap(tx, ctx, 'manage');
		}
		const since = new Date(Date.now() - input.days * 86_400_000);
		const where = and(
			eq(mcpCallTiming.orgId, ctx.orgId),
			gt(mcpCallTiming.createdAt, since),
			projectId ? eq(mcpCallTiming.projectId, projectId) : undefined
		);
		const slowest = await tx
			.select({
				tool: mcpCallTiming.tool,
				durationMs: mcpCallTiming.durationMs,
				outcome: mcpCallTiming.outcome,
				at: mcpCallTiming.createdAt,
				projectId: mcpCallTiming.projectId
			})
			.from(mcpCallTiming)
			.where(where)
			.orderBy(desc(mcpCallTiming.durationMs))
			.limit(input.limit);
		const perTool = await tx
			.select({
				tool: mcpCallTiming.tool,
				calls: sql<number>`count(*)::int`,
				p50: sql<number>`(percentile_cont(0.5) within group (order by ${mcpCallTiming.durationMs}))::int`,
				p90: sql<number>`(percentile_cont(0.9) within group (order by ${mcpCallTiming.durationMs}))::int`,
				max: sql<number>`max(${mcpCallTiming.durationMs})::int`
			})
			.from(mcpCallTiming)
			.where(where)
			.groupBy(mcpCallTiming.tool)
			.orderBy(desc(sql`max(${mcpCallTiming.durationMs})`));
		// A project-less call (session_start) only shows in the whole-organisation view; a token limit hides other projects' rows
		const visible = slowest.filter((r) => !r.projectId || projectAllowed(ctx.actor, r.projectId));
		return { days: input.days, slowest: visible, perTool };
	});
}
