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
	const del = options.includeDeleted ? '' : 'and deleted_at is null';
	const res = await tx.execute(sql`
		with q as (select websearch_to_tsquery('simple', ${q}) as tsq)
		select * from (
			select 'item' as kind, id, id as item_id, ref || ' ' || title as title, ts_rank(search_vector, q.tsq) as rank from item, q where search_vector @@ q.tsq ${sql.raw(del)}
			union all
			select 'section', s.id, s.item_id, s.title, ts_rank(s.search_vector, q.tsq) from section s, q where s.search_vector @@ q.tsq
			union all
			select 'decision', d.id, d.item_id, d.title, ts_rank(d.search_vector, q.tsq) from decision d, q where d.search_vector @@ q.tsq
			union all
			select 'task', t.id, null, 'T-' || t.number || ' ' || t.title, ts_rank(t.search_vector, q.tsq) from task t, q where t.search_vector @@ q.tsq ${sql.raw(del.replace('deleted_at', 't.deleted_at'))}
		) hits order by rank desc, title limit ${limit}
	`);
	return (res as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
		kind: r.kind as SearchHit['kind'],
		id: r.id as string,
		itemId: (r.item_id as string | null) ?? null,
		title: r.title as string,
		rank: Number(r.rank)
	}));
}
