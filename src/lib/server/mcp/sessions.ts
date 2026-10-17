// AGENT SESSIONS (ADR-022). THE SERVER MINTS A SESSION ID AND EVERY TRACKING AND WRITE TOOL TAKES IT,
// SO TWO TOOLS THAT SHARE ONE TOKEN ARE STILL TWO SESSIONS. CLAIMS (ITEM AND PHASE) LIVE ON THE SESSION ROW.

// -- TYPES -- //
import type { Ctx } from '../ops/context';
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { item, phase, session, step } from '../db/schema';
import { OpError, run } from '../ops/context';
import { findItem } from '../ops/resolve';
import { notifyChange } from '../realtime/notify';
import { renewSession } from '../ops/tracking';

// -- CONSTANTS -- //

export const SESSION_PREFIX = 's_';

// -- FUNCTIONS -- //

/** The title a session shows: TAB_NAME: REF, for example ROOM_TYPES: HAPR-20261017-0950 (SPEC 7.1). */
export const displayTitle = (tabName: string | null, ref: string) => `${tabName ?? 'ITEM'}: ${ref}`;

export type SessionInfo = {
	sessionId: string;
	tool: string;
	item: { id: string; ref: string; title: string; tabName: string | null } | null;
	phase: string | null;
	displayTitle: string | null;
};

async function describe(
	tx: Parameters<Parameters<typeof run>[1]>[0],
	row: typeof session.$inferSelect
): Promise<SessionInfo> {
	let it: SessionInfo['item'] = null;
	if (row.claimedItemId) {
		const [i] = await tx
			.select({ id: item.id, ref: item.ref, title: item.title, tabName: item.tabName })
			.from(item)
			.where(eq(item.id, row.claimedItemId));
		it = i ?? null;
	}
	return {
		sessionId: row.id,
		tool: row.tool,
		item: it,
		phase: row.claimedPhase,
		displayTitle: it ? displayTitle(it.tabName, it.ref) : null
	};
}

/** Mints a session for the calling token. The tool name is what the activity log and the board show. */
export async function startSession(
	ctx: Ctx,
	input: { tool: string; label?: string }
): Promise<SessionInfo> {
	const id = SESSION_PREFIX + randomBytes(12).toString('base64url');
	return run(ctx, async (tx) => {
		const [row] = await tx
			.insert(session)
			.values({
				id,
				orgId: ctx.orgId,
				userId: ctx.actor.userId,
				tokenId: ctx.actor.tokenId ?? null,
				tool: input.tool.slice(0, 60),
				label: input.label ?? null
			})
			.returning();
		return describe(tx, row);
	});
}

/**
 * Checks a presented session id. It must exist, in this org, made by this person (and token). An unknown or foreign
 * id is the same answer, so session ids cannot be probed.
 */
export async function requireSession(
	ctx: Ctx,
	sessionId: string | undefined
): Promise<typeof session.$inferSelect> {
	if (!sessionId)
		throw new OpError(
			'INVALID',
			'Call session_start first and pass its sessionId on every tracking and write tool.',
			{ needsSession: true }
		);
	return run(ctx, async (tx) => {
		const [row] = await tx
			.select()
			.from(session)
			.where(
				and(
					eq(session.id, sessionId),
					eq(session.orgId, ctx.orgId),
					eq(session.userId, ctx.actor.userId)
				)
			);
		if (!row || (ctx.actor.tokenId && row.tokenId && row.tokenId !== ctx.actor.tokenId)) {
			throw new OpError('INVALID', 'Unknown session. Call session_start again.', {
				needsSession: true
			});
		}
		// Renewal is written at most once a minute, so a burst of calls costs one write (SPEC 9.2)
		await renewSession(tx, row.id);
		return row;
	});
}

/** Binds a session to an item (and the phase being worked), or releases it with a null item. Returns the title to show. */
export async function claim(
	ctx: Ctx,
	sessionId: string,
	nameOrId: string | null,
	phaseKey?: string
): Promise<SessionInfo & { nextOpen: { key: string; text: string }[] }> {
	await requireSession(ctx, sessionId);
	return run(ctx, async (tx) => {
		let itemId: string | null = null;
		let projectId: string | null = null;
		let phaseOut: string | null = null;
		let nextOpen: { key: string; text: string }[] = [];
		if (nameOrId) {
			const it = await findItem(tx, ctx, nameOrId);
			itemId = it.id;
			projectId = it.projectId;
			const open = await tx
				.select({ key: step.key, text: step.text, phaseKey: phase.key })
				.from(step)
				.innerJoin(phase, eq(phase.id, step.phaseId))
				.where(and(eq(step.itemId, it.id), eq(step.state, 'open')))
				.orderBy(phase.position, step.position);
			phaseOut = phaseKey ?? open[0]?.phaseKey ?? null;
			nextOpen = open
				.filter((s) => !phaseOut || s.phaseKey === phaseOut)
				.slice(0, 3)
				.map(({ key, text }) => ({ key, text }));
			if (!nextOpen.length) nextOpen = open.slice(0, 3).map(({ key, text }) => ({ key, text }));
		}
		// The project of the item this session held before, so its Running badge clears on the open pages
		const [before] = await tx
			.select({ projectId: item.projectId })
			.from(session)
			.leftJoin(item, eq(item.id, session.claimedItemId))
			.where(eq(session.id, sessionId));
		const [row] = await tx
			.update(session)
			.set({
				claimedItemId: itemId,
				claimedPhase: phaseOut,
				lastSeenAt: sql`now()`,
				updatedAt: sql`now()`
			})
			.where(eq(session.id, sessionId))
			.returning();
		for (const p of new Set([projectId, before?.projectId].filter((v): v is string => !!v)))
			await notifyChange(tx, { o: ctx.orgId, p, k: 'claim', i: itemId });
		return { ...(await describe(tx, row)), nextOpen };
	});
}

/**
 * The session the compatibility verbs use when the caller never passed one (they have no sessionId field).
 * One per token and tool, reused for 12 hours, so a tool that only knows the old verbs still gets a stable session.
 */
export async function implicitSession(
	ctx: Ctx,
	toolName: string
): Promise<typeof session.$inferSelect> {
	return run(ctx, async (tx) => {
		const recent = await tx
			.select()
			.from(session)
			.where(
				and(
					eq(session.orgId, ctx.orgId),
					eq(session.userId, ctx.actor.userId),
					ctx.actor.tokenId ? eq(session.tokenId, ctx.actor.tokenId) : undefined,
					eq(session.tool, toolName),
					sql`${session.lastSeenAt} > now() - interval '12 hours'`
				)
			)
			.orderBy(sql`${session.lastSeenAt} desc`)
			.limit(1);
		if (recent[0]) {
			await tx
				.update(session)
				.set({ lastSeenAt: sql`now()` })
				.where(eq(session.id, recent[0].id));
			return recent[0];
		}
		const [row] = await tx
			.insert(session)
			.values({
				id: SESSION_PREFIX + randomBytes(12).toString('base64url'),
				orgId: ctx.orgId,
				userId: ctx.actor.userId,
				tokenId: ctx.actor.tokenId ?? null,
				tool: toolName
			})
			.returning();
		return row;
	});
}
