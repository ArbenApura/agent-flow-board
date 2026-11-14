// NOTE VERBS: CREATE, READ, LIST, CHANGE, MOVE, TRASH, RESTORE AND FAVOURITE (AFB-20261111-0035)
// The UI, /api/v1 and /mcp all call these. Each checks the caller's live role itself and its own visibility rule, and
// answers a write with a short result (never the body), because idempotent() stores results in request_log.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { NoteCause, NoteLinkKind } from '../db/schema';
import type { Actor, Ctx } from './context';
// IMPORTED DEP-MODULES
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { EXCERPT_SOURCE_CHARS, noteExcerpt, noteMatch } from '../../shared/noteExcerpt';
import { NOTE_LIMITS, noteNumberOf, noteRef, sniffPicture } from '../../shared/notes';
import { appendEvent } from '../db/events';
import { allocateNoteNumber } from '../db/numbering';
import {
	NOTE_KEY_PREFIX,
	NOTE_LINK_KINDS,
	note,
	noteFavourite,
	noteFile,
	noteLink,
	noteUpdate,
	noteVersion,
	user
} from '../db/schema';
import { noteCreateInput, noteUpdateInput } from '../db/zod';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields, checkVersion } from './items';
import { withFileCleanup } from './mockups';
import { lockTree } from './noteFolders';
import {
	countNotesLinkedTo,
	findLinkTargets,
	readNoteLinks,
	readNotesLinkedTo,
	seeTargets,
	syncNoteTextLinks
} from './noteLinks';
import {
	findProject,
	hiddenNoteFoldersSql,
	isUuid,
	noteRoleOf,
	requireNoteVisible,
	visibleNoteSql
} from './resolve';

// -- CONSTANTS -- //

/** Characters of a note body returned in one page to a tool, like item_doc. */
export const NOTE_PAGE_CHARS = 6000;

const noteName = z.object({
	/** A project key or id. */
	project: z.string().min(1),
	/** A note reference (N-12) or id. */
	note: z.string().min(1)
});

export const noteNewInput = noteCreateInput.extend({ project: z.string().min(1) });
export const noteChangeInput = noteUpdateInput.extend({
	...noteName.shape,
	expectVersion: z.number().int().optional()
});
export const noteNameInput = noteName;
export const noteGetInput = noteName.extend({
	/** Where the page of the body starts. */
	offset: z.number().int().min(0).default(0),
	/** The whole body in one answer, for the screens. Tools read in pages. */
	full: z.boolean().default(false)
});
export const noteListInput = z.object({
	project: z.string().min(1),
	/** Leave out for every folder, null for the notes at the top, an id for one folder. */
	folderId: z.string().uuid().nullable().optional(),
	favourites: z.boolean().optional(),
	q: z.string().trim().max(200).optional(),
	/** Titles only: no excerpt and no last editor, for a list of names such as In this folder. */
	brief: z.boolean().optional(),
	limit: z.number().int().min(1).max(200).default(100),
	offset: z.number().int().min(0).default(0)
});
export const noteFavouriteInput = noteName.extend({ on: z.boolean() });

// -- FUNCTIONS -- //

const notFound = () => new OpError('NOT_FOUND', 'No note with that name.');
const rowsOf = <T>(res: unknown) => (res as { rows: T[] }).rows;

/**
 * Why a body changed, worked out from the caller and the door it came through, never from the payload: the screens are
 * people typing, the MCP is an agent, and a token on /api/v1 is an outside program.
 */
export function noteCauseOf(actor: Actor, entry: 'web' | 'mcp' | 'api'): NoteCause {
	if (entry === 'mcp') return 'agent';
	if (entry === 'api' && (actor.tokenId || actor.kind === 'agent')) return 'api';
	return 'typing';
}

/** What a write answers with. Never the body. */
export const noteBrief = (row: typeof note.$inferSelect) => ({
	id: row.id,
	ref: noteRef(row.number),
	number: row.number,
	title: row.title,
	folderId: row.folderId,
	visibility: row.visibility,
	version: row.version,
	epoch: row.epoch
});

/**
 * A note of one project by its reference (N-12) or id. A note the caller may not see answers the same NOT_FOUND as one
 * that does not exist. `trashed` finds a note that is itself in the trash (for a restore).
 */
