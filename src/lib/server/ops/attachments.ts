// ATTACHMENT VERBS (SPEC 5, 6). PRIVATE BY DEFAULT, SERVED ONLY THROUGH SHORT LIVED SIGNED LINKS

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import { attachment, item } from '../db/schema';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields, canSeeItem } from './items';
import { findItem } from './resolve';

// -- CONSTANTS -- //

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const SIGNED_URL_SECONDS = 300;
/** File types allowed as attachments, by extension. Anything else is refused, whatever its content type says. */
const ALLOWED = new Set([
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'pdf',
	'xlsx',
	'csv',
	'tsv',
	'json',
	'txt',
	'md',
	'html',
	'mp4',
	'webm',
	'zip'
]);
const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	pdf: 'application/pdf',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	json: 'application/json',
	txt: 'text/plain',
	md: 'text/markdown',
	html: 'text/html',
	mp4: 'video/mp4',
	webm: 'video/webm',
	zip: 'application/zip'
};

export const attachInput = z.object({
	item: z.string().min(1),
	filename: z.string().min(1).max(200),
	caption: z.string().min(1).max(200),
	kind: z.string().min(1).max(40).default('file'),
	refs: z.array(z.string().max(40)).max(20).default([]),
	visibility: z.enum(['public', 'private']).default('private')
});

// -- FUNCTIONS -- //

const clean = (name: string) =>
	name
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^\.+/, '')
		.slice(0, 120) || 'file';
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

function storage(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/** Stores a file for an item. The type comes from the extension, never from what the sender claims. */
export async function addAttachment(ctx: Ctx, raw: z.input<typeof attachInput>, bytes: Uint8Array) {
	const input = attachInput.parse(raw);
	const ext = extOf(input.filename);
	if (!ALLOWED.has(ext))
		throw new OpError(
			'INVALID',
			`Files of type ".${ext || 'none'}" are not allowed. Allowed: ${[...ALLOWED].join(', ')}.`
		);
	if (bytes.byteLength === 0) throw new OpError('INVALID', 'The file is empty.');
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
		throw new OpError('INVALID', 'The file is larger than 15 MB.');
	const store = storage(ctx);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, input.item);
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			const key = `${ctx.orgId}/${it.projectId}/${randomUUID()}-${clean(input.filename)}`;
			const checksum = createHash('sha256').update(bytes).digest('hex');
			// The file is written first: a failed write leaves no row, and a failed row leaves a file nothing points at, which the purge removes
			await store.put(key, bytes, MIME[ext]);
			const [row] = await tx
				.insert(attachment)
				.values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					visibility: input.visibility,
					caption: input.caption,
					kind: input.kind,
					refs: input.refs,
					filename: clean(input.filename),
					mime: MIME[ext],
					size: bytes.byteLength,
					checksum,
					storageKey: key
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorFields(ctx),
				verb: 'attachment.create',
				targetType: 'attachment',
				targetId: row.id,
				after: { filename: row.filename, size: row.size, visibility: row.visibility } as never
			});
			return { attachment: row };
		})
	);
}

/** Private files are seen by admins, owners and the uploader's project writers; public ones by anyone who sees the item. */
export async function listAttachments(ctx: Ctx, nameOrId: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, nameOrId);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${nameOrId}".`);
		const rows = await tx
			.select()
			.from(attachment)
			.where(and(eq(attachment.itemId, it.id), sql`${attachment.deletedAt} is null`))
			.orderBy(desc(attachment.createdAt));
		const mayPrivate = role === 'owner' || role === 'admin' || role === 'member';
		return rows.filter((a) => a.visibility === 'public' || mayPrivate);
	});
}

