// DRIFT CHECKS: A FINISHED PLAN WHOSE NOTES STILL SAY IT WAS NOT BUILT, OWES SOMETHING OR LEARNED NOTHING (AFB-20261125-1527)
// Read by board_validate and /flow-audit. Each finding is a short code, a warning and never an error: the board tells the
// truth, the person decides.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, inArray, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { item, phase, section, step } from '../db/schema';
import { mayView } from './resolve';
import { OWED_SLUG, parseOwed } from './owed';

// -- CONSTANTS -- //

/** The finished plans checked per project when board_validate names none. */
export const RECENT_COMPLETED = 20;
/** Only the first line of resume-here is read: later lines often quote a status or an earlier state. */
const FIRST_LINE_CHARS = 300;
// Words that say the plan was never built, matched on word boundaries in the first line only
const NOT_BUILT =
	/\b(nothing (is |was )?built|not (yet )?started|not (yet )?built|waiting for (a )?go)\b/i;

// -- FUNCTIONS -- //

/** True when the first line of a resume note says the plan was not built. */
export function resumeSaysNotBuilt(body: string | null | undefined): boolean {
	if (!body) return false;
	const first = body.trimStart().split('\n', 1)[0].slice(0, FIRST_LINE_CHARS);
	return NOT_BUILT.test(first);
}

/** The most recently completed plans of every project the caller may see, at most twenty per project. */
export async function recentCompleted(tx: Tx, ctx: Ctx): Promise<(typeof item.$inferSelect)[]> {
	const res = await tx.execute(sql`
		select id from (
			select i.id, row_number() over (partition by i.project_id order by i.updated_at desc) as n
			from item i
			where i.org_id = ${ctx.orgId} and i.status = 'COMPLETED' and i.deleted_at is null
				-- Visibility before the cut, so another person's private plans never take the caller's twenty places
				and (i.visibility = 'public' or i.created_by = ${ctx.actor.userId})
		) r where r.n <= ${RECENT_COMPLETED}
	`);
	const ids = (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
	if (!ids.length) return [];
	const rows = await tx.select().from(item).where(inArray(item.id, ids));
	const seen: typeof rows = [];
	for (const row of rows) if (await mayView(tx, ctx, row)) seen.push(row);
	return seen;
}

/**
 * The drift codes of the given plans:
 * - `resume-stale`: in review or completed, and the first line of resume-here says it was not built
 * - `owed-open`: completed with open lines in the owed section
 * - `completed-without-lessons`: completed with no lessons section (in review already has its own code)
 * - `phase-empty`: a phase with no open or done step and none waived (information only)
 */
export async function driftWarnings(
	tx: Tx,
	rows: { id: string; ref: string; status: string }[]
): Promise<{ ref: string; warning: string }[]> {
	const out: { ref: string; warning: string }[] = [];
	if (!rows.length) return out;
	const ids = rows.map((r) => r.id);
	const notes = await tx
		.select({
			itemId: section.itemId,
			slug: section.slug,
			body: sql<string>`left(${section.body}, 20000)`
		})
		.from(section)
		.where(
			and(
				inArray(section.itemId, ids),
				inArray(section.slug, ['resume-here', 'lessons', OWED_SLUG])
			)
		);
	const empty = await tx
		.select({ itemId: phase.itemId, key: phase.key })
		.from(phase)
		.where(
			and(
				inArray(phase.itemId, ids),
				sql`not exists (select 1 from ${step} s where s.phase_id = ${phase.id} and s.state in ('open', 'done', 'waived'))`
			)
		);
	for (const r of rows) {
		const note = (slug: string) => notes.find((n) => n.itemId === r.id && n.slug === slug);
		const finished = r.status === 'COMPLETED' || r.status === 'IN REVIEW';
		if (finished && resumeSaysNotBuilt(note('resume-here')?.body))
			out.push({ ref: r.ref, warning: 'resume-stale' });
		if (r.status === 'COMPLETED' && parseOwed(note(OWED_SLUG)?.body).length)
			out.push({ ref: r.ref, warning: 'owed-open' });
		if (r.status === 'COMPLETED' && !note('lessons'))
			out.push({ ref: r.ref, warning: 'completed-without-lessons' });
		for (const p of empty.filter((e) => e.itemId === r.id))
			out.push({ ref: r.ref, warning: `phase-empty:${p.key}` });
	}
	return out;
}
