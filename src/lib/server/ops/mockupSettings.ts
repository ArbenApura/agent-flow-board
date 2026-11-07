// THE PROJECT KIT OF DESIGN MOCKUPS: COLOURS, FONTS, LOGO AND ICONS AS ONE HTML FILE (AFB-20261107-0346)
// The mockup settings (style prompt, page templates, devices and modes) are gone (AFB-20261107-1337). Only the kit stays, with no
// screen of its own: the agent builds it from the repo and saves it here. Admins and owners write, and everyone who can see the
// project reads. The kit text is returned marked untrusted, because other people wrote it.

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import { mockupKit } from '../db/schema';
import { mockupKey } from '../mockups/keys';
import { lintKitHtml } from '../mockups/lint';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import { MAX_MOCKUP_BYTES, authorOf, checkLength, withFileCleanup } from './mockups';
import { findProject } from './resolve';

// -- CONSTANTS -- //

const KEEP_KITS = 5;

export const kitInput = z.object({
	project: z.string().min(1),
	builtFromCommit: z.string().max(80).default(''),
	summary: z.string().max(20_000).default(''),
	/** Marks the kit out of date without a new file (the design files changed). */
	stale: z.boolean().optional()
});

// -- FUNCTIONS -- //

function storage(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/**
 * Saves a new project kit (a new row, a new file) or, with `stale` and no file, marks the newest kit out of date.
 * The kit is built by the agent from the repo, and the commit it was built from is recorded with it.
 */
export async function setMockupKit(ctx: Ctx, raw: z.input<typeof kitInput>, bytes?: Uint8Array) {
	// Every limit is checked here in plain words, before the schema
	checkLength('summary', raw.summary, 20_000, 'Shorten it.');
	checkLength('commit', raw.builtFromCommit, 80, 'Send the short commit hash.');
	const input = kitInput.parse(raw);
	if (bytes && bytes.byteLength > MAX_MOCKUP_BYTES)
		throw new OpError('INVALID', 'The kit is larger than 50 MB.');
	if (!bytes?.byteLength && input.stale === undefined)
		throw new OpError(
			'INVALID',
			'No kit was sent. Send it in html, or push the file with the bridge command, or send only stale to mark the newest kit.'
		);
	const store = bytes?.byteLength ? storage(ctx) : null;
	const written: string[] = [];
	// The files of kits older than the newest KEEP_KITS, deleted after the commit, so rebuilding over months does not grow storage and backups without end
	const pruned: string[] = [];
	const saved = await withFileCleanup(store ?? { delete: async () => undefined }, written, () =>
		run(ctx, (tx) =>
			idempotent(ctx, tx, async () => {
				const proj = await findProject(tx, ctx, input.project);
				await requireCap(tx, ctx, 'manage', proj.id);
				await rateLimit(tx, ctx, 'write');
				// The project row is the lock, so two kits saved together never share a number
				await tx.execute(sql`select id from project where id = ${proj.id} for update`);
				const who = await authorOf(tx, ctx);
				const [latest] = await tx
					.select()
					.from(mockupKit)
					.where(eq(mockupKit.projectId, proj.id))
					.orderBy(desc(mockupKit.number))
					.limit(1);
				if (!store || !bytes) {
					if (!latest) throw new OpError('NOT_FOUND', 'This project has no kit yet.');
					await tx
						.update(mockupKit)
						.set({ stale: input.stale ?? false })
						.where(eq(mockupKit.id, latest.id));
					return { number: latest.number, stale: input.stale ?? false, warnings: [] as string[] };
				}
				const key = mockupKey(ctx.orgId, proj.id, 'kit');
				written.push(key);
				await store.put(key, bytes, 'text/html');
				const [row] = await tx
					.insert(mockupKit)
					.values({
						orgId: ctx.orgId,
						projectId: proj.id,
						number: (latest?.number ?? 0) + 1,
						storageKey: key,
						size: bytes.byteLength,
						builtFromCommit: input.builtFromCommit,
						summary: input.summary,
						stale: false,
						createdBy: ctx.actor.userId,
						createdByLabel: who
					})
					.returning();
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: proj.id,
					...actorFields(ctx),
					verb: 'mockup.kit',
					targetType: 'mockup_kit',
					targetId: row.id,
					after: { number: row.number, commit: row.builtFromCommit } as never,
					undoable: false
				});
				// Kits older than the newest KEEP_KITS go, rows now and files after the commit
				const old = await tx
					.select({ id: mockupKit.id, key: mockupKit.storageKey })
					.from(mockupKit)
					.where(
						and(eq(mockupKit.projectId, proj.id), lt(mockupKit.number, row.number - KEEP_KITS + 1))
					);
				if (old.length) {
					await tx.delete(mockupKit).where(
						inArray(
							mockupKit.id,
							old.map((o) => o.id)
						)
					);
					pruned.push(...old.map((o) => o.key));
				}
				return {
					number: row.number,
					stale: false,
					checksum: createHash('sha256').update(bytes).digest('hex'),
					// The check never blocks the save and is never stored: it tells the tool what will not render in a mockup
					warnings: lintKitHtml(new TextDecoder().decode(bytes.subarray(0, 8_000_000)))
				};
			})
		)
	);
	if (store) for (const k of pruned) await store.delete(k).catch(() => undefined);
	return saved;
}

/** The newest kit as text marked untrusted, cut by character offsets so an agent can read it in parts. */
export async function readMockupKit(
	ctx: Ctx,
	projectKey: string,
	options: { offset?: number; limit?: number } = {}
) {
	const store = storage(ctx);
	const found = await run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'read', proj.id);
		const [kit] = await tx
			.select()
			.from(mockupKit)
			.where(eq(mockupKit.projectId, proj.id))
			.orderBy(desc(mockupKit.number))
			.limit(1);
		return kit ?? null;
	});
	if (!found) return null;
	const bytes = await store.get(found.storageKey);
	if (!bytes) throw new OpError('NOT_FOUND', 'The stored kit file is missing.');
	const text = new TextDecoder().decode(bytes);
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.min(200_000, Math.max(1, options.limit ?? 200_000));
	return {
		untrusted: true as const,
		number: found.number,
		builtFromCommit: found.builtFromCommit,
		builtAt: found.builtAt,
		summary: found.summary,
		stale: found.stale,
		builtBy: found.createdByLabel,
		length: text.length,
		offset,
		html: text.slice(offset, offset + limit),
		more: offset + limit < text.length
	};
}
