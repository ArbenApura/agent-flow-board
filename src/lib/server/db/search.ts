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

// -- RELATED PLANS -- //

/** Words that carry no meaning for finding a similar plan. The simple search config has no stop words of its own. */
const STOP_WORDS = new Set([
	'the',
	'and',
	'for',
	'with',
	'that',
	'this',
	'from',
	'into',
	'are',
	'was',
	'were',
	'will',
	'can',
	'not',
	'but',
	'all',
	'any',
	'has',
	'have',
	'had',
	'its',
	'our',
	'out',
	'use',
	'used',
	'using',
	'how',
	'when',
	'what',
	'which',
	'should',
	'must',
	'also',
	'than',
	'then',
	'them',
	'they',
	'their',
	'there',
	'these',
	'those',
	'about',
	'after',
	'before',
	'each',
	'more',
	'most',
	'make',
	'made',
	'new',
	'add',
	'plan',
	'plans',
	'item',
	'items',
	'tool',
	'tools'
]);

const MAX_TOKENS = 12;

/** The words and paths of a request as search tokens: lowercase, no stop words, no short words, no repeats, at most twelve. */
export function relatedTokens(q: string, files: string[] = []): string[] {
	const make = (list: string[]) => {
		const out: string[] = [];
		for (const t of list) {
			const word = t.toLowerCase().replace(/^[./-]+|[./-]+$/g, '');
			if (word.length < 3 || STOP_WORDS.has(word) || out.includes(word)) continue;
			out.push(word);
		}
		return out;
	};
	const words: string[] = [];
	for (const m of q.matchAll(/[\p{L}\p{N}_]+(?:[./-][\p{L}\p{N}_]+)*/gu)) {
		words.push(m[0]);
		// A path or a dotted name is also found by its last part
		const last = m[0].split('/').pop() ?? '';
		if (last !== m[0]) words.push(last);
	}
	const paths: string[] = [];
	for (const f of files) {
		const clean = f.trim().replaceAll('\\', '/');
		paths.push(clean, clean.split('/').pop() ?? '');
	}
	// A file named in the request is the strongest signal, so the words never push it out of the twelve
	const fileTokens = make(paths).slice(0, 6);
	const room = MAX_TOKENS - fileTokens.length;
	let wordTokens = make(words).filter((w) => !fileTokens.includes(w));
	if (wordTokens.length > room) {
		// Longer words are usually the more specific ones: keep those, in the order they were written
		const keep = new Set(
			wordTokens
				.map((w, i) => ({ w, i }))
				.sort((a, b) => b.w.length - a.w.length || a.i - b.i)
				.slice(0, room)
				.map((x) => x.i)
		);
		wordTokens = wordTokens.filter((_, i) => keep.has(i));
	}
	return [...wordTokens, ...fileTokens];
}

export type RelatedRow = {
	itemId: string;
	/** How many of the distinct search tokens this plan matched. */
	matched: number;
	score: number;
	/** The sections and decisions that matched, best first. */
	docs: { kind: 'item' | 'section' | 'decision'; id: string }[];
};

/**
 * Items that match any of the tokens, grouped per item in SQL so the limit counts plans and not sections. Each token goes
 * through `plainto_tsquery` as a bound value, so no input can break the query. Only items the caller may see, in the given
 * projects and not trashed, are read. Titles weigh more than bodies. A path token also matches inside a section body, so a
 * file named by its last part is found.
 */
export async function searchRelated(
	tx: Tx,
	tokens: string[],
	options: { projectIds: string[]; userId: string; excludeItemId?: string | null; limit: number }
): Promise<RelatedRow[]> {
	if (!tokens.length || !options.projectIds.length) return [];
	const toks = sql.join(
		tokens.map((t) => sql`${t}`),
		sql`, `
	);
	// The LIKE pattern of each token is made here, so its own % _ and \ are plain characters and not wildcards
	const pats = sql.join(
		tokens.map((t) => sql`${'%' + t.replace(/[\\%_]/g, '\\$&') + '%'}`),
		sql`, `
	);
	const projects = sql.join(
		options.projectIds.map((p) => sql`${p}::uuid`),
		sql`, `
	);
	const exclude = options.excludeItemId ? sql`and i.id <> ${options.excludeItemId}::uuid` : sql``;
	// Several words must agree: two of three, and a third of a long request, so two common words alone are not a match
	const minTokens = tokens.length <= 2 ? 1 : Math.max(2, Math.ceil(tokens.length / 3));
	const res = await tx.execute(sql`
		with toks as (select x.t as tok, x.p as pat from unnest(array[${toks}]::text[], array[${pats}]::text[]) as x(t, p)),
		ok as (
			select i.id from item i
			where i.deleted_at is null and i.project_id in (${projects})
				and (i.visibility = 'public' or i.created_by = ${options.userId}) ${exclude}
		),
		docs as (
			select i.id as item_id, 'item'::text as kind, i.id as doc_id, i.search_vector as vec, 3.0::real as w
				from item i where i.id in (select id from ok)
			union all
			select s.item_id, 'section', s.id, s.search_vector,
				case when s.slug in ('lessons', 'resume-here', 'learned-from') then 1.5 else 1.0 end
				from section s where s.item_id in (select id from ok)
			union all
			select d.item_id, 'decision', d.id, d.search_vector, 2.0 from decision d where d.item_id in (select id from ok)
		),
		pairs as (
			select docs.item_id, docs.kind, docs.doc_id, toks.tok, false as is_path,
				ts_rank(docs.vec, plainto_tsquery('simple', toks.tok)) * docs.w as r
			from docs join toks on docs.vec @@ plainto_tsquery('simple', toks.tok)
			union all
			-- A FILE OR PATH IS ALSO FOUND INSIDE A SECTION BODY, BECAUSE THE PARSER KEEPS A WHOLE PATH AS ONE WORD
			select s.item_id, 'section', s.id, toks.tok, true, 0.5::real
			from toks join section s on s.item_id in (select id from ok)
				and toks.tok ~ '[./]' and length(toks.tok) >= 4
				and s.body ilike toks.pat
		),
		scored as (
			select item_id, count(distinct tok)::int as matched, sum(r)::float8 as score
			from pairs group by item_id
			-- A FILE NAMED IN THE REQUEST IS STRONG ENOUGH ON ITS OWN, EVEN WHEN THE OTHER WORDS DO NOT MATCH
			having count(distinct tok) >= ${minTokens} or bool_or(is_path)
			order by matched desc, score desc
			limit ${options.limit}
		)
		-- THE BEST SIX DISTINCT DOCUMENTS PER PLAN, SO ONE HEAVILY MATCHING SECTION CANNOT TAKE EVERY PLACE
		select s.item_id, s.matched, s.score,
			(select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'id', d.doc_id) order by d.best desc), '[]'::jsonb)
				from (select kind, doc_id, max(r) as best from pairs p where p.item_id = s.item_id group by kind, doc_id order by best desc limit 6) d
			) as docs
		from scored s order by s.matched desc, s.score desc
	`);
	const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows;
	return rows.map((r) => ({
		itemId: r.item_id as string,
		matched: Number(r.matched),
		score: Number(r.score),
		docs: ((r.docs as { kind: RelatedRow['docs'][number]['kind']; id: string }[]) ?? []).filter(
			(d, i, all) => all.findIndex((x) => x.id === d.id) === i
		)
	}));
}