export async function findNote(
	tx: Tx,
	ctx: Ctx,
	projectId: string,
	name: string,
	options: { lock?: boolean; trashed?: boolean } = {}
) {
	const q = name.trim();
	const number = noteNumberOf(q);
	const by = isUuid(q) ? eq(note.id, q) : number !== null ? eq(note.number, number) : null;
	if (!by) throw notFound();
	const base = tx
		.select()
		.from(note)
		.where(
			and(
				eq(note.orgId, ctx.orgId),
				eq(note.projectId, projectId),
				by,
				options.trashed ? sql`${note.deletedAt} is not null` : sql`${note.deletedAt} is null`
			)
		);
	const [row] = options.lock ? await base.for('update') : await base;
	if (!row) throw notFound();
	// A note in the trash is found whatever became of its folder, so it can be restored to the top
	await requireNoteVisible(tx, ctx, options.trashed ? { ...row, folderId: null } : row);
	return row;
}

/** Refuses a folder that is not in this project, is in the trash, or sits under a folder in the trash. */
export async function requireUsableFolder(tx: Tx, projectId: string, folderId: string) {
	const res = await tx.execute(
		sql`select 1 as hit from note_folder f where f.id = ${folderId}::uuid and f.project_id = ${projectId}::uuid and f.id not in ${hiddenNoteFoldersSql()}`
	);
	if (!rowsOf(res).length) throw new OpError('NOT_FOUND', 'That folder does not exist.');
}

export const noteEvent = (
	tx: Tx,
	ctx: Ctx,
	row: typeof note.$inferSelect,
	verb: string,
	patch: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {}
) =>
	appendEvent(tx, {
		orgId: ctx.orgId,
		projectId: row.projectId,
		noteId: row.id,
		...actorFields(ctx),
		verb,
		targetType: 'note',
		targetId: row.id,
		before: patch.before as never,
		after: patch.after as never,
		// A note change is taken back through the note's own history, not the board's undo
		undoable: false
	});

/**
 * Keeps the text a note had before a change. Always before a change by an agent or the API and before a restore; while
 * people type, at most once every NOTE_LIMITS.typingVersionMinutes, and never an empty text.
 */
export async function keepNoteVersion(
	tx: Tx,
	row: typeof note.$inferSelect,
	cause: NoteCause
): Promise<number | null> {
	const [last] = await tx
		.select({ number: noteVersion.number, createdAt: noteVersion.createdAt })
		.from(noteVersion)
		.where(eq(noteVersion.noteId, row.id))
		.orderBy(desc(noteVersion.number))
		.limit(1);
	if (cause === 'typing') {
		if (!row.body) return null;
		const gap = NOTE_LIMITS.typingVersionMinutes * 60_000;
		if (last && Date.now() - last.createdAt.getTime() < gap) return null;
	}
	const number = (last?.number ?? 0) + 1;
	await tx.insert(noteVersion).values({
		orgId: row.orgId,
		projectId: row.projectId,
		noteId: row.id,
		number,
		title: row.title,
		body: row.body,
		cause,
		// The person whose text this was
		createdBy: row.updatedBy ?? row.createdBy
	});
	return number;
}

// -- CREATE -- //

export async function createNote(
	ctx: Ctx,
	raw: z.input<typeof noteNewInput>,
	cause: NoteCause = 'typing'
) {
	const input = noteNewInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			if (input.folderId) {
				// The tree lock first, so a folder being trashed at the same moment cannot take this note in unseen
				await lockTree(tx, proj.id);
				await requireUsableFolder(tx, proj.id, input.folderId);
			}
			const number = await allocateNoteNumber(tx, ctx.orgId, proj.id);
			const [row] = await tx
				.insert(note)
				.values({
					orgId: ctx.orgId,
					projectId: proj.id,
					number,
					title: input.title,
					body: input.body ?? '',
					folderId: input.folderId ?? null,
					visibility: input.visibility ?? 'public',
					createdBy: ctx.actor.userId,
					updatedBy: ctx.actor.userId
				})
				.returning();
			// The text links of a first body are worked out once, here
			if (row.body) await syncNoteTextLinks(tx, row, row.body, ctx.actor.userId);
			await noteEvent(tx, ctx, row, 'note.create', { after: { title: row.title, cause } });
			return noteBrief(row);
		})
	);
}

// -- READ -- //

