// SCREEN VERBS: THE SCREENSHOTS OF A PLAN'S FINISHED SCREENS (AFB-20261124-0926, ANNOTATIONS REMOVED IN AFB-20261125-0625)
// One verb set behind the Screens tab, /api/v1, MCP and the bridge. The first capture of a screen, mode and width is kept as
// the before picture and every later capture replaces the after picture. A caption and a note are written by a person or an
// agent, so they are returned marked untrusted and rendered as plain text.

// IMPORTED TYPES
import type { z } from 'zod';
import type { DbHandle, Tx } from '../db/client';
import type { Storage } from '../adapters/storage';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
// IMPORTED CONSTANTS
import { SCREEN_KEY_PREFIX } from '../db/schema/screens';
// IMPORTED MODULES
import { appendEvent } from '../db/events';
import { item, screen, section } from '../db/schema';
import { screenAddInput } from '../db/zod';
import { listMyOrgs } from '../orgs/orgs';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import { findItem } from './resolve';

// -- CONSTANTS -- //

// PROPOSED numbers (AFB-20261124-0926, settled 3): the owner has not confirmed them, so each is one line to change.
/** A screenshot is one PNG of one screen, up to 10 MB (confirmed by the owner, 2026-11-24). */
export const MAX_SCREEN_BYTES = 10 * 1024 * 1024;
/** The cap on the path with no shell, where the picture travels as base64 inside a tool call. */
export const MAX_SCREEN_BASE64_BYTES = 3 * 1024 * 1024;
export const MAX_SCREENS_PER_ITEM = 40;
/** Plans created before this moment are not asked for screens (AFB-20261125-0625). */
export const SCREENS_REQUIRED_FROM = new Date('2026-11-25T00:00:00Z');
/** A screens-waiver names why in at least this many characters. */
export const MIN_WAIVER_CHARS = 10;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// -- FUNCTIONS -- //

function storage(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/** Control characters out, line breaks kept, and the text trimmed. */
const plain = (s: string) =>
	// eslint-disable-next-line no-control-regex
	s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Only a real PNG of a sensible size is stored: the type is read from the bytes, never from what the sender says. */
export function checkScreenPicture(bytes: Uint8Array | undefined, maxBytes = MAX_SCREEN_BYTES) {
	if (!bytes || bytes.byteLength === 0) throw new OpError('INVALID', 'The picture is empty.');
	if (bytes.byteLength > maxBytes)
		throw new OpError(
			'INVALID',
			`The picture is larger than ${Math.round(maxBytes / 1048576)} MB.`
		);
	if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b))
		throw new OpError('INVALID', 'The picture must be a PNG image.');
}

/**
 * The width in pixels of a PNG, read from its first chunk (IHDR), or null when the header is not there.
 * Nothing else is decoded, so a picture is never opened or resized on the server.
 */
export function pngWidth(bytes: Uint8Array): number | null {
	// 8 bytes of signature, then 4 of length and 4 of the chunk name (IHDR), then the width as 4 big-endian bytes
	if (bytes.byteLength < 24) return null;
	const name = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (name !== 'IHDR') return null;
	return ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
}

/** The address a member's browser asks for the picture, with the row's own id. The route checks the caller's access. */
export const screenImagePath = (id: string) => `/pictures/screen/${id}`;

/**
 * Stores one capture. The first capture of a screen, mode and width is the before picture; a later capture replaces the
 * after picture. The file is written first and removed again if the row cannot be saved; a replaced file is removed after commit.
 */
