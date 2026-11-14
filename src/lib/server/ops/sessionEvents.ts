// THE HISTORY OF A SESSION'S CLAIMS AND REMINDERS: WHEN IT CLAIMED, LET GO, WAS REMINDED AT STOP, WAS NUDGED AND ENDED
// The session row is overwritten in place, so how long a claim lasted and how often a session was reminded could not be told
// afterwards. This log only appends. It is how a later change to the hooks or the prompts is measured.

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { sessionEvent } from '../db/schema';
import { requireCap, run } from './context';
import { findItem } from './resolve';

// -- TYPES -- //

export type SessionEventKind =
	'claim' | 'release' | 'stop_reminder' | 'nudge' | 'end' | 'waiting_set' | 'waiting_clear';

// -- CONSTANTS -- //

export const listSessionEventsInput = z.object({
	item: z.string().min(1),
	limit: z.number().int().min(1).max(500).default(200)
});

// -- FUNCTIONS -- //

/** Appends one event inside the caller's transaction. Never throws: a failed log line must not fail the claim or the hook. */
export async function logSessionEvent(
	tx: Tx,
	e: {
		orgId: string;
		sessionId: string;
		itemId: string | null;
		tool: string | null;
		kind: SessionEventKind;
		detail?: string;
	}
): Promise<void> {
	try {
		await tx.transaction(async (inner) => {
			await inner.insert(sessionEvent).values({
				orgId: e.orgId,
				sessionId: e.sessionId,
				itemId: e.itemId,
				tool: e.tool,
				kind: e.kind,
				detail: e.detail?.slice(0, 200) ?? null
			});
		});
	} catch {
		// The savepoint rolled back; the caller's work goes on
	}
}

/**
 * The claim history of one item, oldest first, with how long each claim lasted (in minutes) when it was released or the
 * session ended. A claim still open has no duration.
 */
export async function listSessionEvents(ctx: Ctx, raw: z.input<typeof listSessionEventsInput>) {
	const input = listSessionEventsInput.parse(raw);
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, input.item);
		await requireCap(tx, ctx, 'read', it.projectId);
		const rows = await tx
			.select()
			.from(sessionEvent)
			.where(eq(sessionEvent.itemId, it.id))
			.orderBy(asc(sessionEvent.id))
			.limit(input.limit);
		const openedAt = new Map<string, Date>();
		const events = rows.map((r) => {
			let minutes: number | null = null;
			if (r.kind === 'claim') openedAt.set(r.sessionId, r.createdAt);
			if (r.kind === 'release' || r.kind === 'end') {
				const started = openedAt.get(r.sessionId);
				if (started) {
					minutes = Math.round((r.createdAt.getTime() - started.getTime()) / 60_000);
					openedAt.delete(r.sessionId);
				}
			}
			return {
				id: r.id,
				sessionId: r.sessionId,
				tool: r.tool,
				kind: r.kind,
				detail: r.detail,
				at: r.createdAt,
				minutes
			};
		});
		return { item: it.ref, events };
	});
}
