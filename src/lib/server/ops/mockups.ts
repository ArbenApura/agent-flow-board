// MOCKUP VERBS: PUBLISH, VERSIONS, RESTORE, LINK, TRASH AND THE PUBLIC LINK (AFB-20261107-0346)
// A build follows the mockup of its plan (AFB-20261110-2331). Every version owns its own stored file and nothing is ever deleted by a restore.
// Everything an agent reads that another person wrote is returned marked untrusted, with its author.

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import { syncMockupsOfItem } from '../db/mockupSync';
import { item, mockup, mockupPin, mockupVersion, project, user } from '../db/schema';
import { KIT_MARKER, loadKit, wantsKit, type LoadedKit } from '../mockups/kitHead';
import { mockupKey } from '../mockups/keys';
import { lintMockupHtml } from '../mockups/lint';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import { planWorked, readStateOf, unreadLine } from './mockupReads';
import { findItem, findProject } from './resolve';

// -- TYPES -- //

export type MockupRow = typeof mockup.$inferSelect;
type ItemRow = typeof item.$inferSelect;

// -- CONSTANTS -- //

/** The size cap for one stored version (confirmed by the owner on 2026-11-07). Every entry point reads this one value. */
export const MAX_MOCKUP_BYTES = 50 * 1024 * 1024;
/** A screenshot is a small PNG, never a second page. */
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
/** The most characters of notes a version holds. */
export const MAX_NOTES_CHARS = 20_000;
/** How much of a page the faithful rendering check reads. */
const LINT_BYTES = 8_000_000;

export const publishInput = z.object({
	/** A project key. Only a mockup that belongs to no plan names a project. */
	project: z.string().min(1).optional(),
	/** The plan the mockup belongs to (reference or id). */
	item: z.string().min(1).optional(),
	/** A new version of this mockup. */
	mockup: z.string().uuid().optional(),
	/** A second mockup on a plan that already has one, only when the person asked for it. */
	another: z.boolean().default(false),
	title: z.string().min(1).max(200).optional(),
	keepNotes: z.string().max(20_000).default(''),
	freeNotes: z.string().max(20_000).default('')
});
export type PublishInput = z.input<typeof publishInput>;

// -- FUNCTIONS -- //

const sha256 = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export const hashToken = (token: string) => sha256(token);

function storage(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/** The text of a stored file, or null when the file is missing. */
const textOf = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

/**
 * Who sees a mockup: anyone on the project when it is public, and only the creator when it is private. A mockup on a
 * private plan carries the plan's visibility, so the plan's creator is the one person who may see it.
 */
export function canSeeMockup(
	m: Pick<MockupRow, 'visibility' | 'createdBy'>,
	userId: string,
	plan?: Pick<ItemRow, 'createdBy'> | null
): boolean {
	if (m.visibility === 'public') return true;
	const owner = plan ? plan.createdBy : m.createdBy;
	return owner !== null && owner === userId;
}

/** The display name of the acting person or tool, for pins and notes. */
export async function authorOf(tx: Tx, ctx: Ctx): Promise<string> {
	if (ctx.actor.label) return ctx.actor.label;
	const [u] = await tx.select({ name: user.name }).from(user).where(eq(user.id, ctx.actor.userId));
	return u?.name ?? 'Someone';
}

/** The mockup the caller may see, with its plan, or NOT_FOUND (the same answer for a hidden one). */
export async function loadMockup(
	tx: Tx,
	ctx: Ctx,
	id: string,
	options: { lock?: boolean; trashed?: boolean } = {}
) {
	const base = tx
		.select()
		.from(mockup)
		.where(
			and(
				eq(mockup.id, id),
				eq(mockup.orgId, ctx.orgId),
				options.trashed ? isNotNull(mockup.trashedAt) : isNull(mockup.trashedAt)
			)
		);
	const [m] = options.lock ? await base.for('update') : await base;
	if (!m) throw new OpError('NOT_FOUND', 'No such mockup.');
	const { role } = await requireCap(tx, ctx, 'read', m.projectId);
	const plan = m.itemId ? await planOf(tx, m.itemId) : null;
	if (!canSeeMockup(m, ctx.actor.userId, plan)) throw new OpError('NOT_FOUND', 'No such mockup.');
	// A mockup goes with its plan: while the plan is in the trash the mockup is hidden, and it is back when the plan is restored
	// (AFB-20261110-2338). A mockup in its own trash is still reachable there, so it can be restored
	if (!options.trashed && plan?.deletedAt) throw new OpError('NOT_FOUND', 'No such mockup.');
	return { m, plan, role };
}

async function planOf(tx: Tx, itemId: string) {
	const [it] = await tx.select().from(item).where(eq(item.id, itemId));
	return it ?? null;
}

/** Refuses a text over its limit with a sentence that says how long it is and what to do. */
export function checkLength(label: string, text: string | undefined, max: number, advice: string) {
	if (text !== undefined && text.length > max)
		throw new OpError(
			'INVALID',
			`The ${label} ${label.endsWith('s') ? 'are' : 'is'} ${text.length.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}. ${advice}`
		);
}

/** The warnings of the faithful rendering check for a page, with the marker notes. Only the start of a very large page is read. */
function warningsFor(bytes: Uint8Array, kit: LoadedKit | null): string[] {
	const html = new TextDecoder().decode(bytes.subarray(0, LINT_BYTES));
	const warnings = lintMockupHtml(html, kit?.facts);
	if (bytes.byteLength > LINT_BYTES)
		warnings.push(
			`The page is larger than ${LINT_BYTES / 1_000_000} MB, so only its first ${LINT_BYTES / 1_000_000} MB was checked for what will not render. The rest was saved but not checked.`
		);
	if (wantsKit(html) && !kit)
		warnings.push(
			`This page starts with ${KIT_MARKER}, but the project has no stylesheet and fonts saved yet, so the board adds nothing. Ask for the kit to be made first, or embed the fonts in the page.`
		);
	else if (wantsKit(html) && kit && kit.head === null)
		warnings.push(
			`This page starts with ${KIT_MARKER}, but the project's kit has no head between its markers, so the board adds nothing. Rebuild the kit with its head.`
		);
	return warnings;
}

function checkBytes(bytes: Uint8Array) {
	if (bytes.byteLength === 0) throw new OpError('INVALID', 'The mockup file is empty.');
	if (bytes.byteLength > MAX_MOCKUP_BYTES)
		throw new OpError('INVALID', 'The mockup is larger than 50 MB.');
}

function checkScreenshot(bytes: Uint8Array | undefined) {
	if (!bytes || bytes.byteLength === 0) return;
	if (bytes.byteLength > MAX_SCREENSHOT_BYTES)
		throw new OpError('INVALID', 'The screenshot is larger than 5 MB.');
	if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b))
		throw new OpError('INVALID', 'The screenshot must be a PNG image.');
}

