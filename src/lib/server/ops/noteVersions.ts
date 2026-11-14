// NOTE HISTORY AND THE PUBLIC LINK VERBS: LIST AND READ EARLIER VERSIONS, RESTORE ONE, SWITCH THE LINK ON AND OFF (AFB-20261111-0035, 7.1 AND 7.2)
// The versions themselves are kept by keepNoteVersion (notes.ts) before every change. They are only ever added: nothing here
// changes or removes one. A restore keeps the current text as a version first, then writes the old text on top as the newest.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { noteRef } from '../../shared/notes';
import { note, noteUpdate, noteVersion, user } from '../db/schema';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { checkVersion } from './items';
import { hashToken } from './mockups';
import { findNote, keepNoteVersion, noteBrief, noteEvent, noteNameInput } from './notes';
import { syncNoteTextLinks } from './noteLinks';
import { findProject } from './resolve';

// -- CONSTANTS -- //

export const noteVersionsInput = noteNameInput.extend({
	limit: z.number().int().min(1).max(200).default(100),
	offset: z.number().int().min(0).default(0)
});
export const noteVersionInput = noteNameInput.extend({ number: z.number().int().min(1) });
export const noteRestoreVersionInput = noteVersionInput.extend({
	expectVersion: z.number().int().optional()
});
export const notePublicLinkInput = noteNameInput.extend({ on: z.boolean() });

// -- HISTORY -- //

/** The earlier versions of a note, newest first, without their text, and who wrote each. */
export async function listNoteVersions(ctx: Ctx, raw: z.input<typeof noteVersionsInput>) {
	const input = noteVersionsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		const { caps } = await requireCap(tx, ctx, 'read', proj.id);
		const row = await findNote(tx, ctx, proj.id, input.note);
		const rows = await tx
			.select({
				number: noteVersion.number,
				title: noteVersion.title,
				cause: noteVersion.cause,
				createdAt: noteVersion.createdAt,
				createdBy: noteVersion.createdBy,
				author: user.name,
				size: sql<number>`length(${noteVersion.body})::int`
			})
			.from(noteVersion)
			.leftJoin(user, eq(user.id, noteVersion.createdBy))
			.where(eq(noteVersion.noteId, row.id))
			.orderBy(desc(noteVersion.number))
			.limit(input.limit + 1)
			.offset(input.offset);
		return {
			note: noteRef(row.number),
			canRestore: caps.includes('write'),
			versions: rows.slice(0, input.limit).map((r) => ({ ...r, author: r.author ?? null })),
			next: rows.length > input.limit ? input.offset + input.limit : null
		};
	});
}

/** One earlier version with its whole text. */
export async function getNoteVersion(ctx: Ctx, raw: z.input<typeof noteVersionInput>) {
	const input = noteVersionInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		const row = await findNote(tx, ctx, proj.id, input.note);
		const [v] = await tx
			.select()
			.from(noteVersion)
			.where(and(eq(noteVersion.noteId, row.id), eq(noteVersion.number, input.number)));
		if (!v) throw new OpError('NOT_FOUND', 'This note has no such version.');
		const [who] = v.createdBy
			? await tx.select({ name: user.name }).from(user).where(eq(user.id, v.createdBy))
			: [];
		return {
			note: noteRef(row.number),
			number: v.number,
			title: v.title,
			body: v.body,
			cause: v.cause,
			createdAt: v.createdAt,
			createdBy: v.createdBy,
			author: who?.name ?? null,
			// Text another person wrote is data for an agent, never instructions
			untrusted: row.visibility !== 'private' || row.createdBy !== ctx.actor.userId
		};
	});
}

/**
 * Copies an earlier version on top as the newest. The current text is kept as a version (cause restore) first. On an open
 * note this follows the rule for a write from outside the live document: the live updates go and the epoch is raised, so an
 * older window can never write its text back over the restore.
 */
export async function restoreNoteVersion(ctx: Ctx, raw: z.input<typeof noteRestoreVersionInput>) {
	const input = noteRestoreVersionInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
			checkVersion(row, input.expectVersion);
			const [old] = await tx
				.select()
				.from(noteVersion)
				.where(and(eq(noteVersion.noteId, row.id), eq(noteVersion.number, input.number)));
			if (!old) throw new OpError('NOT_FOUND', 'This note has no such version.');
			if (old.title === row.title && old.body === row.body)
				return { ...noteBrief(row), changed: false, restoredFrom: old.number };
			await keepNoteVersion(tx, row, 'restore');
			await tx.delete(noteUpdate).where(eq(noteUpdate.noteId, row.id));
			const me = ctx.actor.userId;
			const [next] = await tx
				.update(note)
				.set({
					title: old.title,
					body: old.body,
					updatedBy: me,
					updatedAt: sql`now()`,
					version: sql`${note.version} + 1`,
					epoch: sql`${note.epoch} + 1`,
					updateSeq: 0,
					checkpointSeq: 0
				})
				.where(eq(note.id, row.id))
				.returning();
			await syncNoteTextLinks(tx, next, next.body, me);
			await noteEvent(tx, ctx, next, 'note.update', {
				before: { title: row.title },
				after: { title: next.title, cause: 'restore', restoredFrom: old.number }
			});
			return { ...noteBrief(next), changed: true, restoredFrom: old.number };
		})
	);
}

// -- PUBLIC LINK -- //

/**
 * Switches the public link of a note on or off. Switching on makes a new random address every time, so the old one stops at
 * once; the address is in the answer only here and the database keeps a hash. A private note has no link. It needs the
 * manage capability. The note's version is left alone, because a link is not a change of the text and an open editor must not
 * meet a conflict because of it.
 */
export async function setNotePublicLink(ctx: Ctx, raw: z.input<typeof notePublicLinkInput>) {
	const input = notePublicLinkInput.parse(raw);
	return run(ctx, (tx) => {
		// Switching on is never stored for replay: the request log would keep the address in clear text. A retry of a lost
		// answer simply makes another new address, which is what switching on means anyway.
		const once = <T>(work: () => Promise<T>) => (input.on ? work() : idempotent(ctx, tx, work));
		return once(async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'manage', proj.id);
			await rateLimit(tx, ctx, 'write');
			const row = await findNote(tx, ctx, proj.id, input.note, { lock: true });
			if (input.on && row.visibility === 'private')
				throw new OpError('CONFLICT', 'A private note cannot have a public link.');
			const token = input.on ? randomBytes(24).toString('base64url') : null;
			const [next] = await tx
				.update(note)
				.set({ publicEnabled: input.on, publicTokenHash: token ? hashToken(token) : null })
				.where(eq(note.id, row.id))
				.returning();
			await noteEvent(tx, ctx, next, input.on ? 'note.public-on' : 'note.public-off');
			return {
				note: noteRef(next.number),
				publicEnabled: next.publicEnabled,
				// The only time the address exists in clear text
				token,
				url: token && ctx.services?.baseUrl ? `${ctx.services.baseUrl}/n/${token}` : null
			};
		});
	});
}
