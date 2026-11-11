// LIVE CO-EDITING VERBS OF A NOTE: STORE UPDATES, READ THEM, MERGE THEM, CHECKPOINT THE MARKDOWN, SEND PRESENCE (AFB-20261111-0035, 8.2)
// The live state is a Yjs document kept as a list of updates (note_update); the note body is a checkpoint of it. Every verb
// checks the caller's live role and the note's visibility itself, counts against its own rate bucket (never the write bucket),
// and writes no event row, so live typing never shows in Activity. Updates travel as base64.

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { z } from 'zod';
// -- MODULES -- //
import { NOTE_LIMITS, noteRef } from '../../shared/notes';
import { appendEvent } from '../db/events';
import { note, noteUpdate } from '../db/schema';
import { noteUpdateInput } from '../db/zod';
import { notifyChange } from '../realtime/notify';
import { OpError, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import { findNote, keepNoteVersion } from './notes';
import { syncNoteTextLinks } from './noteLinks';
import { findProject } from './resolve';

// -- CONSTANTS -- //

const name = z.object({ project: z.string().min(1), note: z.string().min(1) });
/** The most updates one call carries. */
const MAX_PER_CALL = 50;
/** The characters of the longest base64 text that still decodes to a legal update (with a little room for padding). */
const MAX_B64 = Math.ceil((NOTE_LIMITS.updateBytes * 4) / 3) + 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const noteUpdatesInput = name.extend({
	/** The epoch the window opened the note in. */
	epoch: z.number().int().min(1),
	/** Yjs updates in base64, in the order they were made. */
	updates: z.array(z.string().max(MAX_B64)).min(1).max(MAX_PER_CALL),
	/** True when the one update is this window's seed (see the first open rule). */
	seed: z.boolean().optional()
});
export const noteReadUpdatesInput = name.extend({
	/** The number of the last update the window already holds. */
	after: z.number().int().min(0).default(0)
});
export const noteCheckpointInput = name.extend({
	epoch: z.number().int().min(1),
	/** The number of the last live update the Markdown covers. */
	sequence: z.number().int().min(0),
	...noteUpdateInput.pick({ body: true }).required().shape,
	/** Left out when this window did not change the title, so a rename made elsewhere is never put back. */
	title: noteUpdateInput.shape.title.optional()
});
export const notePresenceInput = name.extend({
	/** One awareness message in base64. */
	data: z.string().max(Math.ceil((NOTE_LIMITS.presenceBytes * 4) / 3) + 4)
});
export const noteCompactInput = name;

export type SyncRow = { seq: number; update: string };
export type AppendAnswer =
	| { ok: true; epoch: number; seqs: number[]; last: number }
	| { ok: false; reason: 'epoch'; epoch: number }
	| { ok: false; reason: 'taken'; epoch: number; last: number; updates: SyncRow[] };
export type CheckpointAnswer =
	| { ok: true; epoch: number; sequence: number; version: number }
	| { ok: false; reason: 'epoch' | 'old'; epoch: number; checkpointSeq: number };

// -- FUNCTIONS -- //

const invalid = (message: string) => new OpError('INVALID', message);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Decodes one base64 update, refusing bad text and anything over the size of one live update. */
function decode(text: string, limit: number, what: string): Uint8Array {
	if (!BASE64.test(text) || text.length % 4 === 1)
		throw invalid(`The ${what} is not valid base64.`);
	const bytes = new Uint8Array(Buffer.from(text, 'base64'));
	if (bytes.byteLength === 0) throw invalid(`The ${what} is empty.`);
	if (bytes.byteLength > limit)
		throw invalid(`The ${what} is larger than ${Math.round(limit / 1024)} KB.`);
	return bytes;
}

/** Applies an update to a scratch document, so bytes that are not a Yjs update never reach the table. */
function checkApplies(bytes: Uint8Array) {
	const scratch = new Y.Doc();
	try {
		Y.applyUpdate(scratch, bytes);
	} catch {
		throw invalid('The update is not a valid live editing update.');
	} finally {
		scratch.destroy();
	}
}

async function rowsAfter(tx: Tx, noteId: string, epoch: number, after: number): Promise<SyncRow[]> {
	const rows = await tx
		.select({ seq: noteUpdate.seq, update: noteUpdate.update })
		.from(noteUpdate)
		.where(
			and(eq(noteUpdate.noteId, noteId), eq(noteUpdate.epoch, epoch), gt(noteUpdate.seq, after))
		)
		.orderBy(asc(noteUpdate.seq));
	return rows.map((r) => ({ seq: r.seq, update: b64(r.update) }));
}

async function storedBytes(tx: Tx, noteId: string): Promise<number> {
	const res = await tx.execute(
		sql`select coalesce(sum(octet_length(update)), 0)::float8 as total from note_update where note_id = ${noteId}::uuid`
	);
	return Number((res as unknown as { rows: { total: number }[] }).rows[0]?.total ?? 0);
}

/**
 * Merges the stored updates of a note's current epoch into one row that keeps the highest number. A row that cannot be
 * merged is skipped and stays as it is. The caller holds the row lock of the note.
 */
export async function compactNoteUpdates(tx: Tx, row: { id: string; epoch: number }) {
	const rows = await tx
		.select({ id: noteUpdate.id, seq: noteUpdate.seq, update: noteUpdate.update })
		.from(noteUpdate)
		.where(and(eq(noteUpdate.noteId, row.id), eq(noteUpdate.epoch, row.epoch)))
		.orderBy(asc(noteUpdate.seq));
	// Y.mergeUpdates keeps the text that was deleted, so the rows are applied to a document and its state is stored instead:
	// a document drops deleted text when it applies updates, so the one row is as small as the live text allows
	const doc = new Y.Doc();
	const used: { id: string; seq: number }[] = [];
	for (const r of rows) {
		try {
			Y.applyUpdate(doc, r.update);
			used.push({ id: r.id, seq: r.seq });
		} catch {
			// A row that cannot be applied stays where it is
		}
	}
	const merged = used.length > 0 ? Y.encodeStateAsUpdate(doc) : null;
	doc.destroy();
	if (!merged || used.length < 2) return { merged: 0 };
	const last = used[used.length - 1];
	await tx.delete(noteUpdate).where(
		inArray(
			noteUpdate.id,
			used.slice(0, -1).map((u) => u.id)
		)
	);
	await tx.update(noteUpdate).set({ update: merged }).where(eq(noteUpdate.id, last.id));
	return { merged: used.length };
}

// -- STORE UPDATES -- //

/**
 * Stores updates of a note's live document. Locks the note row, so the numbers taken from update_seq are in commit order.
 * A seed is accepted only as number 1 of its epoch; the loser is told `taken` and gets the winner's updates. An update of an
 * older epoch is answered `epoch` and stores nothing, so an old window can never put old text back.
 */
export async function appendNoteUpdates(
	ctx: Ctx,
	raw: z.input<typeof noteUpdatesInput>
): Promise<AppendAnswer> {
	const input = noteUpdatesInput.parse(raw);
	// The schema already capped the count and the length of each text; the cheap seed check needs no decoding
	if (input.seed && input.updates.length !== 1) throw invalid('A seed is one update.');
	return run(ctx, async (tx): Promise<AppendAnswer> => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'write', proj.id);
		await rateLimit(tx, ctx, 'sync');
		const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
		// Only a caller who may write, and is inside the rate limit, gets its bytes decoded and applied to a scratch document
		const bytes = input.updates.map((u) => decode(u, NOTE_LIMITS.updateBytes, 'update'));
		for (const b of bytes) checkApplies(b);
		if (input.epoch !== row.epoch) return { ok: false, reason: 'epoch', epoch: row.epoch };
		if (input.seed && row.updateSeq > 0)
			return {
				ok: false,
				reason: 'taken',
				epoch: row.epoch,
				last: row.updateSeq,
				updates: await rowsAfter(tx, row.id, row.epoch, 0)
			};
		if (!input.seed && row.updateSeq === 0)
			throw invalid('This note has not been opened for live editing yet.');
		// Over the limit: merge first; a note that stays over it after merging refuses more typing
		const incoming = bytes.reduce((n, b) => n + b.byteLength, 0);
		if ((await storedBytes(tx, row.id)) + incoming > NOTE_LIMITS.noteUpdateBytes) {
			await compactNoteUpdates(tx, row);
			if ((await storedBytes(tx, row.id)) + incoming > NOTE_LIMITS.noteUpdateBytes)
				throw invalid(
					'This note has too much unsaved live text to take more typing. Its live editing history is full, so copy what you still need elsewhere and ask for the note to be restored from History.'
				);
		}
		const seqs = bytes.map((_, i) => row.updateSeq + 1 + i);
		await tx.insert(noteUpdate).values(
			bytes.map((update, i) => ({
				orgId: ctx.orgId,
				projectId: proj.id,
				noteId: row.id,
				epoch: row.epoch,
				seq: seqs[i],
				update,
				authorId: ctx.actor.userId
			}))
		);
		const last = seqs[seqs.length - 1];
		await tx.update(note).set({ updateSeq: last }).where(eq(note.id, row.id));
		await notifyChange(tx, {
			o: ctx.orgId,
			p: proj.id,
			k: 'note',
			n: row.id,
			x: row.epoch,
			s: last
		});
		return { ok: true, epoch: row.epoch, seqs, last };
	});
}