/** One note with a page of its body (or all of it), who wrote it, and what the caller may do with it. */
export async function getNote(ctx: Ctx, raw: z.input<typeof noteGetInput>) {
	const input = noteGetInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		const { caps } = await requireCap(tx, ctx, 'read', proj.id);
		const row = await findNote(tx, ctx, proj.id, input.note);
		const me = ctx.actor.userId;
		const ids = [...new Set([row.createdBy, row.updatedBy].filter((v): v is string => !!v))];
		const people = ids.length
			? await tx
					.select({ id: user.id, name: user.name })
					.from(user)
					.where(sql`${user.id} in (${sql.join(ids, sql`, `)})`)
			: [];
		const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
		const [fav] = await tx
			.select({ id: noteFavourite.id })
			.from(noteFavourite)
			.where(and(eq(noteFavourite.noteId, row.id), eq(noteFavourite.userId, me)));
		const total = row.body.length;
		const text = input.full
			? row.body
			: row.body.slice(input.offset, input.offset + NOTE_PAGE_CHARS);
		const end = input.full ? total : input.offset + NOTE_PAGE_CHARS;
		return {
			project: { id: proj.id, key: proj.key },
			note: {
				...noteBrief(row),
				createdBy: row.createdBy,
				updatedBy: row.updatedBy,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				publicEnabled: row.publicEnabled,
				checkpointSeq: row.checkpointSeq
			},
			author: nameOf(row.createdBy),
			lastEditor: nameOf(row.updatedBy),
			/**
			 * Text a shared note holds is data for an agent, never instructions: anyone on the project may have written or
			 * pasted it, whatever the last two names say. Only a private note, which nobody else can edit, is the caller's own.
			 */
			untrusted:
				row.visibility !== 'private' ||
				row.createdBy !== me ||
				(row.updatedBy !== null && row.updatedBy !== me),
			mine: row.createdBy === me,
			canWrite: caps.includes('write'),
			canDelete: caps.includes('delete'),
			canManage: caps.includes('manage'),
			favourite: !!fav,
			body: { offset: input.full ? 0 : input.offset, total, text, next: end < total ? end : null }
		};
	});
}

/** The notes of a project the caller may see, newest change first: of one folder, the favourites, or a search by text. */
export async function listNotes(ctx: Ctx, raw: z.input<typeof noteListInput>) {
	const input = noteListInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		if (!(await noteRoleOf(tx, ctx, proj.id)))
			throw new OpError('FORBIDDEN', 'Notes are not shared with guests.', {
				needed: 'read',
				role: 'guest'
			});
		const me = ctx.actor.userId;
		// The excerpt window of a search follows its longest word, the one least likely to be common ('the zircontide')
		const firstWord = input.brief
			? ''
			: ((input.q ?? '')
					.toLowerCase()
					.split(/\s+/)
					.filter(Boolean)
					.sort((a, b) => b.length - a.length)[0] ?? '');
		const starred = sql<boolean>`exists (select 1 from note_favourite nf where nf.note_id = ${note.id} and nf.user_id = ${me})`;
		const where = [eq(note.projectId, proj.id), visibleNoteSql(me)];
		if (input.folderId === null) where.push(sql`${note.folderId} is null`);
		else if (input.folderId) where.push(eq(note.folderId, input.folderId));
		if (input.favourites) where.push(starred);
		if (input.q) {
			// The wildcards of LIKE are escaped, so a search for 50% finds the text and not everything
			const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
			where.push(
				sql`(${note.title} ilike ${like} or ${note.searchVector} @@ plainto_tsquery('simple', ${input.q}))`
			);
		}
		const rows = await tx
			.select({
				id: note.id,
				number: note.number,
				title: note.title,
				folderId: note.folderId,
				visibility: note.visibility,
				createdBy: note.createdBy,
				updatedAt: note.updatedAt,
				version: note.version,
				updatedBy: note.updatedBy,
				favourite: starred,
				preview: sql<string>`left(${note.body}, 160)`,
				// The text an excerpt is made from: the start of the note, or for a search the stretch around the first hit
				source: input.brief
					? sql<string>`''`
					: firstWord
						? sql<string>`substr(${note.body}, greatest(1, strpos(lower(${note.body}), ${firstWord}) - ${EXCERPT_SOURCE_CHARS / 3}), ${EXCERPT_SOURCE_CHARS})`
						: sql<string>`left(${note.body}, ${EXCERPT_SOURCE_CHARS})`
			})
			.from(note)
			.where(and(...where))
			.orderBy(desc(note.updatedAt), desc(note.number))
			.limit(input.limit + 1)
			.offset(input.offset);
		const page = rows.slice(0, input.limit);
		// The last person who changed each note, read once for the page
		const ids = input.brief
			? []
			: [...new Set(page.map((r) => r.updatedBy ?? r.createdBy).filter((v): v is string => !!v))];
		const people = ids.length
			? await tx
					.select({ id: user.id, name: user.name })
					.from(user)
					.where(sql`${user.id} in (${sql.join(ids, sql`, `)})`)
			: [];
		const nameOf = new Map(people.map((p) => [p.id, p.name]));
		return {
			project: { id: proj.id, key: proj.key },
			notes: page.map(({ source, updatedBy, ...r }) => {
				const editor = updatedBy ?? r.createdBy;
				return {
					...r,
					ref: noteRef(r.number),
					mine: r.createdBy === me,
					excerpt: input.brief ? '' : noteExcerpt(r.title, source),
					match: input.q && !input.brief ? noteMatch(source, input.q) : null,
					lastEditor: editor ? { id: editor, name: nameOf.get(editor) ?? 'Someone' } : null
				};
			}),
			next: rows.length > input.limit ? input.offset + input.limit : null
		};
	});
}

