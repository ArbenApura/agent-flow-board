// THE CHECK RUNNERS A PERSON OWNS, FOR THE BRIDGE TAB OF CONNECT A TOOL (AFB-20261115-1000, G.1)
// A runner is a computer the person connected with `agent-flow-board check connect`. The page shows only the caller's own runners:
// a colleague's runner is counted (never named) so the page can say so, and it never completes the caller's checklist tile.
// The device name is shown to its owner only. No token, key or hash comes back.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { runner } from '../db/schema';
import { requireCap, run } from './context';
import { RUNNER_ONLINE_SECONDS } from './environments';

// -- TYPES -- //

export type BridgeRunner = {
	id: string;
	name: string;
	/** Heard from inside the online window. */
	online: boolean;
	lastSeenAt: string | null;
	/** What the tool last reported: how many runs it takes at once and how many it holds. Display only. */
	slots: number | null;
	busy: number | null;
	/** The registrations the tool reports, as plain names only. */
	registrations: { project: string; name: string; repo: string | null; branch: string | null }[];
};

export type BridgeRunners = { mine: BridgeRunner[]; othersOnline: number };

// -- FUNCTIONS -- //

/** Whether a runner was heard from inside the online window. Pure, so it is tested. */
export const isOnline = (lastSeenAt: Date | null, now: Date = new Date()): boolean =>
	!!lastSeenAt && now.getTime() - lastSeenAt.getTime() < RUNNER_ONLINE_SECONDS * 1000;

export async function bridgeRunners(ctx: Ctx): Promise<BridgeRunners> {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const rows = await tx
			.select({
				id: runner.id,
				name: runner.name,
				ownerId: runner.ownerId,
				lastSeenAt: runner.lastSeenAt,
				slots: runner.capacitySlots,
				busy: runner.capacityBusy,
				registrations: runner.registrations
			})
			.from(runner)
			.where(and(eq(runner.orgId, ctx.orgId), eq(runner.kind, 'tool')))
			.orderBy(sql`${runner.lastSeenAt} desc nulls last`);
		const now = new Date();
		const own = rows.filter((r) => r.ownerId === ctx.actor.userId);
		return {
			mine: own.map((r) => ({
				id: r.id,
				name: r.name,
				online: isOnline(r.lastSeenAt, now),
				lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
				slots: r.slots,
				busy: r.busy,
				// The column is jsonb written from a tool header, so an entry that is not a plain object is left out instead of throwing
				registrations: (r.registrations ?? [])
					.filter((g) => !!g && typeof g === 'object' && typeof g.project === 'string')
					.map((g) => ({
						project: g.project,
						name: g.name,
						repo: g.repo ?? null,
						branch: g.branch ?? null
					}))
			})),
			othersOnline: rows.filter(
				(r) => r.ownerId !== ctx.actor.userId && isOnline(r.lastSeenAt, now)
			).length
		};
	});
}