/**
 * Runs a write that stores files before its row. When the write fails, the files it stored are deleted, so a refused or
 * failed call leaves nothing behind that no row points at (the purges only find files through rows).
 */
export async function withFileCleanup<T>(
	store: { delete(key: string): Promise<void> },
	written: string[],
	work: () => Promise<T>
): Promise<T> {
	try {
		return await work();
	} catch (e) {
		await Promise.all(written.map((k) => store.delete(k).catch(() => undefined)));
		throw e;
	}
}

/**
 * Publishes a mockup: the first version of a new one, or a new version of one that exists. The file is written before the
 * row, so a failed write leaves no row, and a failed row has its file deleted again (withFileCleanup). The mockup
 * row (or the plan row, for a first publish) is locked, so two publishes never share a version number.
 */
export async function publishMockup(
	ctx: Ctx,
	raw: PublishInput,
	bytes: Uint8Array,
	screenshot?: Uint8Array
) {
	// Every limit is checked here in plain words, before the schema, so the person or tool is told what to do and not a schema path
	checkLength('Keep notes', raw.keepNotes, MAX_NOTES_CHARS, 'Shorten them.');
	checkLength('Free notes', raw.freeNotes, MAX_NOTES_CHARS, 'Shorten them.');
	if (!bytes || bytes.byteLength === 0)
		throw new OpError(
			'INVALID',
			'No page was sent. Send it in html, or push the file with the bridge command.'
		);
	const input = publishInput.parse(raw);
	// The size is checked before anything is read from the database or written to storage
	checkBytes(bytes);
	checkScreenshot(screenshot);
	const store = storage(ctx);
	if (!input.mockup && !input.item && !input.project)
		throw new OpError('INVALID', 'Name the plan (item) or the project the mockup belongs to.');
	const written: string[] = [];
	return withFileCleanup(store, written, () =>
		run(ctx, (tx) =>
			idempotent(ctx, tx, async () => {
				let target: MockupRow | undefined;
				let plan: ItemRow | null = null;
				let projectId: string;
				if (input.mockup) {
					const loaded = await loadMockup(tx, ctx, input.mockup, { lock: true });
					target = loaded.m;
					plan = loaded.plan;
					projectId = target.projectId;
				} else if (input.item) {
					// The plan row is the lock for a first publish, so two first publishes make one mockup
					plan = await findItem(tx, ctx, input.item, { lock: true });
					projectId = plan.projectId;
					if (!input.another) {
						const [existing] = await tx
							.select()
							.from(mockup)
							.where(
								and(
									eq(mockup.itemId, plan.id),
									isNull(mockup.trashedAt),
									eq(mockup.orgId, ctx.orgId)
								)
							)
							.orderBy(desc(mockup.createdAt))
							.limit(1)
							.for('update');
						target = existing;
					}
				} else {
					projectId = (await findProject(tx, ctx, input.project!)).id;
				}
				await requireCap(tx, ctx, 'write', projectId);
				await rateLimit(tx, ctx, 'write');
				const number = target
					? ((
							await tx
								.select({ n: sql<number>`coalesce(max(${mockupVersion.number}), 0)` })
								.from(mockupVersion)
								.where(eq(mockupVersion.mockupId, target.id))
						)[0]?.n ?? 0) + 1
					: 1;
				const key = mockupKey(ctx.orgId, projectId, 'html');
				const shotKey = screenshot?.byteLength ? mockupKey(ctx.orgId, projectId, 'png') : null;
				written.push(key);
				await store.put(key, bytes, 'text/html');
				if (shotKey && screenshot) {
					written.push(shotKey);
					await store.put(shotKey, screenshot, 'image/png');
				}
				if (!target) {
					const title = input.title ?? plan?.title ?? 'Untitled mockup';
					[target] = await tx
						.insert(mockup)
						.values({
							orgId: ctx.orgId,
							projectId,
							itemId: plan?.id ?? null,
							title,
							currentVersion: 1,
							visibility: plan?.visibility ?? 'public',
							createdBy: ctx.actor.userId
						})
						.returning();
				} else {
					[target] = await tx
						.update(mockup)
						.set({
							currentVersion: number,
							title: input.title ?? target.title,
							updatedAt: sql`now()`,
							version: sql`${mockup.version} + 1`
						})
						.where(eq(mockup.id, target.id))
						.returning();
				}
				const [row] = await tx
					.insert(mockupVersion)
					.values({
						orgId: ctx.orgId,
						projectId,
						mockupId: target.id,
						number,
						storageKey: key,
						size: bytes.byteLength,
						checksum: sha256(bytes),
						keepNotes: input.keepNotes,
						freeNotes: input.freeNotes,
						screenshotKey: shotKey,
						createdBy: ctx.actor.userId
					})
					.returning();
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId,
					itemId: target.itemId,
					...actorFields(ctx),
					verb: number === 1 ? 'mockup.create' : 'mockup.version',
					targetType: 'mockup',
					targetId: target.id,
					after: { title: target.title, version: number, size: row.size } as never,
					undoable: false
				});
				const [pk] = await tx
					.select({ key: project.key })
					.from(project)
					.where(eq(project.id, projectId));
				// The check never blocks the save and is never stored: it only tells the person or tool what will not render
				// A kit that cannot be read only means fewer warnings: the check must never stop a save
				const kit = await loadKit(tx, ctx.services?.storage, projectId).catch(() => null);
				return {
					mockup: publicMockup(target),
					version: publicVersion(row),
					projectKey: pk?.key ?? '',
					warnings: warningsFor(bytes, kit)
				};
			})
		)
	);
}