// -- CHANGE -- //

/**
 * Changes the title, the body, the folder or the visibility of a note. `cause` says who is writing (see noteCauseOf):
 * a change of the body from outside the live document keeps a version first and starts a new epoch, so an older window
 * can never write the old text back.
 */
export async function updateNote(
	ctx: Ctx,
	raw: z.input<typeof noteChangeInput>,
	cause: NoteCause = 'typing'
) {
	const input = noteChangeInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			// The tree lock comes before the note's row lock, the order trashFolder takes them in, so the two cannot wait on
			// each other. A folder being trashed at the same moment cannot take this note in unseen.
			// The rate limit is counted first, as every folder verb does, so the locks are always taken in one order.
			if (input.folderId) {
				await rateLimit(tx, ctx, 'write');
				await lockTree(tx, proj.id);
			}
			if (!input.folderId) await rateLimit(tx, ctx, 'write');
			const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
			checkVersion(row, input.expectVersion);
			const me = ctx.actor.userId;
			const set: Partial<typeof note.$inferInsert> = {};
			if (input.title !== undefined && input.title !== row.title) set.title = input.title;
			if (input.body !== undefined && input.body !== row.body) set.body = input.body;
			if (input.visibility !== undefined && input.visibility !== row.visibility) {
				if (row.createdBy !== me)
					throw new OpError(
						'FORBIDDEN',
						'Only the person who wrote a note can make it private or shared.'
					);
				set.visibility = input.visibility;
				// A private note has no public link
				if (input.visibility === 'private') {
					set.publicEnabled = false;
					set.publicTokenHash = null;
				}
			}
			if (input.folderId !== undefined && input.folderId !== row.folderId) {
				if (input.folderId) await requireUsableFolder(tx, proj.id, input.folderId);
				set.folderId = input.folderId;
			}
			const changed = Object.keys(set);
			if (changed.length === 0) return { ...noteBrief(row), changed: false };
			if ('title' in set || 'body' in set) await keepNoteVersion(tx, row, cause);
			// A body written from outside the live document replaces it: the live updates of the old epoch go
			const outside = cause !== 'typing' && 'body' in set;
			if (outside) await tx.delete(noteUpdate).where(eq(noteUpdate.noteId, row.id));
			const [next] = await tx
				.update(note)
				.set({
					...set,
					updatedBy: me,
					updatedAt: sql`now()`,
					version: sql`${note.version} + 1`,
					...(outside ? { epoch: sql`${note.epoch} + 1`, updateSeq: 0, checkpointSeq: 0 } : {})
				})
				.where(eq(note.id, row.id))
				.returning();
			// Text links are worked out only when the body changed (a title, folder or visibility change leaves them alone)
			if ('body' in set) await syncNoteTextLinks(tx, next, next.body, me);
			// People typing save every few seconds: only a change someone else should hear about is an event
			const quiet = cause === 'typing' && changed.every((k) => k === 'body');
			if (!quiet) {
				const pick = (r: typeof note.$inferSelect) =>
					Object.fromEntries(
						changed
							.filter((k) => k !== 'body' && k !== 'publicTokenHash')
							.map((k) => [k, r[k as keyof typeof r]])
					);
				await noteEvent(tx, ctx, next, 'note.update', {
					before: pick(row),
					after: { ...pick(next), ...('body' in set ? { cause } : {}) }
				});
			}
			return { ...noteBrief(next), changed: true };
		})
	);
}

