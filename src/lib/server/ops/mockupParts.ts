// MOCKUPS MADE OF PARTS: A BUNDLE IS COMPOSED INTO THE PAGE, THE PARTS ARE KEPT, AND THE PROJECT SHELL IS SAVED ONCE (AFB-20261114-0409, PHASE D)
// A bundle is a skeleton (or the project shell) plus parts: screens, sheets, styles, motion, behaviour, fixtures and a contract. The
// server composes the one page that is stored and served as always, and keeps each part as a file of its own, so a pull returns the
// same parts and a new version can be read part by part. A single HTML file stays a valid mockup.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { appendEvent } from '../db/events';
import { MOCKUP_PART_KINDS, mockupPart, mockupVersion } from '../db/schema';
import { composeMockup, PART_KEY, SLOTS, type ComposePart } from '../mockups/compose';
import { parseContract } from '../mockups/contract';
import { seedInventory } from '../mockups/inventory';
import { mockupKey } from '../mockups/keys';
import { rangeChars, segmentMockupHtml } from '../mockups/segments';
import { OpError, idempotent, rateLimit, requireCap, run } from './context';
import { actorFields } from './items';
import {
	MAX_MOCKUP_BYTES,
	loadMockup,
	loadMockupPage,
	publishMockup,
	readMockupSegments,
	publishInput,
	withFileCleanup
} from './mockups';
import { findItem, findProject } from './resolve';

// -- CONSTANTS -- //

/** Shells kept per project: the newest few, so a bad one can be put back by saving the older text again. */
const KEEP_SHELLS = 3;
const BUNDLE_KINDS = MOCKUP_PART_KINDS.filter((k) => k !== 'shell');

export const bundleInput = publishInput.extend({
	parts: z
		.array(
			z.object({
				kind: z.enum(BUNDLE_KINDS as [string, ...string[]]),
				key: z.string().regex(PART_KEY, 'a part key is letters, digits, dashes and underscores'),
				content: z.string().min(1)
			})
		)
		.min(1)
		.max(300)
});
export type BundleInput = z.input<typeof bundleInput>;

export const shellInput = z.object({ project: z.string().min(1) });

// -- FUNCTIONS -- //

const sha256 = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const textOf = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