/** A mockup row without its public address hash. */
export function publicMockup(m: MockupRow) {
	const { publicTokenHash, ...rest } = m;
	return { ...rest, publicLinkOn: m.publicEnabled && publicTokenHash !== null };
}

/** A version row without its storage keys. */
export function publicVersion(v: typeof mockupVersion.$inferSelect) {
	const { storageKey: _storageKey, screenshotKey, ...rest } = v;
	return { ...rest, hasScreenshot: screenshotKey !== null };
}

/** Marks written notes as untrusted text with their author, for an agent that reads them. */
async function notesOf(tx: Tx, v: typeof mockupVersion.$inferSelect) {
	let author: string | null = null;
	if (v.createdBy) {
		const [u] = await tx.select({ name: user.name }).from(user).where(eq(user.id, v.createdBy));
		author = u?.name ?? null;
	}
	return {
		untrusted: true as const,
		author,
		keep: v.keepNotes,
		free: v.freeNotes
	};
}

/** One mockup with its versions (newest first) and the notes of the current one. */
export async function getMockup(ctx: Ctx, id: string, version?: number) {
	return run(ctx, async (tx) => {
		const { m, plan, role } = await loadMockup(tx, ctx, id);
		const versions = await tx
			.select()
			.from(mockupVersion)
			.where(eq(mockupVersion.mockupId, m.id))
			.orderBy(desc(mockupVersion.number));
		const current =
			versions.find((v) => v.number === (version ?? m.currentVersion)) ?? versions[0] ?? null;
		return {
			mockup: publicMockup(m),
			plan: plan
				? { id: plan.id, ref: plan.ref, title: plan.title, visibility: plan.visibility }
				: null,
			versions: versions.map(publicVersion),
			notes: current ? await notesOf(tx, current) : null,
			canWrite: ['owner', 'admin', 'member'].includes(role),
			canManage: role === 'owner' || role === 'admin'
		};
	});
}