/** Moves a note to a folder, or to the top with null. */
export const moveNote = (
	ctx: Ctx,
	raw: z.input<typeof noteNameInput> & { folderId: string | null; expectVersion?: number }
) => updateNote(ctx, raw);

// -- TRASH AND RESTORE -- //

export async function trashNote(ctx: Ctx, raw: z.input<typeof noteNameInput>) {
	const input = noteNameInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'delete', proj.id);
			await rateLimit(tx, ctx, 'write');
			const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
			const [next] = await tx
				.update(note)
				.set({
					deletedAt: sql`now()`,
					deletedBy: ctx.actor.userId,
					// The public link stops with the note and is not switched back on by a restore
					publicEnabled: false,
					publicTokenHash: null,
					updatedAt: sql`now()`,
					version: sql`${note.version} + 1`
				})
				.where(eq(note.id, row.id))
				.returning();
			await noteEvent(tx, ctx, next, 'note.delete', { before: { title: row.title } });
			return { ...noteBrief(next), trashed: true };
		})
	);
}

export async function restoreNote(ctx: Ctx, raw: z.input<typeof noteNameInput>) {
	const input = noteNameInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'delete', proj.id);
			await rateLimit(tx, ctx, 'write');
			const row = await findNote(tx, ctx, proj.id, input.note, { lock: true, trashed: true });
			// A note whose folder is gone or in the trash comes back at the top
			let folderId = row.folderId;
			if (folderId) {
				try {
					await requireUsableFolder(tx, proj.id, folderId);
				} catch (e) {
					if (!(e instanceof OpError)) throw e;
					folderId = null;
				}
			}
			const [next] = await tx
				.update(note)
				.set({
					deletedAt: null,
					deletedBy: null,
					folderId,
					updatedAt: sql`now()`,
					version: sql`${note.version} + 1`
				})
				.where(eq(note.id, row.id))
				.returning();
			await noteEvent(tx, ctx, next, 'note.restore', { after: { title: next.title } });
			return { ...noteBrief(next), trashed: false };
		})
	);
}

// -- FAVOURITES -- //

/** A star is one person's own: it changes nothing for anyone else and writes no event. */
export async function setFavourite(ctx: Ctx, raw: z.input<typeof noteFavouriteInput>) {
	const input = noteFavouriteInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		const row = await findNote(tx, ctx, proj.id, input.note);
		const me = ctx.actor.userId;
		if (input.on)
			await tx
				.insert(noteFavourite)
				.values({ orgId: ctx.orgId, projectId: proj.id, noteId: row.id, userId: me })
				.onConflictDoNothing();
		else
			await tx
				.delete(noteFavourite)
				.where(and(eq(noteFavourite.noteId, row.id), eq(noteFavourite.userId, me)));
		return { ref: noteRef(row.number), favourite: input.on };
	});
}

// -- LINKS (PANEL LINKS BY HAND, TEXT LINKS FROM THE BODY, SEE noteLinks.ts) -- //

const linkKind = z.enum(NOTE_LINK_KINDS);
export const noteLinkVerbInput = noteName.extend({
	targetKind: linkKind,
	/** A reference (AFB-20261107-0346, T-4, N-12) or an id. A mockup is named by its id. */
	target: z.string().trim().min(1).max(200)
});
export const noteLinksOfInput = noteName;
export const notesLinkedToInput = z.object({
	project: z.string().min(1),
	targetKind: z.enum(['item', 'task', 'mockup']),
	target: z.string().trim().min(1).max(200)
});
export const noteLinkCountsInput = z.object({
	project: z.string().min(1),
	targetKind: z.enum(['item', 'task', 'mockup']),
	/** Row ids, at most 200 at a time. */
	targets: z.array(z.string().uuid()).max(200)
});

