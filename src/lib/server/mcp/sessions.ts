// AGENT SESSIONS (ADR-022). THE SERVER MINTS A SESSION ID AND EVERY TRACKING AND WRITE TOOL TAKES IT,
// SO TWO TOOLS THAT SHARE ONE TOKEN ARE STILL TWO SESSIONS. CLAIMS (ITEM AND PHASE) LIVE ON THE SESSION ROW.

// -- TYPES -- //
import type { Ctx } from '../ops/context';
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
// -- MODULES -- //
import { canonicalTool } from '../../shared/tool';
import { item, phase, session, step } from '../db/schema';
import { OpError, run } from '../ops/context';
import { canSeeItem, findItem } from '../ops/resolve';
import { notifyChange } from '../realtime/notify';
import { logSessionEvent } from '../ops/sessionEvents';
import { QUIET_RELEASE_MINUTES, renewSession } from '../ops/tracking';

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
			.select({
				id: item.id,
				ref: item.ref,
				title: item.title,
				tabName: item.tabName,
				visibility: item.visibility,
				createdBy: item.createdBy
			})
			.from(item)
			.where(eq(item.id, row.claimedItemId));
		// A session never reports an item it may no longer see (the item turned private after the claim)
		it =
			i && canSeeItem(null, i, row.userId)
				? { id: i.id, ref: i.ref, title: i.title, tabName: i.tabName }
				: null;
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
		// A session the hooks made (it has the tool's own conversation id) is made with the bridge's device token, while the MCP
		// calls of the same conversation come with the connector's token. It is still this person's, so it must not be refused
		// (a refusal made the agent start a second session, and the claim and the reminders then lived on different rows).
		// The same holds when the connector's access token is refreshed (every hour, ACCESS_TOKEN_SECONDS): the new token has
		// a new id, but the session is still this person's in this org, so the row follows the token instead of being refused.
		// That refusal was the cause of "Unknown session" in the middle of a long conversation (AFB-20261105-0653).
		if (!row) {
			throw new OpError('INVALID', 'Unknown session. Call session_start again.', {
				needsSession: true
			});
		}
		if (ctx.actor.tokenId && row.tokenId !== ctx.actor.tokenId && !row.externalId) {
			await tx.update(session).set({ tokenId: ctx.actor.tokenId }).where(eq(session.id, row.id));
		}
		// Renewal is written at most once a minute, so a burst of calls costs one write (SPEC 9.2)
		await renewSession(tx, row.id);
		return row;
	});
}

/**
 * The session id on a write tool is missing, unknown or empty: the write goes on under a session of this person and token
 * (the one of the last 12 hours, else a new one), and the reply tells the caller the id to use from now on. A missing id and
 * a foreign id give the same answer, so a session id cannot be probed. The renewed session holds no claim.
 */
export async function renewedSession(
	ctx: Ctx,
	toolName: string
): Promise<typeof session.$inferSelect> {
	return implicitSession(ctx, toolName);
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
			.select({ projectId: item.projectId, itemId: session.claimedItemId })
			.from(session)
			.leftJoin(item, eq(item.id, session.claimedItemId))
			.where(eq(session.id, sessionId));
		const [row] = await tx
			.update(session)
			.set({
				claimedItemId: itemId,
				claimedPhase: phaseOut,
				// A release (work_stop) answers the item question, so the Stop hook does not ask this session to bind again
				...(itemId ? {} : { askedAt: sql`now()` }),
				// Edits made for the item held before are not charged to the new one
				codeEditsSinceRecord: sql`case when ${session.claimedItemId} is distinct from ${itemId}::uuid then 0 else ${session.codeEditsSinceRecord} end`,
				firstUnrecordedEditAt: sql`case when ${session.claimedItemId} is distinct from ${itemId}::uuid then null else ${session.firstUnrecordedEditAt} end`,
				nudgedLevel: sql`case when ${session.claimedItemId} is distinct from ${itemId}::uuid then 0 else ${session.nudgedLevel} end`,
				lastSeenAt: sql`now()`,
				updatedAt: sql`now()`
			})
			.where(eq(session.id, sessionId))
			.returning();
		// An older session of the same person and tool on the same item lets go only after it has been quiet for a while, so a
		// parallel conversation that is still working keeps its claim (one token serves every conversation of a person)
		if (itemId) {
			await tx
				.update(session)
				.set({ claimedItemId: null, claimedPhase: null, updatedAt: sql`now()` })
				.where(
					and(
						eq(session.orgId, ctx.orgId),
						eq(session.claimedItemId, itemId),
						eq(session.userId, row.userId),
						sql`${session.lastSeenAt} < now() - make_interval(mins => ${QUIET_RELEASE_MINUTES})`,
						// Older rows may carry a raw tool name, so compare the family, not the text
						sql`lower(regexp_replace(trim(${session.tool}), '[[:space:]_]+', '-', 'g')) = ${canonicalTool(row.tool)}`,
						ne(session.id, sessionId)
					)
				);
		}
		// The history of the claim: the item let go of (or moved off), then the item taken
		if (before?.itemId && before.itemId !== itemId)
			await logSessionEvent(tx, {
				orgId: ctx.orgId,
				sessionId,
				itemId: before.itemId,
				tool: row.tool,
				kind: 'release',
				detail: itemId ? 'moved to another item' : 'work_stop'
			});
		if (itemId && before?.itemId !== itemId)
			await logSessionEvent(tx, {
				orgId: ctx.orgId,
				sessionId,
				itemId,
				tool: row.tool,
				kind: 'claim',
				detail: phaseOut ? `phase ${phaseOut}` : undefined
			});
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