// -- READ UPDATES -- //

/** The note's epoch, its Markdown and the live updates after a number, for a window that opens or catches up. */
export async function readNoteUpdates(ctx: Ctx, raw: z.input<typeof noteReadUpdatesInput>) {
	const input = noteReadUpdatesInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		const row = await findNote(tx, ctx, proj.id, input.note);
		await rateLimit(tx, ctx, 'sync');
		return {
			note: noteRef(row.number),
			epoch: row.epoch,
			markdown: row.body,
			last: row.updateSeq,
			checkpointSeq: row.checkpointSeq,
			updates: await rowsAfter(tx, row.id, row.epoch, input.after)
		};
	});
}

// -- MERGE -- //

/** Merges the stored updates of a note into one row. The screens do this on their own past 5 MB; this is the manual verb. */
export async function compactNote(ctx: Ctx, raw: z.input<typeof noteCompactInput>) {
	const input = noteCompactInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'write', proj.id);
		await rateLimit(tx, ctx, 'sync');
		const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
		return { note: noteRef(row.number), ...(await compactNoteUpdates(tx, row)) };
	});
}

// -- CHECKPOINT -- //

/**
 * Saves the Markdown of the live document as the note's body. Taken only when the epoch matches and the sequence is newer than
 * the last checkpoint. It goes through the same schema, limits, text link difference and version rule as an edit by typing
 * (the cause is always typing), and writes an event only for a title change.
 */