function storage(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/** The skeleton text a project's mockups share, newest first, or null when none was saved. */
async function loadShell(ctx: Ctx, projectId: string): Promise<string | null> {
	const store = storage(ctx);
	const row = await run(ctx, async (tx) => {
		const [r] = await tx
			.select({ key: mockupPart.storageKey })
			.from(mockupPart)
			.where(
				and(
					eq(mockupPart.projectId, projectId),
					eq(mockupPart.kind, 'shell'),
					isNull(mockupPart.mockupId)
				)
			)
			.orderBy(desc(mockupPart.createdAt))
			.limit(1);
		return r ?? null;
	});
	return row ? textOf(await store.get(row.key)) : null;
}

/** Composes the parts into a page and publishes it as a version, keeping the parts. */
export async function publishMockupBundle(ctx: Ctx, raw: BundleInput, screenshot?: Uint8Array) {
	const input = bundleInput.parse(raw);
	const seen = new Set<string>();
	let total = 0;
	for (const p of input.parts) {
		const id = `${p.kind}:${p.key}`;
		if (seen.has(id)) throw new OpError('INVALID', `The part ${id} is listed twice.`);
		seen.add(id);
		total += p.content.length;
	}
	if (input.parts.filter((p) => p.kind === 'skeleton').length > 1)
		throw new OpError('INVALID', 'A bundle has one skeleton at most.');
	if (total > MAX_MOCKUP_BYTES)
		throw new OpError('INVALID', 'The parts together are larger than 50 MB.');
	if (!input.mockup && !input.item && !input.project)
		throw new OpError('INVALID', 'Name the plan (item) or the project the mockup belongs to.');
	// The project is needed to find the shell, so it is worked out first and only read
	const projectId = await run(ctx, async (tx) => {
		const id = input.mockup
			? (await loadMockup(tx, ctx, input.mockup)).m.projectId
			: input.item
				? (await findItem(tx, ctx, input.item)).projectId
				: (await findProject(tx, ctx, input.project!)).id;
		await requireCap(tx, ctx, 'write', id);
		return id;
	});
	const given = input.parts.find((p) => p.kind === 'skeleton');
	const skeleton = given?.content ?? (await loadShell(ctx, projectId));
	if (!skeleton)
		throw new OpError(
			'INVALID',
			'The bundle has no skeleton and the project has no saved shell. Send a skeleton part, or save the shell first.'
		);
	let composed: { html: string; slots: string[] };
	try {
		composed = composeMockup(skeleton, input.parts as ComposePart[]);
	} catch (e) {
		throw new OpError('INVALID', e instanceof Error ? e.message : 'The parts could not be joined.');
	}
	// The shell in force is kept with the version as its skeleton, so the version can be built again whatever the shell becomes
	const parts = given
		? input.parts
		: [{ kind: 'skeleton', key: 'shell', content: skeleton }, ...input.parts];
	const result = await publishMockup(
		ctx,
		{
			project: input.project,
			item: input.item,
			mockup: input.mockup,
			another: input.another,
			title: input.title,
			keepNotes: input.keepNotes,
			freeNotes: input.freeNotes
		},
		new TextEncoder().encode(composed.html),
		screenshot,
		{ parts }
	);
	return {
		...result,
		composed: { chars: composed.html.length, slots: composed.slots, parts: parts.length }
	};
}

/**
 * The version whose parts a version shows: itself, or the one it was restored from, and so on up the chain (a restore of a restore).
 * The walk stops at the first version that has parts, or at one that was not restored.
 */
async function partsOwner(tx: Tx, mockupId: string, number: number): Promise<number> {
	let n = number;
	for (let hops = 0; hops < 50; hops++) {
		const [has] = await tx
			.select({ id: mockupPart.id })
			.from(mockupPart)
			.where(and(eq(mockupPart.mockupId, mockupId), eq(mockupPart.versionNumber, n)))
			.limit(1);
		if (has) return n;
		const [v] = await tx
			.select({ restoredFrom: mockupVersion.restoredFrom })
			.from(mockupVersion)
			.where(and(eq(mockupVersion.mockupId, mockupId), eq(mockupVersion.number, n)));
		if (!v?.restoredFrom) return number;
		n = v.restoredFrom;
	}
	return number;
}

/** The parts of one version, in the order they were pushed. A restored version lists the parts of the one it was copied from. */
export async function listMockupParts(ctx: Ctx, id: string, options: { version?: number } = {}) {
	return run(ctx, async (tx) => {
		const { m } = await loadMockup(tx, ctx, id);
		const n = options.version ?? m.currentVersion;
		const [v] = await tx
			.select({ number: mockupVersion.number, restoredFrom: mockupVersion.restoredFrom })
			.from(mockupVersion)
			.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, n)));
		if (!v) throw new OpError('NOT_FOUND', `This mockup has no version ${n}.`);
		const from = await partsOwner(tx, m.id, v.number);
		const rows = await tx
			.select({
				kind: mockupPart.kind,
				key: mockupPart.key,
				size: mockupPart.size,
				checksum: mockupPart.checksum
			})
			.from(mockupPart)
			.where(and(eq(mockupPart.mockupId, m.id), eq(mockupPart.versionNumber, from)))
			.orderBy(asc(mockupPart.position));
		return { version: n, partsOf: from, bundle: rows.length > 0, parts: rows };
	});
}

