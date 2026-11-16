// THE CHECK RUNNERS A PERSON OWNS, FOR THE BRIDGE TAB OF CONNECT A TOOL (AFB-20261115-1000, G.1)
// A runner is a computer the person connected with `agent-flow-board check connect`. The page shows only the caller's own runners:
// a colleague's runner is counted (never named) so the page can say so, and it never completes the caller's checklist tile.
// The device name is shown to its owner only. No token, key or hash comes back.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { checkRun, project, runner } from '../db/schema';
import { OpError, projectAllowed, requireCap, run } from './context';
import { RUNNER_ONLINE_SECONDS } from './environments';
import { findProject } from './resolve';
import { appendOrgEvent } from './settings';

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

export type BridgeRunners = { mine: BridgeRunner[] };

/** One of the caller's own computers in one organisation, as the Your settings page shows it. Never a token, a key or a hash. */
export type MyBridge = {
	id: string;
	name: string;
	online: boolean;
	lastSeenAt: string | null;
	/** The board project keys this computer serves. */
	projects: string[];
};

/** What the caller's own settings page needs for one organisation: their computers there and the web apps they may choose for them. */
export type MyBridges = {
	bridges: MyBridge[];
	webApps: { key: string; name: string }[];
};

export const setMyBridgeProjectsInput = z.object({
	id: z.string().uuid(),
	projects: z.array(z.string().min(1)).max(50)
});

// -- FUNCTIONS -- //

/**
 * The caller's own computers in this organisation and the web apps they may choose for them. A colleague's computer is never listed,
 * counted or named, whoever asks. Called once per organisation by the settings page, so there is no query across tenants.
 */
export async function listMyBridges(ctx: Ctx): Promise<MyBridges> {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const rows = await tx
			.select({
				id: runner.id,
				name: runner.name,
				lastSeenAt: runner.lastSeenAt,
				projectIds: runner.projectIds
			})
			.from(runner)
			.where(
				and(
					eq(runner.orgId, ctx.orgId),
					eq(runner.kind, 'tool'),
					eq(runner.ownerId, ctx.actor.userId)
				)
			)
			.orderBy(asc(runner.name));
		const projects = await tx
			.select({ id: project.id, key: project.key, name: project.name, webApp: project.webApp })
			.from(project)
			.where(eq(project.orgId, ctx.orgId))
			.orderBy(asc(project.key));
		const now = new Date();
		return {
			bridges: rows.map((r) => ({
				id: r.id,
				name: r.name,
				online: isOnline(r.lastSeenAt, now),
				lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
				projects: r.projectIds
					.map((id) => projects.find((p) => p.id === id)?.key ?? '')
					.filter(Boolean)
			})),
			// Only the web apps the person may see, and only those can be checked
			webApps: projects
				.filter((p) => p.webApp && projectAllowed(ctx.actor, p.id))
				.map((p) => ({ key: p.key, name: p.name }))
		};
	});
}

/** Chooses which web apps one of the caller's own computers may check. Only its owner may, with the write permission. */
export async function setMyBridgeProjects(ctx: Ctx, raw: z.input<typeof setMyBridgeProjectsInput>) {
	const input = setMyBridgeProjectsInput.parse(raw);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'write');
		const [r] = await tx
			.select({ id: runner.id, projectIds: runner.projectIds })
			.from(runner)
			.where(
				and(
					eq(runner.id, input.id),
					eq(runner.orgId, ctx.orgId),
					eq(runner.kind, 'tool'),
					eq(runner.ownerId, ctx.actor.userId)
				)
			);
		// A computer of someone else is the same answer as no computer: nothing about it is shown
		if (!r) throw new OpError('NOT_FOUND', 'No such computer of yours.');
		const ids: string[] = [];
		for (const key of input.projects) {
			const p = await findProject(tx, ctx, key);
			await requireCap(tx, ctx, 'write', p.id);
			ids.push(p.id);
		}
		await tx
			.update(runner)
			.set({ projectIds: ids, updatedAt: sql`now()` })
			.where(eq(runner.id, r.id));
		await appendOrgEvent(
			tx,
			ctx,
			'runner.update',
			{ projects: r.projectIds.length },
			{ projects: ids.length }
		);
		return { id: r.id, projects: ids.length };
	});
}

/**
 * Removes one of the caller's own computers from this organisation. Its token stops working at once. A run it still held ends with a
 * plain reason, since nothing is left to give it back to; a run that waits stays for the person's other computer.
 */
export async function removeMyBridge(ctx: Ctx, id: string) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'write');
		const gone = await tx
			.delete(runner)
			.where(
				and(
					eq(runner.id, id),
					eq(runner.orgId, ctx.orgId),
					eq(runner.kind, 'tool'),
					eq(runner.ownerId, ctx.actor.userId)
				)
			)
			.returning({ id: runner.id, name: runner.name });
		if (!gone.length) throw new OpError('NOT_FOUND', 'No such computer of yours.');
		const ended = await tx
			.update(checkRun)
			.set({
				result: 'error',
				finishedAt: sql`now()`,
				reason:
					'This computer was removed from your tools while it held this run. Ask again from another computer.'
			})
			.where(and(eq(checkRun.runnerId, gone[0].id), eq(checkRun.result, 'running')))
			.returning({ id: checkRun.id });
		await appendOrgEvent(tx, ctx, 'runner.delete', { name: gone[0].name }, { ended: ended.length });
		return { deleted: true, ended: ended.length };
	});
}

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
			.where(
				and(
					eq(runner.orgId, ctx.orgId),
					eq(runner.kind, 'tool'),
					// Only the caller's own computers are read, so no colleague's row leaves the database for this page
					eq(runner.ownerId, ctx.actor.userId)
				)
			)
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
			}))
		};
	});
}