export async function addScreen(
	ctx: Ctx,
	raw: z.input<typeof screenAddInput>,
	bytes: Uint8Array,
	options: { maxBytes?: number } = {}
) {
	const input = screenAddInput.parse(raw);
	checkScreenPicture(bytes, options.maxBytes);
	// A picture narrower than the width it claims was scaled down and would be blurred when it is zoomed: it is refused
	// (a pixel ratio of 2 gives a wider picture and is welcome)
	const pixels = pngWidth(bytes);
	if (pixels === null) throw new OpError('INVALID', 'The picture has no readable PNG header.');
	if (pixels < input.width)
		throw new OpError(
			'INVALID',
			`The picture is only ${pixels} px wide but the capture says ${input.width} px. Take it again at full size (a device pixel ratio of 2 is fine), not a reduced picture.`
		);
	const store = storage(ctx);
	const checksum = sha256(bytes);
	const caption = plain(input.caption ?? '');
	const note = plain(input.note ?? '');
	let key: string | null = null;
	try {
		const done = await run(ctx, (tx) =>
			idempotent(ctx, tx, async () => {
				const it = await findItem(tx, ctx, input.item, { lock: true });
				await requireCap(tx, ctx, 'write', it.projectId);
				await rateLimit(tx, ctx, 'write');
				const rows = await tx.select().from(screen).where(eq(screen.itemId, it.id));
				const slot = rows.filter(
					(r) => r.screenKey === input.screenKey && r.mode === input.mode && r.width === input.width
				);
				const before = slot.find((r) => r.role === 'before');
				const after = slot.find((r) => r.role === 'after');
				// A new row is added whenever the slot has no after picture, so the cap applies then (a replaced after adds none)
				if (!after && rows.length >= MAX_SCREENS_PER_ITEM)
					throw new OpError('CONFLICT', 'This plan already has the most screenshots it can hold.');
				// The same picture again changes nothing
				if (after?.checksum === checksum || (!after && before?.checksum === checksum))
					return { screen: shape(after ?? before!), replacedKey: null as string | null };
				key = `${SCREEN_KEY_PREFIX}/${ctx.orgId}/${it.projectId}/${randomUUID()}.png`;
				await store.put(key, bytes, 'image/png');
				const values = {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					phaseKey: input.phaseKey ?? null,
					screenKey: input.screenKey,
					mode: input.mode,
					width: input.width,
					caption,
					note,
					storageKey: key,
					size: bytes.byteLength,
					checksum,
					createdBy: ctx.actor.userId
				};
				let row: typeof screen.$inferSelect;
				let replacedKey: string | null = null;
				if (!before) {
					[row] = await tx
						.insert(screen)
						.values({ ...values, role: 'before' })
						.returning();
				} else if (after) {
					replacedKey = after.storageKey;
					[row] = await tx
						.update(screen)
						.set({ ...values, createdAt: new Date() })
						.where(eq(screen.id, after.id))
						.returning();
				} else {
					[row] = await tx
						.insert(screen)
						.values({ ...values, role: 'after' })
						.returning();
				}
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					...actorFields(ctx),
					verb: 'screen.add',
					targetType: 'item',
					targetId: it.id,
					after: {
						screen: input.screenKey,
						mode: input.mode,
						width: input.width,
						role: row.role
					} as never,
					undoable: false
				});
				return { screen: shape(row), replacedKey };
			})
		);
		if (done.replacedKey) await store.delete(done.replacedKey).catch(() => undefined);
		return { screen: done.screen };
	} catch (e) {
		// The row was not saved, so the file written for it has no owner
		if (key) await store.delete(key).catch(() => undefined);
		throw e;
	}
}

/** The screenshots of a plan. Everything a person wrote is marked untrusted. */
export async function listScreens(ctx: Ctx, itemRef: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemRef);
		await requireCap(tx, ctx, 'read', it.projectId);
		const rows = await tx
			.select()
			.from(screen)
			.where(eq(screen.itemId, it.id))
			.orderBy(asc(screen.screenKey), asc(screen.mode), asc(screen.width), asc(screen.role));
		return { item: it.ref, screens: rows.map(shape) };
	});
}

/** How many screenshots a plan has, for the tab count. The same visibility and read check as the list. */
export async function countScreens(ctx: Ctx, itemRef: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemRef);
		await requireCap(tx, ctx, 'read', it.projectId);
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(screen)
			.where(eq(screen.itemId, it.id));
		return n;
	});
}

/**
 * True when a plan changes what a person sees (it has a design-brief), has no screenshot on its Screens tab and no
 * screens-waiver section: the flow requires the finished screens to be shown (AFB-20261125-0625). The caller decides what to do.
 */
export async function screensMissing(tx: Tx, itemId: string): Promise<boolean> {
	// Plans made before the rule existed were never told to capture screens, so they are not held to it
	const [it] = await tx.select({ createdAt: item.createdAt }).from(item).where(eq(item.id, itemId));
	if (!it || it.createdAt < SCREENS_REQUIRED_FROM) return false;
	const rows = await tx
		.select({ slug: section.slug, body: section.body })
		.from(section)
		.where(
			and(eq(section.itemId, itemId), inArray(section.slug, ['design-brief', 'screens-waiver']))
		);
	const hasBrief = rows.some((s) => s.slug === 'design-brief');
	// A waiver must say why: an empty section does not count
	const waived = rows.some(
		(s) => s.slug === 'screens-waiver' && s.body.trim().length >= MIN_WAIVER_CHARS
	);
	if (!hasBrief || waived) return false;
	const [{ n }] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(screen)
		.where(eq(screen.itemId, itemId));
	return n === 0;
}