/** The text of one part of a version, marked untrusted, cut by character offsets like the page itself. */
export async function readMockupPart(
	ctx: Ctx,
	id: string,
	options: { version?: number; kind: string; key: string; offset?: number; limit?: number }
) {
	const store = storage(ctx);
	const found = await run(ctx, async (tx) => {
		const { m } = await loadMockup(tx, ctx, id);
		const n = options.version ?? m.currentVersion;
		const [v] = await tx
			.select({ number: mockupVersion.number, restoredFrom: mockupVersion.restoredFrom })
			.from(mockupVersion)
			.where(and(eq(mockupVersion.mockupId, m.id), eq(mockupVersion.number, n)));
		if (!v) throw new OpError('NOT_FOUND', `This mockup has no version ${n}.`);
		const [row] = await tx
			.select({ storageKey: mockupPart.storageKey })
			.from(mockupPart)
			.where(
				and(
					eq(mockupPart.mockupId, m.id),
					eq(mockupPart.versionNumber, await partsOwner(tx, m.id, v.number)),
					eq(mockupPart.kind, options.kind),
					eq(mockupPart.key, options.key)
				)
			);
		if (!row)
			throw new OpError('NOT_FOUND', `This version has no ${options.kind} part "${options.key}".`);
		return { n, key: row.storageKey };
	});
	const text = textOf(await store.get(found.key));
	if (text === null) throw new OpError('NOT_FOUND', 'The stored file of this part is missing.');
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.min(200_000, Math.max(1, options.limit ?? 200_000));
	return {
		untrusted: true as const,
		version: found.n,
		kind: options.kind,
		key: options.key,
		length: text.length,
		offset,
		content: text.slice(offset, offset + limit),
		more: offset + limit < text.length
	};
}

/**
 * The seeded Mockup inventory of some screens or sheets of a version, ready to paste into the design brief and mark built, free or
 * differs. It lists what the source says; reading the source is still the agent's job (the read gate is unchanged).
 */
export async function getMockupInventory(
	ctx: Ctx,
	id: string,
	options: { version?: number; scopes: string[] }
) {
	if (!options.scopes.length)
		throw new OpError(
			'INVALID',
			'Name the screens or sheets (scopes), for example ["today", "surface:lab"].'
		);
	const page = await loadMockupPage(ctx, id, { version: options.version });
	const cut = segmentMockupHtml(page.text);
	const inv = seedInventory(page.text, cut.segments, options.scopes);
	if (inv.unknown.length)
		throw new OpError(
			'NOT_FOUND',
			`This version has no part ${inv.unknown.join(', ')}. The screens and sheets are: ${cut.segments
				.filter((s) => s.kind === 'screen' || s.kind === 'surface')
				.map((s) => s.key)
				.join(', ')}.`
		);
	const header = `## Mockup inventory (seeded from ${inv.scopes.join(', ')} of ${id} v${page.version}; mark each line built, free or differs at the end of the phase)`;
	const limit = inv.truncated
		? [
				'- [ ] (a list stopped at its limit: ask for fewer screens or sheets at a time, and read the source for the rest)'
			]
		: [];
	return {
		version: page.version,
		scopes: inv.scopes,
		counts: inv.counts,
		truncated: inv.truncated,
		markdown: [header, ...inv.lines, ...limit].join('\n')
	};
}

/** What a version costs to read: its parts, the authored characters and the machine output that needs no reading. Used by the viewer. */
export async function getMockupSource(ctx: Ctx, id: string, options: { version?: number } = {}) {
	const cut = await readMockupSegments(ctx, id, options);
	const excludedChars = rangeChars(cut.excluded);
	const authoredChars = Math.max(0, cut.length - excludedChars);
	const listed = await listMockupParts(ctx, id, { version: cut.version });
	return {
		version: cut.version,
		totalChars: cut.length,
		authoredChars,
		excludedChars,
		estimatedTokens: Math.round(authoredChars / 4),
		readCalls: Math.ceil(authoredChars / 12_000),
		bundle: listed.bundle,
		parts: cut.segments.map((s) => ({
			key: s.key,
			kind: s.kind,
			chars: s.end - s.start,
			excludedChars: rangeChars(
				cut.excluded
					.map(([a, b]) => [Math.max(a, s.start), Math.min(b, s.end)] as [number, number])
					.filter(([a, b]) => b > a)
			)
		}))
	};
}