/** The one target a name points at in this project that the caller may see, or the same NOT_FOUND for every other case. */
async function visibleTarget(
	tx: Tx,
	ctx: Ctx,
	projectId: string,
	kind: NoteLinkKind,
	name: string
) {
	const gone = () =>
		new OpError('NOT_FOUND', 'No such plan, task, mockup or note in this project.');
	const [hit] = await findLinkTargets(tx, projectId, [{ kind, ref: name }]);
	if (!hit) throw gone();
	const seen = await seeTargets(tx, ctx.actor.userId, [hit]);
	const target = seen.get(`${hit.kind}:${hit.id}`);
	if (!target) throw gone();
	return target;
}

/** Adds a panel link from a note to a plan, task, mockup or another note of the same project. Linking twice changes nothing. */
export async function linkNote(ctx: Ctx, raw: z.input<typeof noteLinkVerbInput>) {
	const input = noteLinkVerbInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
			const target = await visibleTarget(tx, ctx, proj.id, input.targetKind, input.target);
			if (target.kind === 'note' && target.id === row.id)
				throw new OpError('INVALID', 'A note cannot link to itself.');
			const added = await tx
				.insert(noteLink)
				.values({
					orgId: ctx.orgId,
					projectId: proj.id,
					noteId: row.id,
					targetKind: target.kind,
					targetId: target.id,
					source: 'panel',
					createdBy: ctx.actor.userId
				})
				.onConflictDoNothing()
				.returning({ id: noteLink.id });
			if (added.length)
				await noteEvent(tx, ctx, row, 'note.link', {
					after: { kind: target.kind, target: target.ref ?? target.id }
				});
			return {
				note: noteRef(row.number),
				linked: { kind: target.kind, id: target.id, ref: target.ref, title: target.title }
			};
		})
	);
}

/**
 * Removes a panel link. A link that is also written in the text stays (the text is where it is removed). The answer is the
 * same whether or not a link was there, and whether or not the caller can see the target, so it leaks nothing.
 */
export async function unlinkNote(ctx: Ctx, raw: z.input<typeof noteLinkVerbInput>) {
	const input = noteLinkVerbInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
			const [hit] = await findLinkTargets(tx, proj.id, [
				{ kind: input.targetKind, ref: input.target }
			]);
			if (hit) {
				const gone = await tx
					.delete(noteLink)
					.where(
						and(
							eq(noteLink.noteId, row.id),
							eq(noteLink.targetKind, hit.kind),
							eq(noteLink.targetId, hit.id),
							eq(noteLink.source, 'panel')
						)
					)
					.returning({ id: noteLink.id });
				if (gone.length)
					await noteEvent(tx, ctx, row, 'note.unlink', {
						after: { kind: hit.kind }
					});
			}
			return { note: noteRef(row.number), unlinked: true };
		})
	);
}

/** What a note links to (plans, tasks, mockups, notes) and which notes mention it, for the caller, with counts. */
export async function getNoteLinks(ctx: Ctx, raw: z.input<typeof noteLinksOfInput>) {
	const input = noteLinksOfInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		const row = await findNote(tx, ctx, proj.id, input.note);
		return { note: noteRef(row.number), ...(await readNoteLinks(tx, row.id, ctx.actor.userId)) };
	});
}

/** The notes the caller may see that link to a plan, task or mockup. A guest, who sees no notes, gets none. */
export async function listNotesLinkedTo(ctx: Ctx, raw: z.input<typeof notesLinkedToInput>) {
	const input = notesLinkedToInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		const target = await visibleTarget(tx, ctx, proj.id, input.targetKind, input.target);
		if (!(await noteRoleOf(tx, ctx, proj.id))) return { target: target.ref, notes: [] };
		return {
			target: target.ref ?? target.id,
			notes: await readNotesLinkedTo(tx, target.kind, target.id, ctx.actor.userId)
		};
	});
}

/** Counts of the notes the caller may see per plan, task or mockup, for badges on lists. Targets with none are left out. */
export async function countLinkedNotes(ctx: Ctx, raw: z.input<typeof noteLinkCountsInput>) {
	const input = noteLinkCountsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		if (!(await noteRoleOf(tx, ctx, proj.id))) return { counts: {} as Record<string, number> };
		return {
			counts: await countNotesLinkedTo(
				tx,
				input.targetKind,
				input.targets,
				ctx.actor.userId,
				proj.id
			)
		};
	});
}