export async function checkpointNote(
	ctx: Ctx,
	raw: z.input<typeof noteCheckpointInput>
): Promise<CheckpointAnswer> {
	const input = noteCheckpointInput.parse(raw);
	return run(ctx, async (tx): Promise<CheckpointAnswer> => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'write', proj.id);
		await rateLimit(tx, ctx, 'sync');
		const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
		if (input.epoch !== row.epoch)
			return { ok: false, reason: 'epoch', epoch: row.epoch, checkpointSeq: row.checkpointSeq };
		if (input.sequence <= row.checkpointSeq)
			return { ok: false, reason: 'old', epoch: row.epoch, checkpointSeq: row.checkpointSeq };
		if (input.sequence > row.updateSeq)
			throw invalid('That checkpoint covers updates the server has not stored.');
		const me = ctx.actor.userId;
		const title = input.title ?? row.title;
		const titleChanged = title !== row.title;
		const bodyChanged = input.body !== row.body;
		if (titleChanged || bodyChanged) await keepNoteVersion(tx, row, 'typing');
		const [next] = await tx
			.update(note)
			.set({
				title,
				body: input.body,
				checkpointSeq: input.sequence,
				...(titleChanged || bodyChanged
					? { updatedBy: me, updatedAt: sql`now()`, version: sql`${note.version} + 1` }
					: {})
			})
			.where(eq(note.id, row.id))
			.returning();
		if (bodyChanged) await syncNoteTextLinks(tx, next, next.body, me);
		if (titleChanged)
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				noteId: row.id,
				...actorFields(ctx),
				verb: 'note.update',
				targetType: 'note',
				targetId: row.id,
				before: { title: row.title } as never,
				after: { title: next.title } as never,
				undoable: false
			});
		return { ok: true, epoch: next.epoch, sequence: input.sequence, version: next.version };
	});
}

// -- PRESENCE -- //

/** Passes one awareness message (a cursor, a name) to the other open windows. Nothing is stored. */
export async function sendNotePresence(ctx: Ctx, raw: z.input<typeof notePresenceInput>) {
	const input = notePresenceInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		const row = await findNote(tx, ctx, proj.id, input.note);
		await rateLimit(tx, ctx, 'sync');
		// Decoded only after the capability and the rate limit; the schema already capped the text's length
		const bytes = decode(input.data, NOTE_LIMITS.presenceBytes, 'presence message');
		await notifyChange(tx, {
			o: ctx.orgId,
			p: proj.id,
			k: 'presence',
			n: row.id,
			s: row.epoch,
			d: b64(bytes)
		});
		return { ok: true };
	});
}