/** The HTML of one version, as text marked untrusted. A part is cut by character offsets so an agent can fetch only what it needs. */
export async function readMockupHtml(
	ctx: Ctx,
	id: string,
	options: { version?: number; offset?: number; limit?: number } = {}
) {
	const store = storage(ctx);
	const found = await run(ctx, async (tx) => {
		const { m } = await loadMockup(tx, ctx, id);
		const n = options.version ?? m.currentVersion;
		const [v] = await tx
			.select()
			.from(mockupVersion)
			.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, n)));
		if (!v) throw new OpError('NOT_FOUND', `This mockup has no version ${n}.`);
		return { v, title: m.title };
	});
	const text = textOf(await store.get(found.v.storageKey));
	if (text === null) throw new OpError('NOT_FOUND', 'The stored file of this version is missing.');
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.min(200_000, Math.max(1, options.limit ?? 200_000));
	return {
		untrusted: true as const,
		title: found.title,
		version: found.v.number,
		length: text.length,
		offset,
		html: text.slice(offset, offset + limit),
		more: offset + limit < text.length
	};
}

export const listInput = z.object({
	project: z.string().min(1),
	item: z.string().min(1).optional(),
	q: z.string().max(200).optional(),
	trashed: z.boolean().default(false),
	limit: z.number().int().min(1).max(200).default(100)
});

/** The mockups of one project the caller may see, newest first. */
export async function listMockups(ctx: Ctx, raw: z.input<typeof listInput>) {
	const input = listInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'read', proj.id);
		let itemId: string | undefined;
		if (input.item) itemId = (await findItem(tx, ctx, input.item)).id;
		const rows: MockupRow[] = await tx
			.select()
			.from(mockup)
			.where(
				and(
					eq(mockup.projectId, proj.id),
					eq(mockup.orgId, ctx.orgId),
					input.trashed ? isNotNull(mockup.trashedAt) : isNull(mockup.trashedAt),
					itemId ? eq(mockup.itemId, itemId) : undefined,
					// A mockup whose plan is in the trash is left out here, before the limit, so it never crowds out a live one
					input.trashed
						? undefined
						: sql`not exists (select 1 from ${item} where ${item.id} = ${mockup.itemId} and ${item.deletedAt} is not null)`,
					input.q ? ilike(mockup.title, `%${input.q.replace(/[%_\\]/g, '\\$&')}%`) : undefined
				)
			)
			.orderBy(desc(mockup.updatedAt))
			.limit(input.limit);
		const planIds = [...new Set(rows.map((r) => r.itemId).filter((v): v is string => v !== null))];
		const plans: ItemRow[] = planIds.length
			? await tx.select().from(item).where(inArray(item.id, planIds))
			: [];
		const planById = new Map(plans.map((p) => [p.id, p]));
		// A mockup whose plan is in the trash is left out of the live list (the mockup trash still shows its own)
		const visible = rows.filter((m) => {
			const plan = m.itemId ? (planById.get(m.itemId) ?? null) : null;
			if (!input.trashed && plan?.deletedAt) return false;
			return canSeeMockup(m, ctx.actor.userId, plan);
		});
		const counts = visible.length
			? await tx
					.select({
						mockupId: mockupVersion.mockupId,
						n: sql<number>`count(*)::int`
					})
					.from(mockupVersion)
					.where(
						sql`${mockupVersion.mockupId} in (${sql.join(
							visible.map((m) => sql`${m.id}::uuid`),
							sql`, `
						)})`
					)
					.groupBy(mockupVersion.mockupId)
			: [];
		const byId = new Map(counts.map((c) => [c.mockupId, c.n]));
		// Which mockups have a screenshot on their current version, for the thumbnail
		const shots = visible.length
			? await tx
					.select({ mockupId: mockupVersion.mockupId, number: mockupVersion.number })
					.from(mockupVersion)
					.where(
						and(
							inArray(
								mockupVersion.mockupId,
								visible.map((m) => m.id)
							),
							isNotNull(mockupVersion.screenshotKey)
						)
					)
			: [];
		const hasShot = new Set(shots.map((s) => `${s.mockupId}:${s.number}`));
		// The mockups of one plan carry how much of each was read, for the audit and a build that asks (AFB-20261110-2331)
		const read = itemId ? await readStateOf(tx, visible) : null;
		return {
			mockups: visible.map((m) => {
				const plan = m.itemId ? planById.get(m.itemId) : undefined;
				const state = read?.get(m.id);
				return {
					...publicMockup(m),
					versions: byId.get(m.id) ?? 1,
					hasShot: hasShot.has(`${m.id}:${m.currentVersion}`),
					plan: plan ? { ref: plan.ref, title: plan.title } : null,
					...(state
						? {
								htmlLength: state.htmlLength,
								readChars: state.readChars,
								readComplete: state.readComplete
							}
						: {})
				};
			})
		};
	});
}