// -- LINK TARGETS (THE # PICKER OF THE EDITOR) -- //

export const linkTargetsInput = z.object({
	project: z.string().min(1),
	/** Part of a title. Empty gives the newest of each kind. */
	q: z.string().trim().max(100).default('')
});

/** The most targets one search returns in all. */
export const LINK_TARGET_LIMIT = 10;

export type LinkTarget = {
	kind: 'item' | 'task' | 'mockup' | 'note';
	/** The row id. */
	id: string;
	/** N-12, T-12 or the plan reference; null for a mockup, which has no number. */
	ref: string | null;
	title: string;
};

/**
 * Titles in one project that a note can link to: plans, tasks, mockups and notes, each kind filtered by what the caller may
 * see (a private plan or note of someone else is never offered, a mockup follows its plan). Guests, who see no notes, get
 * nothing at all. At most LINK_TARGET_LIMIT in all, taken from the four kinds in turn so no kind crowds out the others.
 */
export async function searchLinkTargets(
	ctx: Ctx,
	raw: z.input<typeof linkTargetsInput>
): Promise<{ targets: LinkTarget[] }> {
	const input = linkTargetsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		if (!(await noteRoleOf(tx, ctx, proj.id))) return { targets: [] };
		const me = ctx.actor.userId;
		// The wildcards of LIKE are escaped, so a search for 50% finds the text and not everything
		const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		const lim = LINK_TARGET_LIMIT;
		const rows = <T>(res: unknown) => (res as { rows: T[] }).rows;
		const [plans, tasks, mockups, notes] = await Promise.all([
			tx.execute(sql`
				select id, ref, title from item
				where project_id = ${proj.id}::uuid and deleted_at is null and title ilike ${like}
					and (visibility = 'public' or created_by = ${me})
				order by updated_at desc limit ${lim}`),
			tx.execute(sql`
				select id, number, title from task
				where project_id = ${proj.id}::uuid and deleted_at is null and title ilike ${like}
				order by updated_at desc limit ${lim}`),
			// A mockup on a plan follows the plan's creator, a standalone one its own
			tx.execute(sql`
				select m.id, m.title from mockup m left join item p on p.id = m.item_id
				where m.project_id = ${proj.id}::uuid and m.trashed_at is null and m.title ilike ${like}
					and (m.visibility = 'public' or coalesce(p.created_by, m.created_by) = ${me})
					and (p.id is null or p.deleted_at is null)
				order by m.updated_at desc limit ${lim}`),
			tx
				.select({ id: note.id, number: note.number, title: note.title })
				.from(note)
				.where(
					and(eq(note.projectId, proj.id), visibleNoteSql(me), sql`${note.title} ilike ${like}`)
				)
				.orderBy(desc(note.updatedAt))
				.limit(lim)
		]);
		const lists: LinkTarget[][] = [
			rows<{ id: string; ref: string; title: string }>(plans).map((r) => ({
				kind: 'item' as const,
				id: r.id,
				ref: r.ref,
				title: r.title
			})),
			rows<{ id: string; number: number; title: string }>(tasks).map((r) => ({
				kind: 'task' as const,
				id: r.id,
				ref: `T-${r.number}`,
				title: r.title
			})),
			rows<{ id: string; title: string }>(mockups).map((r) => ({
				kind: 'mockup' as const,
				id: r.id,
				ref: null,
				title: r.title
			})),
			notes.map((r) => ({
				kind: 'note' as const,
				id: r.id,
				ref: noteRef(r.number),
				title: r.title
			}))
		];
		const targets: LinkTarget[] = [];
		for (let i = 0; targets.length < lim && lists.some((l) => i < l.length); i++)
			for (const l of lists) if (i < l.length && targets.length < lim) targets.push(l[i]);
		return { targets };
	});
}

// -- PICTURES -- //

/** Uploads running right now, by person, so one person cannot hold more than NOTE_LIMITS.uploadsAtOnce open. */
const uploading = new Map<string, number>();

/** The stored file extension of a sniffed picture type. */
const EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};