/** A link to one file that works for 5 minutes. The caller needs read access to the item and to the file's visibility. */
export async function attachmentLink(ctx: Ctx, attachmentId: string) {
	const store = storage(ctx);
	if (!ctx.services?.baseUrl)
		throw new OpError('INVALID', 'The public address of the server is not configured.');
	const baseUrl = ctx.services.baseUrl;
	const row = await run(ctx, async (tx) => {
		const [a] = await tx
			.select()
			.from(attachment)
			.where(and(eq(attachment.id, attachmentId), sql`${attachment.deletedAt} is null`));
		if (!a || !a.itemId) throw new OpError('NOT_FOUND', 'No such attachment.');
		const it = await findItem(tx, ctx, a.itemId);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (
			!canSeeItem(role, it, ctx.actor.userId) ||
			(a.visibility === 'private' && !(role === 'owner' || role === 'admin' || role === 'member'))
		)
			throw new OpError('NOT_FOUND', 'No such attachment.');
		return a;
	});
	return {
		url: await store.signedUrl(baseUrl, row.storageKey, SIGNED_URL_SECONDS),
		expiresInSeconds: SIGNED_URL_SECONDS,
		filename: row.filename,
		mime: row.mime
	};
}

/** Making a file public is a normal write for an agent inside its project (ADR-006). */
export async function setAttachmentVisibility(
	ctx: Ctx,
	attachmentId: string,
	visibility: 'public' | 'private'
) {
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const [a] = await tx
				.select()
				.from(attachment)
				.where(and(eq(attachment.id, attachmentId), sql`${attachment.deletedAt} is null`))
				.for('update');
			if (!a) throw new OpError('NOT_FOUND', 'No such attachment.');
			await requireCap(tx, ctx, 'write', a.projectId);
			if (a.visibility === visibility) return { attachment: a, changed: false };
			const [row] = await tx
				.update(attachment)
				.set({ visibility, updatedAt: sql`now()` })
				.where(eq(attachment.id, a.id))
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: a.projectId,
				itemId: a.itemId,
				...actorFields(ctx),
				verb: 'attachment.update',
				targetType: 'attachment',
				targetId: a.id,
				before: { visibility: a.visibility } as never,
				after: { visibility } as never
			});
			return { attachment: row, changed: true };
		})
	);
}

/** Brings a file back from the trash. */
export async function restoreAttachment(ctx: Ctx, attachmentId: string) {
	return run(ctx, async (tx) => {
		const [a] = await tx
			.select()
			.from(attachment)
			.where(and(eq(attachment.id, attachmentId), sql`${attachment.deletedAt} is not null`))
			.for('update');
		if (!a) throw new OpError('NOT_FOUND', 'No such file in the trash.');
		await requireCap(tx, ctx, 'delete', a.projectId);
		if (a.itemId) {
			const [parent] = await tx
				.select({ gone: item.deletedAt })
				.from(item)
				.where(eq(item.id, a.itemId));
			if (parent?.gone)
				throw new OpError(
					'CONFLICT',
					'The item this file belongs to is in the trash. Restore the item first.'
				);
		}
		await tx.update(attachment).set({ deletedAt: null }).where(eq(attachment.id, a.id));
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: a.projectId,
			itemId: a.itemId,
			...actorFields(ctx),
			verb: 'attachment.restore',
			targetType: 'attachment',
			targetId: a.id,
			after: { filename: a.filename } as never,
			undoable: false
		});
		return { id: a.id, restored: true };
	});
}

export async function deleteAttachment(ctx: Ctx, attachmentId: string) {
	return run(ctx, async (tx) => {
		const [a] = await tx
			.select()
			.from(attachment)
			.where(and(eq(attachment.id, attachmentId), sql`${attachment.deletedAt} is null`))
			.for('update');
		if (!a) throw new OpError('NOT_FOUND', 'No such attachment.');
		await requireCap(tx, ctx, 'delete', a.projectId);
		await tx
			.update(attachment)
			.set({ deletedAt: sql`now()` })
			.where(eq(attachment.id, a.id));
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: a.projectId,
			itemId: a.itemId,
			...actorFields(ctx),
			verb: 'attachment.delete',
			targetType: 'attachment',
			targetId: a.id,
			before: { filename: a.filename } as never
		});
		return { id: a.id, trashed: true };
	});
}
