// NOTE LINKS: ONE TABLE HOLDS THEM (note_link). PANEL LINKS ARE CHOSEN BY A PERSON OR AN AGENT, TEXT LINKS ARE WORKED OUT FROM
// THE BODY (AFB-20261111-0035, rule 8). The verbs that call these are in notes.ts.
// Writing: a text link is stored for every target of the same project that exists, whoever saved the note, so a save by
// someone who cannot see a private plan never drops (or adds) a link the author made.
// Reading: what a reader may see is decided when the link is read, from either end. A target the reader cannot see, or that
// is in the trash, is left out; a note that links here is left out of "Mentioned by" the same way.

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { NoteLinkKind } from '../db/schema';
// -- DEP-MODULES -- //
import { and, eq, inArray, sql } from 'drizzle-orm';
// -- MODULES -- //
import { noteNumberOf, noteRef } from '../../shared/notes';
import { extractNoteRefs } from '../../shared/noteLinks';
import { note, noteLink } from '../db/schema';
import { isUuid, visibleNoteSql } from './resolve';

// -- TYPES -- //

/** A target found by the reader's eyes: its row id, its reference (null for a mockup) and its title. */
export type SeenTarget = { kind: NoteLinkKind; id: string; ref: string | null; title: string };

// -- FUNCTIONS -- //

const rowsOf = <T>(res: unknown) => (res as { rows: T[] }).rows;
const uuids = (ids: string[]) =>
	sql.join(
		ids.map((i) => sql`${i}::uuid`),
		sql`, `
	);
const texts = (xs: string[]) =>
	sql.join(
		xs.map((i) => sql`${i}`),
		sql`, `
	);

/**
 * The rows of one project that exist and that a name points at: a reference or an id for a plan, T-n or an id for a task,
 * N-n or an id for a note, an id for a mockup. A target in the trash still exists (it comes back with a restore); reads leave
 * it out. Nothing here looks at who is asking.
 */
export async function findLinkTargets(
	tx: Tx,
	projectId: string,
	wanted: { kind: NoteLinkKind; ref: string }[]
): Promise<{ kind: NoteLinkKind; id: string }[]> {
	const found: { kind: NoteLinkKind; id: string }[] = [];
	const of = (kind: NoteLinkKind) => wanted.filter((w) => w.kind === kind).map((w) => w.ref.trim());
	const ids = (list: string[]) => list.filter(isUuid);
	// -- plans -- //
	const items = of('item');
	if (items.length) {
		const byId = ids(items);
		const refs = items.filter((r) => !isUuid(r)).map((r) => r.toUpperCase());
		const res = await tx.execute(sql`
			select id from item where project_id = ${projectId}::uuid and (
				${refs.length ? sql`upper(ref) in (${texts(refs)})` : sql`false`}
				or ${byId.length ? sql`id in (${uuids(byId)})` : sql`false`})`);
		for (const r of rowsOf<{ id: string }>(res)) found.push({ kind: 'item', id: r.id });
	}
	// -- tasks and notes (T-n, N-n or an id) -- //
	for (const [kind, table] of [
		['task', 'task'],
		['note', 'note']
	] as const) {
		const list = of(kind);
		if (!list.length) continue;
		const byId = ids(list);
		const numbers = list
			.filter((r) => !isUuid(r))
			.map((r) => (kind === 'note' ? noteNumberOf(r) : Number(/^T-([1-9]\d{0,8})$/i.exec(r)?.[1])))
			.filter((n): n is number => !!n && Number.isInteger(n));
		if (!numbers.length && !byId.length) continue;
		const res = await tx.execute(sql`
			select id from ${sql.raw(table)} where project_id = ${projectId}::uuid and (
				${
					numbers.length
						? sql`number in (${sql.join(
								numbers.map((n) => sql`${n}`),
								sql`, `
							)})`
						: sql`false`
				}
				or ${byId.length ? sql`id in (${uuids(byId)})` : sql`false`})`);
		for (const r of rowsOf<{ id: string }>(res)) found.push({ kind, id: r.id });
	}
	// -- mockups -- //
	const mockups = ids(of('mockup'));
	if (mockups.length) {
		const res = await tx.execute(
			sql`select id from mockup where project_id = ${projectId}::uuid and id in (${uuids(mockups)})`
		);
		for (const r of rowsOf<{ id: string }>(res)) found.push({ kind: 'mockup', id: r.id });
	}
	return found;
}