// -- THE MOCKUP OF A CLAIMED PLAN -- //

/** The fixed line a claim reply carries when the plan has a mockup. Server text only: no mockup text is ever put in it. */
export const MOCKUP_RULE =
	'This plan has a mockup, and the build follows it. Before any visible code, read its whole HTML with mockup_get, passing your sessionId, part by part until nextOffset is null: the notes and pins never replace the HTML. Then write the "Mockup inventory" and the "Mockup read" line in the design-brief section and build what the mockup shows with the project real components and tokens. Its structure, order, text, states and interactions are binding. Never skip it, never design your own screen in its place, and never unlink or trash it to pass: the last step of a phase is refused while it is unread.';

const CLAIM_MOCKUPS_MAX = 5;
const CLAIM_TITLE_CHARS = 120;

/**
 * What a claim reply says about the plan's mockups (AFB-20261109-1314): `{}` when the plan has none, the list and the
 * rule when it has, and `mockupsUnavailable` when the lookup failed. It never throws, because the claim already
 * happened and a lookup problem must not turn it into an error.
 */
export async function claimMockups(
	ctx: Ctx,
	itemRef: string
): Promise<
	| Record<string, never>
	| { mockupsUnavailable: true }
	| {
			mockups: {
				id: string;
				title: string;
				currentVersion: number;
				openPins: number;
				htmlLength: number | null;
				readChars: number;
				readComplete: boolean;
				untrusted: true;
			}[];
			moreMockups?: number;
			mockupRule: string;
			mockupNotice?: string;
	  }
