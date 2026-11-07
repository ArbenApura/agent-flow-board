// MOCKUP SETTINGS OF A PROJECT: THE STYLE PROMPT, PAGE TEMPLATES, SCREENS, THEMES AND THE PROJECT KIT (AFB-20261107-0346)
// Admins and owners write. Everyone who can see the project reads. Every text an agent reads is returned marked untrusted
// with its author and last editor, because other people wrote it.

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import { MOCKUP_SCREEN_KEYS, mockupKit, mockupProject, mockupTemplate } from '../db/schema';
import { mockupKey } from '../mockups/keys';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import { MAX_MOCKUP_BYTES, authorOf, withFileCleanup } from './mockups';
import { findProject } from './resolve';

// -- CONSTANTS -- //

const MAX_THEMES = 10;
const MAX_TEMPLATES = 50;
const KEEP_KITS = 5;

export const styleInput = z.object({
	project: z.string().min(1),
	style: z.string().max(20_000).optional(),
	screens: z
		.array(z.enum(MOCKUP_SCREEN_KEYS as [string, ...string[]]))
		.min(1)
		.max(4)
		.optional(),
	themes: z.array(z.string().min(1).max(40)).max(MAX_THEMES).optional()
});
export const templateInput = z.object({
	project: z.string().min(1),
	name: z.string().min(1).max(80),
	prompt: z.string().max(20_000).default('')
});
export const kitInput = z.object({
	project: z.string().min(1),
	builtFromCommit: z.string().max(80).default(''),
	summary: z.string().max(20_000).default(''),
	/** Marks the kit out of date without a new file (the design files changed). */
	stale: z.boolean().optional()
});

// -- FUNCTIONS -- //

const uniq = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))];

function storage(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/** The project's mockup settings with its templates and the newest kit's details (never the kit file). */
export async function getMockupSettings(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		const { role } = await requireCap(tx, ctx, 'read', proj.id);
		const [settings] = await tx
			.select()
			.from(mockupProject)
			.where(eq(mockupProject.projectId, proj.id));
		const templates = await tx
			.select()
			.from(mockupTemplate)
			.where(eq(mockupTemplate.projectId, proj.id))
			.orderBy(asc(mockupTemplate.name));
		const [kit] = await tx
			.select()
			.from(mockupKit)
			.where(eq(mockupKit.projectId, proj.id))
			.orderBy(desc(mockupKit.number))
			.limit(1);
		return {
			project: { id: proj.id, key: proj.key },
			untrusted: true as const,
			style: {
				text: settings?.style ?? '',
				updatedBy: settings?.updatedByLabel ?? null,
				updatedAt: settings?.updatedAt ?? null
			},
			screens: settings?.screens ?? [...MOCKUP_SCREEN_KEYS],
			themes: settings?.themes ?? [],
			templates: templates.map((t) => ({
				id: t.id,
				name: t.name,
				prompt: t.prompt,
				updatedBy: t.updatedByLabel,
				updatedAt: t.updatedAt
			})),
			kit: kit
				? {
						number: kit.number,
						builtFromCommit: kit.builtFromCommit,
						builtAt: kit.builtAt,
						summary: kit.summary,
						size: kit.size,
						stale: kit.stale,
						builtBy: kit.createdByLabel
					}
				: null,
			canManage: role === 'owner' || role === 'admin'
		};
	});
}

/** Saves the style prompt, screens and themes. Only the fields that are sent change. */
export async function setMockupStyle(ctx: Ctx, raw: z.input<typeof styleInput>) {
	const input = styleInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'manage', proj.id);
			await rateLimit(tx, ctx, 'write');
			const who = await authorOf(tx, ctx);
			const patch = {
				...(input.style !== undefined ? { style: input.style } : {}),
				...(input.screens ? { screens: uniq(input.screens) } : {}),
				...(input.themes ? { themes: uniq(input.themes) } : {})
			};
			const [row] = await tx
				.insert(mockupProject)
				.values({
					projectId: proj.id,
					orgId: ctx.orgId,
					...patch,
					updatedBy: ctx.actor.userId,
					updatedByLabel: who
				})
				.onConflictDoUpdate({
					target: mockupProject.projectId,
					set: {
						...patch,
						updatedBy: ctx.actor.userId,
						updatedByLabel: who,
						updatedAt: sql`now()`,
						version: sql`${mockupProject.version} + 1`
					}
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				...actorFields(ctx),
				verb: 'mockup.style',
				targetType: 'mockup_project',
				targetId: proj.id,
				after: { screens: row.screens, themes: row.themes } as never,
				undoable: false
			});
			return { style: row.style, screens: row.screens, themes: row.themes };
		})
	);
}

/** Creates or changes a named page template. */
export async function saveMockupTemplate(ctx: Ctx, raw: z.input<typeof templateInput>) {
	const input = templateInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'manage', proj.id);
			await rateLimit(tx, ctx, 'write');
			const name = input.name.trim();
			const have = await tx
				.select({ name: mockupTemplate.name })
				.from(mockupTemplate)
				.where(eq(mockupTemplate.projectId, proj.id));
			if (have.length >= MAX_TEMPLATES && !have.some((t) => t.name === name))
				throw new OpError('CONFLICT', 'This project has the most templates it can hold.');
			const who = await authorOf(tx, ctx);
			const [row] = await tx
				.insert(mockupTemplate)
				.values({
					orgId: ctx.orgId,
					projectId: proj.id,
					name,
					prompt: input.prompt,
					updatedBy: ctx.actor.userId,
					updatedByLabel: who
				})
				.onConflictDoUpdate({
					target: [mockupTemplate.projectId, mockupTemplate.name],
					set: {
						prompt: input.prompt,
						updatedBy: ctx.actor.userId,
						updatedByLabel: who,
						updatedAt: sql`now()`
					}
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				...actorFields(ctx),
				verb: 'mockup.template',
				targetType: 'mockup_template',
				targetId: row.id,
				after: { name } as never,
				undoable: false
			});
			return { id: row.id, name: row.name };
		})
	);
}

export async function deleteMockupTemplate(ctx: Ctx, projectKey: string, name: string) {
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, projectKey);
			await requireCap(tx, ctx, 'manage', proj.id);
			await rateLimit(tx, ctx, 'write');
			const gone = await tx
				.delete(mockupTemplate)
				.where(and(eq(mockupTemplate.projectId, proj.id), eq(mockupTemplate.name, name.trim())))
				.returning({ id: mockupTemplate.id });
			if (gone.length === 0) throw new OpError('NOT_FOUND', `No template named "${name}".`);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				...actorFields(ctx),
				verb: 'mockup.template-delete',
				targetType: 'mockup_template',
				targetId: gone[0].id,
				before: { name } as never,
				undoable: false
			});
			return { name, removed: true as const };
		})
	);
}

/**
 * Saves a new project kit (a new row, a new file) or, with `stale` and no file, marks the newest kit out of date.
 * The kit is built by the agent from the repo, and the commit it was built from is recorded with it.
 */
export async function setMockupKit(ctx: Ctx, raw: z.input<typeof kitInput>, bytes?: Uint8Array) {
	const input = kitInput.parse(raw);
	if (bytes && bytes.byteLength > MAX_MOCKUP_BYTES)
		throw new OpError('INVALID', 'The kit is larger than 50 MB.');
	if (!bytes?.byteLength && input.stale === undefined)
		throw new OpError('INVALID', 'Send the kit file, or set stale to mark the kit out of date.');
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
					return { number: latest.number, stale: input.stale ?? false };
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
					checksum: createHash('sha256').update(bytes).digest('hex')
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