/**
 * Brings the text links of a note in line with its body, as a difference: links to targets the body now names are added,
 * links to targets it no longer names are removed. Call it only when the body changed (create, update, checkpoint). A
 * reference to another project, or to nothing, links nothing. Panel links are not touched.
 */
export async function syncNoteTextLinks(
	tx: Tx,
	row: { id: string; orgId: string; projectId: string },
	body: string,
	userId: string | null
): Promise<{ added: number; removed: number }> {
	const refs = extractNoteRefs(body);
	const wanted = refs.length ? await findLinkTargets(tx, row.projectId, refs) : [];
	// A note naming itself is not a link
	const want = new Map(
		wanted
			.filter((t) => !(t.kind === 'note' && t.id === row.id))
			.map((t) => [`${t.kind}:${t.id}`, t])
	);
	const have = await tx
		.select({ id: noteLink.id, kind: noteLink.targetKind, target: noteLink.targetId })
		.from(noteLink)
		.where(and(eq(noteLink.noteId, row.id), eq(noteLink.source, 'text')));
	const haveKeys = new Set(have.map((h) => `${h.kind}:${h.target}`));
	const gone = have.filter((h) => !want.has(`${h.kind}:${h.target}`)).map((h) => h.id);
	const fresh = [...want.entries()].filter(([k]) => !haveKeys.has(k)).map(([, t]) => t);
	if (gone.length) await tx.delete(noteLink).where(inArray(noteLink.id, gone));
	if (fresh.length)
		await tx
			.insert(noteLink)
			.values(
				fresh.map((t) => ({
					orgId: row.orgId,
					projectId: row.projectId,
					noteId: row.id,
					targetKind: t.kind,
					targetId: t.id,
					source: 'text' as const,
					createdBy: userId
				}))
			)
			.onConflictDoNothing();
	return { added: fresh.length, removed: gone.length };
}

/**
 * The targets, out of the ones given, that this reader may see now: a plan that is not in the trash and is shared or the
 * reader's own, a task that is not in the trash, a mockup that is not in the trash and follows its plan (the plan's creator
 * when it has one), a note the reader may see under the note rules.
 */
export async function seeTargets(
	tx: Tx,
	userId: string,
	wanted: { kind: NoteLinkKind; id: string }[]
): Promise<Map<string, SeenTarget>> {
	const out = new Map<string, SeenTarget>();
	const of = (kind: NoteLinkKind) => [
		...new Set(wanted.filter((w) => w.kind === kind).map((w) => w.id))
	];
	const put = (t: SeenTarget) => out.set(`${t.kind}:${t.id}`, t);
	const items = of('item');
	if (items.length)
		for (const r of rowsOf<{ id: string; ref: string; title: string }>(
			await tx.execute(sql`
				select id, ref, title from item
				where id in (${uuids(items)}) and deleted_at is null and (visibility = 'public' or created_by = ${userId})`)
		))
			put({ kind: 'item', id: r.id, ref: r.ref, title: r.title });
	const tasks = of('task');
	if (tasks.length)
		for (const r of rowsOf<{ id: string; number: number; title: string }>(
			await tx.execute(
				sql`select id, number, title from task where id in (${uuids(tasks)}) and deleted_at is null`
			)
		))
			put({ kind: 'task', id: r.id, ref: `T-${r.number}`, title: r.title });
	const mockups = of('mockup');
	if (mockups.length)
		for (const r of rowsOf<{ id: string; title: string }>(
			await tx.execute(sql`
				select m.id, m.title from mockup m left join item p on p.id = m.item_id
				where m.id in (${uuids(mockups)}) and m.trashed_at is null and (p.id is null or p.deleted_at is null)
					and (m.visibility = 'public' or coalesce(p.created_by, m.created_by) = ${userId})`)
		))
			put({ kind: 'mockup', id: r.id, ref: null, title: r.title });
	const notes = of('note');
	if (notes.length)
		for (const r of await tx
			.select({ id: note.id, number: note.number, title: note.title })
			.from(note)
			.where(and(inArray(note.id, notes), visibleNoteSql(userId))))
			put({ kind: 'note', id: r.id, ref: noteRef(r.number), title: r.title });
	return out;
}