> {
	try {
		// A savepoint inside the open call transaction: a database error here rolls back only this lookup, so the claim's own
		// transaction is not left aborted
		return await run(ctx, (outer) =>
			outer.transaction(async (sp) => {
				const tx = sp as unknown as Tx;
				const plan = await findItem(tx, ctx, itemRef);
				await requireCap(tx, ctx, 'read', plan.projectId);
				const rows = await tx
					.select()
					.from(mockup)
					.where(
						and(eq(mockup.itemId, plan.id), eq(mockup.orgId, ctx.orgId), isNull(mockup.trashedAt))
					)
					.orderBy(desc(mockup.updatedAt));
				const visible = rows.filter((m) => canSeeMockup(m, ctx.actor.userId, plan));
				if (!visible.length) return {};
				const shown = visible.slice(0, CLAIM_MOCKUPS_MAX);
				// One grouped query: the open pins of each mockup's current version
				const pins = await tx
					.select({
						mockupId: mockupPin.mockupId,
						version: mockupPin.versionNumber,
						n: sql<number>`count(*)::int`
					})
					.from(mockupPin)
					.where(
						and(
							inArray(
								mockupPin.mockupId,
								shown.map((m) => m.id)
							),
							isNull(mockupPin.resolvedAt)
						)
					)
					.groupBy(mockupPin.mockupId, mockupPin.versionNumber);
				const open = new Map(pins.map((p) => [`${p.mockupId}:${p.version}`, p.n]));
				// How much of each was read so far, by anyone in the project (AFB-20261110-2331). Every mockup of the plan counts
				// for the notice, also the ones past the five listed here
				const read = await readStateOf(tx, visible);
				const notice = unreadLine(visible.map((m) => read.get(m.id)!));
				return {
					mockups: shown.map((m) => ({
						id: m.id,
						title:
							m.title.length > CLAIM_TITLE_CHARS
								? `${m.title.slice(0, CLAIM_TITLE_CHARS)}...`
								: m.title,
						currentVersion: m.currentVersion,
						openPins: open.get(`${m.id}:${m.currentVersion}`) ?? 0,
						htmlLength: read.get(m.id)?.htmlLength ?? null,
						readChars: read.get(m.id)?.readChars ?? 0,
						readComplete: read.get(m.id)?.readComplete ?? false,
						untrusted: true as const
					})),
					...(visible.length > shown.length ? { moreMockups: visible.length - shown.length } : {}),
					mockupRule: MOCKUP_RULE,
					...(notice ? { mockupNotice: notice } : {})
				};
			})
		);
	} catch (e) {
		// A caller who may not see the plan or its project has no mockups to be told about
		if (e instanceof OpError && (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND')) return {};
		// Anything else is a real fault: say so in the reply and in the log, and let the claim stand
		console.error('claimMockups failed', e instanceof Error ? e.message : 'unknown error');
		return { mockupsUnavailable: true };
	}
}

/** Copies an earlier version on top as the newest one. The old file stays, and the copy owns its own bytes. */
export async function restoreMockupVersion(ctx: Ctx, id: string, number: number) {
	const store = storage(ctx);
	const written: string[] = [];
	return withFileCleanup(store, written, () =>
		run(ctx, (tx) =>
			idempotent(ctx, tx, async () => {
				const { m } = await loadMockup(tx, ctx, id, { lock: true });
				await requireCap(tx, ctx, 'write', m.projectId);
				await rateLimit(tx, ctx, 'write');
				const [src] = await tx
					.select()
					.from(mockupVersion)
					.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, number)));
				if (!src) throw new OpError('NOT_FOUND', `This mockup has no version ${number}.`);
				const bytes = await store.get(src.storageKey);
				if (!bytes) throw new OpError('NOT_FOUND', 'The stored file of that version is missing.');
				const shot = src.screenshotKey ? await store.get(src.screenshotKey) : null;
				const [{ n }] = await tx
					.select({ n: sql<number>`coalesce(max(${mockupVersion.number}), 0)` })
					.from(mockupVersion)
					.where(eq(mockupVersion.mockupId, m.id));
				const next = n + 1;
				const key = mockupKey(ctx.orgId, m.projectId, 'html');
				written.push(key);
				await store.put(key, bytes, 'text/html');
				let shotKey: string | null = null;
				if (shot) {
					shotKey = mockupKey(ctx.orgId, m.projectId, 'png');
					written.push(shotKey);
					await store.put(shotKey, shot, 'image/png');
				}
				const [row] = await tx
					.insert(mockupVersion)
					.values({
						orgId: ctx.orgId,
						projectId: m.projectId,
						mockupId: m.id,
						number: next,
						storageKey: key,
						size: bytes.byteLength,
						checksum: sha256(bytes),
						keepNotes: src.keepNotes,
						freeNotes: src.freeNotes,
						screenshotKey: shotKey,
						restoredFrom: src.number,
						createdBy: ctx.actor.userId
					})
					.returning();
				const [updated] = await tx
					.update(mockup)
					.set({ currentVersion: next, updatedAt: sql`now()`, version: sql`${mockup.version} + 1` })
					.where(eq(mockup.id, m.id))
					.returning();
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: m.projectId,
					itemId: m.itemId,
					...actorFields(ctx),
					verb: 'mockup.restore',
					targetType: 'mockup',
					targetId: m.id,
					after: { restoredFrom: src.number, version: next } as never,
					undoable: false
				});
				return { mockup: publicMockup(updated), version: publicVersion(row) };
			})
		)
	);
}

/**
 * Links a mockup to a plan, or unlinks it (item null). Linking makes the mockup take the plan's visibility, and a private plan
 * turns the public link off. Unlinking keeps the visibility it has, so a mockup made private by its plan never becomes visible
 * to the whole project just because it was moved.
 */
/**
 * An agent may not unlink, move or trash the mockup of a plan it is building while that mockup is unread
 * (AFB-20261111-0017): it would be the way past the step gate. A person is never refused, and neither is an agent on a
 * plan that is not in progress or once the mockup is read to the end. Ids and counts only reach the message.
 */
async function refuseAgentEscape(tx: Tx, ctx: Ctx, m: MockupRow, plan: ItemRow | null) {
	if (ctx.actor.kind !== 'agent' || !plan) return;
	// A plan that was only written is free: planning moves mockups around. Once a step was ever marked or the status ever
	// changed, the refusal holds whatever the steps and the status are set to afterwards, so reopening steps or a status
	// round trip (also through REMOVED or COMPLETED) is no way round (AFB-20261111-0046)
	if (!(await planWorked(tx, plan.id))) return;
	const state = (await readStateOf(tx, [m])).get(m.id);
	if (!state || state.readComplete) return;
	throw new OpError(
		'MOCKUP_UNREAD',
		`${unreadLine([state])} A mockup that is not read to the end cannot be unlinked, moved or put in the trash by an agent while its plan is being built. Read it, or leave this change to the person.`,
		{ mockups: [{ id: m.id, version: m.currentVersion }] }
	);
}

