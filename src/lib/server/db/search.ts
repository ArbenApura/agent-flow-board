// FULL TEXT SEARCH ACROSS ITEMS, SECTIONS, DECISIONS AND TASKS (SPEC 12, GIN INDEXES ON GENERATED tsvector COLUMNS)

// -- DEP-TYPES -- //
import type { Tx } from './client';
// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';

// -- TYPES -- //

export type SearchHit = {
	kind: 'item' | 'section' | 'decision' | 'task';
	id: string;
	itemId: string | null;
	title: string;
	rank: number;
};

// -- FUNCTIONS -- //

/**
 * Searches inside the current tenant (row level security does the org wall) and an optional project.
 * `websearch_to_tsquery` takes plain words, quotes and minus signs without ever throwing on odd input.
 */
export async function searchAll(
	tx: Tx,
	query: string,
	options: { limit?: number; includeDeleted?: boolean } = {}
): Promise<SearchHit[]> {
	const q = query.trim();
	if (!q) return [];
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
	/** The text with the characters LIKE treats as a pattern made plain. */
	const like = q.replace(/[\\%_]/g, '\\$&');
	const del = options.includeDeleted ? '' : 'and deleted_at is null';
	const res = await tx.execute(sql`
		with q as (select websearch_to_tsquery('simple', ${q}) as tsq)
		-- AN ITEM CAN MATCH BY ITS TEXT, ITS REFERENCE AND AN ALIAS. THE BEST RANK OF EACH HIT IS KEPT BEFORE THE LIMIT, SO THE LIMIT COUNTS DISTINCT HITS
		select * from (
		select distinct on (kind, id) * from (
			select 'item' as kind, id, id as item_id, ref || ' ' || title as title, ts_rank(search_vector, q.tsq) as rank from item, q where search_vector @@ q.tsq ${sql.raw(del)}
			union all
			-- THE EXACT REFERENCE, OR AN ALIAS THE ITEM HAS HAD (THE OLD HAPR-2, A LEGACY FLOW ID), ALWAYS RANKS FIRST. A STAMPED REFERENCE IS LONG AND THE SIMPLE PARSER MAY SPLIT IT, SO THE VECTOR ALONE CANNOT BE TRUSTED FOR IT
			select 'item', i.id, i.id, i.ref || ' ' || i.title, 2.0::real from item i where upper(i.ref) = upper(${q}) ${sql.raw(del.replace('deleted_at', 'i.deleted_at'))}
			union all
			select 'item', i.id, i.id, i.ref || ' ' || i.title, 2.0::real from item_alias a join item i on i.id = a.item_id where upper(a.alias) = upper(${q}) ${sql.raw(del.replace('deleted_at', 'i.deleted_at'))}
			union all
			-- A PART OF A STAMP (THE DATE 20261017 OR THE TIME 0950) IS NOT A WORD TO THE SIMPLE PARSER, SO FOUR CHARACTERS OR MORE ARE ALSO MATCHED INSIDE THE REFERENCE
			select 'item', i.id, i.id, i.ref || ' ' || i.title, 0.05::real from item i where ${like.length >= 4} and i.ref ilike ${'%' + like + '%'} ${sql.raw(del.replace('deleted_at', 'i.deleted_at'))}
			union all
			select 'section', s.id, s.item_id, s.title, ts_rank(s.search_vector, q.tsq) from section s, q where s.search_vector @@ q.tsq
			union all
			select 'decision', d.id, d.item_id, d.title, ts_rank(d.search_vector, q.tsq) from decision d, q where d.search_vector @@ q.tsq
			union all
			select 'task', t.id, null, 'T-' || t.number || ' ' || t.title, ts_rank(t.search_vector, q.tsq) from task t, q where t.search_vector @@ q.tsq ${sql.raw(del.replace('deleted_at', 't.deleted_at'))}
		) u order by kind, id, rank desc
		) hits order by rank desc, title limit ${limit}
	`);
	const hits = (res as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
		kind: r.kind as SearchHit['kind'],
		id: r.id as string,
		itemId: (r.item_id as string | null) ?? null,
		title: r.title as string,
		rank: Number(r.rank)
	}));
	// An item can match by its text and by its name; the best rank comes first, so the first of each is kept
	const seen = new Set<string>();
	return hits.filter((h) => {
		const key = `${h.kind}:${h.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