const KIND_ORDER: NoteLinkKind[] = ['item', 'task', 'mockup', 'note'];

/** What one note links to and what links to it, for this reader. */
export async function readNoteLinks(tx: Tx, noteId: string, userId: string) {
	const rows = await tx
		.select({ kind: noteLink.targetKind, target: noteLink.targetId, source: noteLink.source })
		.from(noteLink)
		.where(eq(noteLink.noteId, noteId));
	const seen = await seeTargets(
		tx,
		userId,
		rows.map((r) => ({ kind: r.kind, id: r.target }))
	);
	const sources = new Map<string, Set<string>>();
	for (const r of rows) {
		const key = `${r.kind}:${r.target}`;
		if (!seen.has(key)) continue;
		sources.set(key, (sources.get(key) ?? new Set()).add(r.source));
	}
	const links = [...sources.entries()]
		.map(([key, s]) => ({ ...seen.get(key)!, sources: [...s].sort() }))
		.sort(
			(a, b) =>
				KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title)
		);
	const mentioned = await tx
		.selectDistinct({
			id: note.id,
			number: note.number,
			title: note.title,
			updatedAt: note.updatedAt
		})
		.from(noteLink)
		.innerJoin(note, eq(note.id, noteLink.noteId))
		.where(
			and(eq(noteLink.targetKind, 'note'), eq(noteLink.targetId, noteId), visibleNoteSql(userId))
		);
	const mentionedBy = mentioned
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.map((m) => ({ id: m.id, ref: noteRef(m.number), title: m.title }));
	return { links, mentionedBy, counts: { links: links.length, mentionedBy: mentionedBy.length } };
}

/** The notes that link to one plan, task, mockup or note, among those this reader may see, newest change first. */
export async function readNotesLinkedTo(
	tx: Tx,
	kind: NoteLinkKind,
	targetId: string,
	userId: string
) {
	const rows = await tx
		.selectDistinct({
			id: note.id,
			number: note.number,
			title: note.title,
			folderId: note.folderId,
			updatedAt: note.updatedAt
		})
		.from(noteLink)
		.innerJoin(note, eq(note.id, noteLink.noteId))
		.where(
			and(eq(noteLink.targetKind, kind), eq(noteLink.targetId, targetId), visibleNoteSql(userId))
		);
	return rows
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
		.map((r) => ({
			id: r.id,
			ref: noteRef(r.number),
			title: r.title,
			folderId: r.folderId,
			updatedAt: r.updatedAt
		}));
}

/** How many notes this reader may see link to each of the given targets of one kind. Targets with none are left out. */
export async function countNotesLinkedTo(
	tx: Tx,
	kind: NoteLinkKind,
	targetIds: string[],
	userId: string,
	projectId: string
): Promise<Record<string, number>> {
	if (!targetIds.length) return {};
	const rows = await tx
		.select({
			target: noteLink.targetId,
			count: sql<number>`count(distinct ${note.id})::int`
		})
		.from(noteLink)
		.innerJoin(note, eq(note.id, noteLink.noteId))
		.where(
			and(
				eq(noteLink.targetKind, kind),
				inArray(noteLink.targetId, targetIds),
					// Only the project the role was checked on
					eq(note.projectId, projectId),
				visibleNoteSql(userId)
			)
		)
		.groupBy(noteLink.targetId);
	return Object.fromEntries(rows.map((r) => [r.target, r.count]));
}