export async function linkMockup(ctx: Ctx, id: string, itemRef: string | null) {
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			// The plan row is locked first, the order updateItem and publish use, so a plan going private at the same moment
			// either finishes before the copy below or syncs this mockup after it
			const plan = itemRef ? await findItem(tx, ctx, itemRef, { lock: true }) : null;
			const { m, plan: held } = await loadMockup(tx, ctx, id, { lock: true });
			await requireCap(tx, ctx, 'write', m.projectId);
			await rateLimit(tx, ctx, 'write');
			// Taking the mockup off its plan is the way past the step gate, so an agent may not do it while it is unread
			if (plan?.id !== held?.id) await refuseAgentEscape(tx, ctx, m, held);
			if (plan && plan.projectId !== m.projectId)
				throw new OpError('INVALID', 'A mockup can only be linked to a plan of its own project.');
			const visibility = plan ? plan.visibility : m.visibility;
			const linkOff = visibility === 'private';
			const [updated] = await tx
				.update(mockup)
				.set({
					itemId: plan?.id ?? null,
					visibility,
					...(linkOff ? { publicEnabled: false, publicTokenHash: null } : {}),
					updatedAt: sql`now()`,
					version: sql`${mockup.version} + 1`
				})
				.where(eq(mockup.id, m.id))
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: plan?.id ?? m.itemId,
				...actorFields(ctx),
				verb: 'mockup.link',
				targetType: 'mockup',
				targetId: m.id,
				before: { itemId: m.itemId } as never,
				after: { itemId: plan?.id ?? null } as never,
				undoable: false
			});
			return { mockup: publicMockup(updated) };
		})
	);
}

/** Moves a mockup to the trash. Its public link is switched off for good: bringing it back never turns the link on again. */
export async function trashMockup(ctx: Ctx, id: string) {
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const { m, plan: held } = await loadMockup(tx, ctx, id, { lock: true });
			await requireCap(tx, ctx, 'delete', m.projectId);
			await rateLimit(tx, ctx, 'write');
			await refuseAgentEscape(tx, ctx, m, held);
			await tx
				.update(mockup)
				.set({
					trashedAt: sql`now()`,
					publicEnabled: false,
					publicTokenHash: null,
					updatedAt: sql`now()`,
					version: sql`${mockup.version} + 1`
				})
				.where(eq(mockup.id, m.id));
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: m.itemId,
				...actorFields(ctx),
				verb: 'mockup.delete',
				targetType: 'mockup',
				targetId: m.id,
				before: { title: m.title } as never,
				undoable: false
			});
			return { id: m.id, trashed: true as const };
		})
	);
}

export async function restoreMockupFromTrash(ctx: Ctx, id: string) {
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const { m } = await loadMockup(tx, ctx, id, { lock: true, trashed: true });
			await requireCap(tx, ctx, 'delete', m.projectId);
			await rateLimit(tx, ctx, 'write');
			await tx
				.update(mockup)
				.set({ trashedAt: null, updatedAt: sql`now()`, version: sql`${mockup.version} + 1` })
				.where(eq(mockup.id, m.id));
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: m.itemId,
				...actorFields(ctx),
				verb: 'mockup.restore-trash',
				targetType: 'mockup',
				targetId: m.id,
				after: { title: m.title } as never,
				undoable: false
			});
			return { id: m.id, restored: true as const };
		})
	);
}

/**
 * Switches the public link on or off. Switching on makes a new random address every time, and the old one stops at once.
 * The address is returned only here: the database keeps a hash. Admins and owners only.
 */
export async function setMockupPublicLink(ctx: Ctx, id: string, on: boolean) {
	return run(ctx, (tx) => {
		// Switching on is never stored for replay: the idempotency log would keep the clear address in the database. A retry of
		// a lost answer simply makes another new address, which is what switching on means anyway.
		const once = <T>(work: () => Promise<T>) => (on ? work() : idempotent(ctx, tx, work));
		return once(async () => {
			const { m, plan } = await loadMockup(tx, ctx, id, { lock: true });
			await requireCap(tx, ctx, 'manage', m.projectId);
			await rateLimit(tx, ctx, 'write');
			if (on && (m.visibility === 'private' || plan?.visibility === 'private' || plan?.deletedAt))
				throw new OpError(
					'CONFLICT',
					'This mockup belongs to a private plan, so it cannot have a public link.'
				);
			const token = on ? randomBytes(24).toString('base64url') : null;
			const [updated] = await tx
				.update(mockup)
				.set({
					publicEnabled: on,
					publicTokenHash: token ? hashToken(token) : null,
					updatedAt: sql`now()`,
					version: sql`${mockup.version} + 1`
				})
				.where(eq(mockup.id, m.id))
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: m.itemId,
				...actorFields(ctx),
				verb: on ? 'mockup.public-on' : 'mockup.public-off',
				targetType: 'mockup',
				targetId: m.id,
				undoable: false
			});
			return {
				mockup: publicMockup(updated),
				// The only time the address exists in clear text
				token,
				url: token && ctx.services?.baseUrl ? `${ctx.services.baseUrl}/m/${token}` : null
			};
		});
	});
}

