// THE SETUP CHECKLIST OF CONNECT A TOOL: WHAT THE CALLER HAS MARKED DONE OR SKIPPED, IN ONE ORGANISATION (AFB-20261115-1000, H.4)
// Personal. A mark belongs to the person who made it: the table's row security names the org and the person on a read and on a write,
// and the verbs here never take a user id from the caller. Reading the organisation is enough to keep your own checklist, so a viewer
// or a guest can mark their own too. Nothing the board can know by itself is stored: only what the person said.

// IMPORTED DEP-TYPES
import type { z } from 'zod';
// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, eq } from 'drizzle-orm';
// IMPORTED MODULES
import { connectSetupMark } from '../db/schema';
import { connectSetupMarkInput } from '../db/zod';
import { requireCap, run } from './context';

// -- TYPES -- //

export type SetupMarks = {
	/** The tiles the person marked, as done or skipped. */
	marks: Record<string, 'done' | 'skipped'>;
	/** Whether the person folded or opened the checklist, or null when they never chose. */
	panel: 'open' | 'closed' | null;
};

// -- FUNCTIONS -- //

export async function listMySetupMarks(ctx: Ctx): Promise<SetupMarks> {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const rows = await tx
			.select({ key: connectSetupMark.key, state: connectSetupMark.state })
			.from(connectSetupMark)
			.where(
				and(eq(connectSetupMark.orgId, ctx.orgId), eq(connectSetupMark.userId, ctx.actor.userId))
			);
		const out: SetupMarks = { marks: {}, panel: null };
		for (const r of rows) {
			if (r.key === 'panel') out.panel = r.state === 'closed' ? 'closed' : 'open';
			else if (r.state === 'done' || r.state === 'skipped') out.marks[r.key] = r.state;
		}
		return out;
	});
}

/** Marks one tile (or the panel) for the caller. A null state clears it. The answer is the caller's marks as they now stand. */
export async function setMySetupMark(
	ctx: Ctx,
	raw: z.input<typeof connectSetupMarkInput>
): Promise<SetupMarks> {
	const input = connectSetupMarkInput.parse(raw);
	await run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		if (input.state === null) {
			await tx
				.delete(connectSetupMark)
				.where(
					and(
						eq(connectSetupMark.orgId, ctx.orgId),
						eq(connectSetupMark.userId, ctx.actor.userId),
						eq(connectSetupMark.key, input.key)
					)
				);
			return;
		}
		await tx
			.insert(connectSetupMark)
			.values({
				orgId: ctx.orgId,
				userId: ctx.actor.userId,
				key: input.key,
				state: input.state
			})
			.onConflictDoUpdate({
				target: [connectSetupMark.orgId, connectSetupMark.userId, connectSetupMark.key],
				set: { state: input.state, updatedAt: new Date() }
			});
	});
	return listMySetupMarks(ctx);
}