function storageOf(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/**
 * Stores one picture of a note. The type comes from the first bytes, never from the name or the type the browser sent;
 * SVG and anything else is refused. The size is checked before storage or the database is touched, a person has at most
 * NOTE_LIMITS.uploadsAtOnce uploads running, and a note holds at most NOTE_LIMITS.notePictureBytes of pictures. The file is
 * written before its row and deleted again when the row fails (withFileCleanup).
 */
export async function uploadNoteFile(
	ctx: Ctx,
	raw: z.input<typeof noteNameInput>,
	bytes: Uint8Array
) {
	const input = noteNameInput.parse(raw);
	if (!bytes?.byteLength) throw new OpError('INVALID', 'No picture was sent.');
	if (bytes.byteLength > NOTE_LIMITS.pictureBytes)
		throw new OpError('INVALID', 'A picture can be at most 25 MB.');
	const mime = sniffPicture(bytes);
	if (!mime) throw new OpError('INVALID', 'Use a PNG, JPEG, WebP or GIF picture.');
	const store = storageOf(ctx);
	const who = ctx.actor.userId;
	const running = uploading.get(who) ?? 0;
	if (running >= NOTE_LIMITS.uploadsAtOnce)
		throw new OpError(
			'RATE_LIMITED',
			'Two pictures are already uploading. Wait for one to finish.'
		);
	uploading.set(who, running + 1);
	const written: string[] = [];
	try {
		return await withFileCleanup(store, written, () =>
			run(ctx, async (tx) => {
				const proj = await findProject(tx, ctx, input.project);
				await requireCap(tx, ctx, 'write', proj.id);
				// The note row is locked, so two uploads cannot both pass the total of one note
				await rateLimit(tx, ctx, 'write');
				const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
				const [used] = await tx
					.select({ total: sql<number>`coalesce(sum(${noteFile.size}), 0)::float8` })
					.from(noteFile)
					.where(eq(noteFile.noteId, row.id));
				if ((used?.total ?? 0) + bytes.byteLength > NOTE_LIMITS.notePictureBytes)
					throw new OpError('INVALID', 'The pictures of one note can be at most 200 MB in all.');
				const key = `${NOTE_KEY_PREFIX}/${ctx.orgId}/${proj.id}/${randomUUID()}.${EXT[mime]}`;
				written.push(key);
				await store.put(key, bytes, mime);
				const [file] = await tx
					.insert(noteFile)
					.values({
						orgId: ctx.orgId,
						projectId: proj.id,
						noteId: row.id,
						storageKey: key,
						mime,
						size: bytes.byteLength,
						checksum: createHash('sha256').update(bytes).digest('hex'),
						createdBy: who
					})
					.returning();
				return {
					id: file.id,
					note: noteRef(row.number),
					mime,
					size: file.size,
					/** What to write in the note's text. */
					markdown: `![](afb:file/${file.id})`
				};
			})
		);
	} finally {
		const left = (uploading.get(who) ?? 1) - 1;
		if (left > 0) uploading.set(who, left);
		else uploading.delete(who);
	}
}

/**
 * Loads one picture for a reader. The reader is checked against the picture's own note (visibility, trash, role not guest),
 * whatever note's text names the picture, so an id written into a shared note shows nothing of a private note's picture.
 * Every refusal is the same NOT_FOUND.
 */
export async function readNoteFile(ctx: Ctx, fileId: string) {
	if (!isUuid(fileId)) throw new OpError('NOT_FOUND', 'No picture with that address.');
	const found = await run(ctx, async (tx) => {
		const [file] = await tx
			.select()
			.from(noteFile)
			.where(and(eq(noteFile.id, fileId), eq(noteFile.orgId, ctx.orgId)));
		if (!file) throw new OpError('NOT_FOUND', 'No picture with that address.');
		await requireCap(tx, ctx, 'read', file.projectId);
		const [owner] = await tx
			.select()
			.from(note)
			.where(and(eq(note.id, file.noteId), sql`${note.deletedAt} is null`));
		if (!owner) throw new OpError('NOT_FOUND', 'No picture with that address.');
		try {
			await requireNoteVisible(tx, ctx, owner);
		} catch (e) {
			if (e instanceof OpError) throw new OpError('NOT_FOUND', 'No picture with that address.');
			throw e;
		}
		return { key: file.storageKey, mime: file.mime, checksum: file.checksum, size: file.size };
	});
	const bytes = await storageOf(ctx).get(found.key);
	if (!bytes) throw new OpError('NOT_FOUND', 'No picture with that address.');
	return { bytes, mime: found.mime, checksum: found.checksum };
}