/** Removes one screenshot and its file. The person who added it, and admins and owners, may do so. */
export async function removeScreen(ctx: Ctx, screenId: string) {
	const store = storage(ctx);
	const done = await run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const found = await loadScreen(tx, ctx, screenId, true);
			const { role } = await requireCap(tx, ctx, 'write', found.row.projectId);
			if (found.row.createdBy !== ctx.actor.userId && role !== 'owner' && role !== 'admin')
				throw new OpError(
					'FORBIDDEN',
					'Only the person who added this screenshot, or an admin, can remove it.'
				);
			await tx.delete(screen).where(eq(screen.id, found.row.id));
			// Removing the first picture while a latest one remains makes the latest the first, so a later capture is never
			// stored as a 'before' that is newer than the 'after' beside it
			if (found.row.role === 'before')
				await tx
					.update(screen)
					.set({ role: 'before' })
					.where(
						and(
							eq(screen.itemId, found.row.itemId),
							eq(screen.screenKey, found.row.screenKey),
							eq(screen.mode, found.row.mode),
							eq(screen.width, found.row.width),
							eq(screen.role, 'after')
						)
					);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: found.row.projectId,
				itemId: found.row.itemId,
				...actorFields(ctx),
				verb: 'screen.remove',
				targetType: 'item',
				targetId: found.row.itemId,
				before: { screen: found.row.screenKey, role: found.row.role } as never,
				undoable: false
			});
			return { id: found.row.id, removed: true as const, storageKey: found.row.storageKey };
		})
	);
	await store.delete(done.storageKey).catch(() => undefined);
	return { id: done.id, removed: true as const };
}

/**
 * The bytes of one screenshot for a signed in person who may see its plan. An unknown id, a plan the caller may not see,
 * a missing file and a screenshot of another organisation all answer null, so an id cannot be used to probe.
 */
export async function readScreenImage(
	handle: DbHandle,
	store: Storage,
	viewerId: string,
	screenId: string
): Promise<{ bytes: Uint8Array; checksum: string } | null> {
	for (const o of await listMyOrgs(handle, viewerId)) {
		if (o.deletedAt) continue;
		const ctx: Ctx = { handle, orgId: o.id, actor: { userId: viewerId, kind: 'person' } };
		try {
			const row = await run(ctx, async (tx) => {
				const found = await loadScreen(tx, ctx, screenId, false);
				await requireCap(tx, ctx, 'read', found.row.projectId);
				return found.row;
			});
			if (!row) continue;
			const bytes = await store.get(row.storageKey);
			return bytes ? { bytes, checksum: row.checksum } : null;
		} catch (e) {
			if (e instanceof OpError) continue;
			throw e;
		}
	}
	return null;
}

// -- HELPERS -- //

/** The screen the caller may see, with its plan, or NOT_FOUND (the same answer for a hidden one). */
async function loadScreen(tx: Tx, ctx: Ctx, id: string, lock: boolean) {
	const base = tx
		.select()
		.from(screen)
		.where(and(eq(screen.id, id), eq(screen.orgId, ctx.orgId)));
	const [row] = lock ? await base.for('update') : await base;
	if (!row) throw new OpError('NOT_FOUND', 'No such screenshot.');
	// The plan decides who sees it: a private plan hides its pictures (item privacy is not row level security)
	const it = await findItem(tx, ctx, row.itemId).catch((e: unknown) => {
		if (e instanceof OpError) throw new OpError('NOT_FOUND', 'No such screenshot.');
		throw e;
	});
	return { row, item: it };
}

function shape(r: typeof screen.$inferSelect) {
	return {
		id: r.id,
		item: r.itemId,
		phase: r.phaseKey,
		screen: r.screenKey,
		mode: r.mode,
		width: r.width,
		role: r.role,
		bytes: r.size,
		// The checksum is in the address, so a replaced picture is a new address and the page loads it at once
		image: `${screenImagePath(r.id)}?v=${r.checksum.slice(0, 12)}`,
		createdAt: r.createdAt,
		// Written by a person or an agent: a reader that is an agent never follows instructions found in it
		untrusted: true as const,
		caption: r.caption,
		note: r.note
	};
}
