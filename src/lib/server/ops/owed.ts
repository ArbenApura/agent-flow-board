// OWED LIVE ACTIONS: WHAT A PLAN STILL OWES OUTSIDE ITS CODE, AS A LIST THE BOARD READS (AFB-20261125-1527)
// The section with the slug `owed` holds one checkbox line per action: a migration to apply, a deploy, an owner's check,
// test data to undo, proof still to give. Open lines come back with item_get, and a master shows what its children owe,
// so proof a child still owes is never lost when it closes.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, eq, inArray, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { item, section } from '../db/schema';
import { run } from './context';
import { plainSnippet } from './relatedNotes';

// -- CONSTANTS -- //

export const OWED_SLUG = 'owed';
export const OWED_KINDS = ['migration', 'deploy', 'owner-check', 'test-data', 'proof'] as const;
export type OwedKind = (typeof OWED_KINDS)[number];
/** Only the head of a body is read, and only this many lines come back: an owed list is short by nature. */
const READ_CHARS = 20000;
export const OWED_LINES_MAX = 10;
const CHILDREN_OWED_MAX = 40;
const LINE_CHARS = 300;
// One checkbox line: '- [ ] kind: text' (or '* [ ]'); the kind is a known word, the text one bounded run to the line end
// A long line is read whole and cut afterwards, and the kind is matched in any case
const LINE_RE = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+([a-zA-Z-]{2,20}):[ \t]*([^\n]+)$/gm;

// -- TYPES -- //

export type OwedLine = { kind: OwedKind | 'other'; text: string };

// -- FUNCTIONS -- //

/** The open (unticked) owed lines of a section body, at most ten, plain. A ticked line is done and left out. */
export function parseOwed(body: string | null | undefined, max = OWED_LINES_MAX): OwedLine[] {
	if (!body) return [];
	const out: OwedLine[] = [];
	for (const m of body.slice(0, READ_CHARS).matchAll(LINE_RE)) {
		if (m[1] !== ' ') continue;
		const word = m[2].toLowerCase();
		const kind = (OWED_KINDS as readonly string[]).includes(word) ? (word as OwedKind) : 'other';
		const text = plainSnippet(m[3], LINE_CHARS);
		if (text) out.push({ kind, text });
		if (out.length >= max) break;
	}
	return out;
}

/**
 * The open owed lines of the given child plans, by child ref, ten per child and forty in all. The ids come from the
 * family the caller may already see (loadKids filters by visibility); the query keeps that rule as well.
 */
export async function childrenOwed(
	ctx: Ctx,
	kids: { id: string; ref: string }[]
): Promise<{ ref: string; owed: OwedLine[] }[]> {
	if (!kids.length) return [];
	const rows = await run(ctx, (tx) =>
		tx
			.select({ itemId: section.itemId, body: sql<string>`left(${section.body}, ${READ_CHARS})` })
			.from(section)
			.innerJoin(item, eq(item.id, section.itemId))
			.where(
				and(
					inArray(
						section.itemId,
						kids.map((k) => k.id)
					),
					eq(section.slug, OWED_SLUG),
					sql`${item.deletedAt} is null`,
					sql`(${item.visibility} = 'public' or ${item.createdBy} = ${ctx.actor.userId})`
				)
			)
	);
	const out: { ref: string; owed: OwedLine[] }[] = [];
	let total = 0;
	for (const k of kids) {
		const body = rows.find((r) => r.itemId === k.id)?.body;
		const owed = parseOwed(body, Math.min(OWED_LINES_MAX, CHILDREN_OWED_MAX - total));
		if (!owed.length) continue;
		out.push({ ref: k.ref, owed });
		total += owed.length;
		if (total >= CHILDREN_OWED_MAX) break;
	}
	return out;
}
