// SERVER SIDE CALL TIMING (AFB-20261105-0653): ONE ROW PER MCP CALL, WITH THE TOOL, THE DURATION AND THE OUTCOME CODE, SO SLOWNESS CAN BE FOUND WITHOUT READING TRANSCRIPTS.
// A row never holds a payload, an argument or an error message (a message can quote what a person wrote). It is written after the
// call has settled, in its own short transaction, and a failure here is only logged: timing must never break or slow the call it measures.

// -- TYPES -- //
import type { Ctx } from '../ops/context';
// -- DEP-MODULES -- //
import { lt, sql } from 'drizzle-orm';
// -- MODULES -- //
import { mcpCallTiming } from '../db/schema';
import { run } from '../ops/context';
import { findItem, findProject } from '../ops/resolve';

// -- CONSTANTS -- //

/** The tool names a row may hold. Anything else is stored as "other", so a caller cannot put text into the table. */
const TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/;

/** How often a write also sweeps old rows, and how many rows an organisation keeps at most. */
export const SWEEP_CHANCE = 0.01;
const MAX_ROWS = 50_000;

// -- FUNCTIONS -- //

export type CallTiming = {
	tool: string;
	durationMs: number;
	/** `ok` or an OpError code. */
	outcome: string;
	/** What the call named, to find its project: a project key, or an item id or reference. Either may be absent. */
	project?: string;
	item?: string | null;
};

/** Writes one timing row. Never throws. */
export async function recordCallTiming(base: Ctx, t: CallTiming): Promise<void> {
	try {
		await run({ ...base, tx: undefined, requestId: undefined }, async (tx) => {
			let projectId: string | null = null;
			try {
				if (t.project) projectId = (await findProject(tx, base, t.project)).id;
				else if (t.item) projectId = (await findItem(tx, base, t.item)).projectId;
			} catch {
				// A name that does not resolve (a typo, an item the caller cannot see) leaves the row without a project
			}
			await tx.insert(mcpCallTiming).values({
				orgId: base.orgId,
				projectId,
				tool: TOOL_NAME.test(t.tool) ? t.tool : 'other',
				durationMs: Math.max(0, Math.min(Math.round(t.durationMs), 2_000_000_000)),
				outcome: /^[A-Z_]{2,30}$/.test(t.outcome) || t.outcome === 'ok' ? t.outcome : 'INTERNAL'
			});
			// Retention without a job: now and then this org's rows older than the window, or beyond the newest MAX_ROWS, are removed.
			// The tenant context of this transaction limits the delete to this org.
			if (Math.random() < SWEEP_CHANCE) {
				await tx
					.delete(mcpCallTiming)
					.where(lt(mcpCallTiming.createdAt, sql`now() - interval '14 days'`));
				await tx
					.delete(mcpCallTiming)
					.where(
						sql`${mcpCallTiming.id} not in (select id from ${mcpCallTiming} order by id desc limit ${MAX_ROWS})`
					);
			}
		});
	} catch (e) {
		console.error('MCP call timing could not be written', e instanceof Error ? e.name : 'error');
	}
}