/** The contract of a version, or null when it has none. */
export async function getMockupContract(ctx: Ctx, id: string, options: { version?: number } = {}) {
	const listed = await listMockupParts(ctx, id, options);
	if (!listed.parts.some((p) => p.kind === 'contract')) return null;
	const key = listed.parts.find((p) => p.kind === 'contract')!.key;
	const part = await readMockupPart(ctx, id, { version: listed.version, kind: 'contract', key });
	return { version: listed.version, contract: parseContract(part.content) };
}

/** Saves the project shell: the app's root layout with the slots a bundle fills. Admins and writers save; everyone who sees the project reads. */
export async function setProjectShell(
	ctx: Ctx,
	raw: z.input<typeof shellInput>,
	bytes: Uint8Array
) {
	const input = shellInput.parse(raw);
	if (!bytes?.byteLength) throw new OpError('INVALID', 'No shell was sent.');
	if (bytes.byteLength > MAX_MOCKUP_BYTES)
		throw new OpError('INVALID', 'The shell is larger than 50 MB.');
	const text = new TextDecoder().decode(bytes);
	if (!text.includes(SLOTS.screens))
		throw new OpError(
			'INVALID',
			`The shell needs ${SLOTS.screens} where the screens go. The other slots are optional: ${Object.values(
				SLOTS
			)
				.filter((s) => s !== SLOTS.screens)
				.join(', ')}.`
		);
	const store = storage(ctx);
	const written: string[] = [];
	const pruned: string[] = [];
	const out = await withFileCleanup(store, written, () =>
		run(ctx, (tx) =>
			idempotent(ctx, tx, async () => {
				const proj = await findProject(tx, ctx, input.project);
				await requireCap(tx, ctx, 'write', proj.id);
				await rateLimit(tx, ctx, 'write');
				const key = mockupKey(ctx.orgId, proj.id, 'asset', 'txt');
				written.push(key);
				await store.put(key, bytes, 'text/plain');
				await tx.insert(mockupPart).values({
					orgId: ctx.orgId,
					projectId: proj.id,
					mockupId: null,
					versionNumber: null,
					kind: 'shell',
					key: 'shell',
					position: 0,
					storageKey: key,
					size: bytes.byteLength,
					checksum: sha256(bytes),
					createdBy: ctx.actor.userId
				});
				const all = await tx
					.select({ id: mockupPart.id, key: mockupPart.storageKey })
					.from(mockupPart)
					.where(
						and(
							eq(mockupPart.projectId, proj.id),
							eq(mockupPart.kind, 'shell'),
							isNull(mockupPart.mockupId)
						)
					)
					.orderBy(desc(mockupPart.createdAt));
				for (const old of all.slice(KEEP_SHELLS)) {
					await tx.delete(mockupPart).where(eq(mockupPart.id, old.id));
					pruned.push(old.key);
				}
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: proj.id,
					itemId: null,
					...actorFields(ctx),
					verb: 'mockup.shell',
					targetType: 'mockup_shell',
					targetId: proj.id,
					after: { size: bytes.byteLength } as never,
					undoable: false
				});
				return { size: bytes.byteLength, kept: Math.min(all.length, KEEP_SHELLS) };
			})
		)
	);
	await Promise.all(pruned.map((k) => store.delete(k).catch(() => undefined)));
	return out;
}

/** The newest project shell as text marked untrusted, or null when none was saved. */
export async function readProjectShell(ctx: Ctx, projectKey: string) {
	const projectId = await run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'read', proj.id);
		return proj.id;
	});
	const text = await loadShell(ctx, projectId);
	if (text === null) return null;
	return {
		untrusted: true as const,
		length: text.length,
		slots: Object.values(SLOTS).filter((s) => text.includes(s)),
		shell: text
	};
}