/**
 * What the page needs to fetch one stored file of a mockup: the checked grant the page route signs into a 5 minute link.
 * The check is the caller's live read access (the 300 second window after a privacy change is accepted for members).
 */
export async function mockupFileGrant(
	ctx: Ctx,
	id: string,
	options: { version?: number; screenshot?: boolean } = {}
) {
	return run(ctx, async (tx) => {
		const { m } = await loadMockup(tx, ctx, id);
		const n = options.version ?? m.currentVersion;
		const [v] = await tx
			.select()
			.from(mockupVersion)
			.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, n)));
		if (!v) throw new OpError('NOT_FOUND', `This mockup has no version ${n}.`);
		if (options.screenshot && !v.screenshotKey)
			throw new OpError('NOT_FOUND', 'This version has no screenshot.');
		return {
			orgId: ctx.orgId,
			projectId: m.projectId,
			mockupId: m.id,
			version: v.number,
			kind: options.screenshot ? ('shot' as const) : ('html' as const)
		};
	});
}

export { syncMockupsOfItem };

/** Changes the build notes of one version. The stored file never changes, only what its notes say. */
export async function setVersionNotes(
	ctx: Ctx,
	id: string,
	number: number,
	notes: { keepNotes?: string; freeNotes?: string }
) {
	const parsed = z
		.object({
			keepNotes: z.string().max(20_000).optional(),
			freeNotes: z.string().max(20_000).optional()
		})
		.parse(notes);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const { m } = await loadMockup(tx, ctx, id, { lock: true });
			await requireCap(tx, ctx, 'write', m.projectId);
			await rateLimit(tx, ctx, 'write');
			const [row] = await tx
				.update(mockupVersion)
				.set({
					...(parsed.keepNotes !== undefined ? { keepNotes: parsed.keepNotes } : {}),
					...(parsed.freeNotes !== undefined ? { freeNotes: parsed.freeNotes } : {})
				})
				.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, number)))
				.returning();
			if (!row) throw new OpError('NOT_FOUND', `This mockup has no version ${number}.`);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: m.projectId,
				itemId: m.itemId,
				...actorFields(ctx),
				verb: 'mockup.notes',
				targetType: 'mockup',
				targetId: m.id,
				after: { version: number } as never,
				undoable: false
			});
			return { version: publicVersion(row) };
		})
	);
}

/** Sets the screenshot of one version. The old screenshot file, if any, is removed after the row points at the new one. */
export async function setVersionScreenshot(
	ctx: Ctx,
	id: string,
	number: number,
	bytes: Uint8Array
) {
	if (bytes.byteLength === 0) throw new OpError('INVALID', 'The screenshot is empty.');
	checkScreenshot(bytes);
	const store = storage(ctx);
	const written: string[] = [];
	const out = await withFileCleanup(store, written, () =>
		run(ctx, (tx) =>
			idempotent(ctx, tx, async () => {
				const { m } = await loadMockup(tx, ctx, id, { lock: true });
				await requireCap(tx, ctx, 'write', m.projectId);
				await rateLimit(tx, ctx, 'write');
				const [v] = await tx
					.select()
					.from(mockupVersion)
					.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, number)));
				if (!v) throw new OpError('NOT_FOUND', `This mockup has no version ${number}.`);
				const key = mockupKey(ctx.orgId, m.projectId, 'png');
				written.push(key);
				await store.put(key, bytes, 'image/png');
				await tx
					.update(mockupVersion)
					.set({ screenshotKey: key })
					.where(eq(mockupVersion.id, v.id));
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: m.projectId,
					itemId: m.itemId,
					...actorFields(ctx),
					verb: 'mockup.screenshot',
					targetType: 'mockup',
					targetId: m.id,
					after: { version: number } as never,
					undoable: false
				});
				return { version: number, replaced: v.screenshotKey };
			})
		)
	);
	if (out.replaced) await store.delete(out.replaced).catch(() => undefined);
	return { version: out.version, hasScreenshot: true as const };
}
