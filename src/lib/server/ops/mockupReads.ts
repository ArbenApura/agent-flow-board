// WHAT WAS READ OF A PLAN'S MOCKUP (AFB-20261110-2331): THE READ RECORD AND THE STATE A CLAIM, A LIST AND THE STEP GATE READ
// A build must read the whole HTML of its plan's mockup. The server writes down which parts each session was served, so a
// claim, the audit and the step gate can tell "read to the end" from "the notes were enough". Only ids, versions and counts
// ever leave this file: no mockup text is put in a notice or an error.

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
// -- MODULES -- //
import { event, mockup, mockupRead, mockupVersion, session } from '../db/schema';
import { OpError, requireCap, run } from './context';
import { canSeeMockup, loadMockup } from './mockups';
import { findItem } from './resolve';

// -- TYPES -- //

export type ReadRange = [number, number];

/** How much of one mockup's current version has been read, by anyone in the project. */
export type MockupReadState = {
	id: string;
	currentVersion: number;
	/** The stored size of the version in bytes. Known before anyone reads it. */
	sizeBytes: number;
	/** The length of the HTML in characters, known once a part was read. */
	htmlLength: number | null;
	readChars: number;
	readComplete: boolean;
};

// -- FUNCTIONS -- //

/** Adds one [start, end) part to a sorted list of parts that never overlap or touch. Pure. */
export function mergeRange(ranges: ReadRange[], start: number, end: number): ReadRange[] {
	if (end <= start) return ranges.map(([a, b]) => [a, b] as ReadRange);
	const all = [...ranges.map(([a, b]) => [a, b] as ReadRange), [start, end] as ReadRange].sort(
		(x, y) => x[0] - y[0]
	);
	const out: ReadRange[] = [];
	for (const [a, b] of all) {
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** The parts of several records as one list. Pure. */
export function unionRanges(lists: ReadRange[][]): ReadRange[] {
	return lists.flat().reduce<ReadRange[]>((acc, [a, b]) => mergeRange(acc, a, b), []);
}

export const coveredChars = (ranges: ReadRange[]) => ranges.reduce((n, [a, b]) => n + (b - a), 0);

/** True when the parts cover the whole HTML. An empty page has nothing to read. */
export const coversAll = (ranges: ReadRange[], length: number) =>
	length <= 0 || (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= length);

/**
 * Writes down that this session was served one part of a mockup version. It needs only the right to read the mockup: the row
 * is a fact about the session, not a change to the plan. It runs in a savepoint and never throws, so a problem with the
 * record can never fail the read it belongs to. A call with no session is not recorded.
 */
export async function recordMockupRead(
	ctx: Ctx,
	input: {
		mockup: string;
		version: number;
		offset: number;
		served: number;
		length: number;
		/** A session id the caller sent by hand (the API). It is checked here; an MCP call's own session is already checked. */
		sessionId?: string;
	}
): Promise<{
	recorded: boolean;
	readChars: number;
	unreadChars: number;
	/** Why nothing was recorded: no known session, or a fault on the server. */
	reason?: 'no-session' | 'error';
}> {
	const sessionId = input.sessionId ?? ctx.actor.sessionId;
	const none = {
		recorded: false,
		readChars: 0,
		unreadChars: Math.max(0, input.length),
		reason: 'no-session' as const
	};
	if (!sessionId) return none;
	const length = Math.max(0, input.length);
	const start = Math.min(Math.max(0, input.offset), length);
	const end = Math.min(start + Math.max(0, input.served), length);
	try {
		return await run(ctx, (outer) =>
			outer.transaction(async (sp) => {
				const tx = sp as unknown as Tx;
				// The mockup row is locked for this short write, so two sessions finishing the page at the same moment are
				// counted one after the other and the second one sees the first one's parts
				const { m } = await loadMockup(tx, ctx, input.mockup, { lock: true });
				await requireCap(tx, ctx, 'read', m.projectId);
				if (input.sessionId) {
					// Only this person's own session of this organisation may be named
					const [own] = await tx
						.select({ id: session.id })
						.from(session)
						.where(
							and(
								eq(session.id, input.sessionId),
								eq(session.orgId, ctx.orgId),
								eq(session.userId, ctx.actor.userId)
							)
						);
					if (!own) return none;
				}
				const key = and(
					eq(mockupRead.sessionId, sessionId),
					eq(mockupRead.mockupId, m.id),
					eq(mockupRead.versionNumber, input.version)
				);
				await tx
					.insert(mockupRead)
					.values({
						orgId: ctx.orgId,
						projectId: m.projectId,
						sessionId,
						mockupId: m.id,
						versionNumber: input.version,
						htmlLength: length
					})
					.onConflictDoNothing();
				// The row is locked while its parts are merged, so two parts read at the same time both count
				const [row] = await tx.select().from(mockupRead).where(key).for('update');
				if (!row) return none;
				// A length that changed means another file: start again from this part
				const before = row.htmlLength === length ? ((row.ranges ?? []) as ReadRange[]) : [];
				const ranges = mergeRange(before, start, end);
				// The page counts as read when the parts of every session together cover it, so one row says so for the plan
				// (the board badge reads completed_at)
				const others = await tx
					.select({ ranges: mockupRead.ranges, htmlLength: mockupRead.htmlLength })
					.from(mockupRead)
					.where(
						and(
							eq(mockupRead.mockupId, m.id),
							eq(mockupRead.versionNumber, input.version),
							ne(mockupRead.id, row.id)
						)
					);
				const complete = coversAll(
					unionRanges([
						ranges,
						...others
							.filter((o) => o.htmlLength === length)
							.map((o) => (o.ranges ?? []) as ReadRange[])
					]),
					length
				);
				await tx
					.update(mockupRead)
					.set({
						ranges,
						htmlLength: length,
						completedAt: complete ? (row.completedAt ?? sql`now()`) : null,
						updatedAt: sql`now()`
					})
					.where(eq(mockupRead.id, row.id));
				const readChars = coveredChars(ranges);
				return { recorded: true, readChars, unreadChars: Math.max(0, length - readChars) };
			})
		);
	} catch (e) {
		// The name of the error only: its message can repeat what the caller sent
		console.error('recordMockupRead failed', e instanceof Error ? e.name : 'unknown error');
		return { ...none, reason: 'error' as const };
	}
}

/** The read state of a list of mockups, counted by mockup and version over every session of the project. */
export async function readStateOf(
	tx: Tx,
	rows: Pick<typeof mockup.$inferSelect, 'id' | 'currentVersion'>[]
): Promise<Map<string, MockupReadState>> {
	const out = new Map<string, MockupReadState>();
	if (!rows.length) return out;
	const ids = rows.map((m) => m.id);
	const [versions, reads] = await Promise.all([
		tx
			.select({
				mockupId: mockupVersion.mockupId,
				number: mockupVersion.number,
				size: mockupVersion.size
			})
			.from(mockupVersion)
			.where(inArray(mockupVersion.mockupId, ids)),
		tx.select().from(mockupRead).where(inArray(mockupRead.mockupId, ids))
	]);
	for (const m of rows) {
		const size = versions.find((v) => v.mockupId === m.id && v.number === m.currentVersion)?.size;
		const mine = reads.filter((r) => r.mockupId === m.id && r.versionNumber === m.currentVersion);
		// Records made against another length belong to a file that is gone, so only the newest length counts
		const length = mine.length
			? mine.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b)).htmlLength
			: null;
		const ranges = unionRanges(
			mine.filter((r) => r.htmlLength === length).map((r) => (r.ranges ?? []) as ReadRange[])
		);
		const readChars = coveredChars(ranges);
		out.set(m.id, {
			id: m.id,
			currentVersion: m.currentVersion,
			sizeBytes: size ?? 0,
			htmlLength: length,
			readChars,
			// An empty page has nothing to read; otherwise the parts must cover the whole length a read reported
			readComplete: size === 0 || (length !== null && coversAll(ranges, length))
		});
	}
	return out;
}

/**
 * The read state of a plan's mockups: every mockup of the plan that is not in the trash and that the caller may see. This is
 * the set the step gate looks at, so a mockup the caller cannot open can never hold them.
 */
export async function mockupReadState(ctx: Ctx, itemRef: string): Promise<MockupReadState[]> {
	return run(ctx, async (tx) => {
		const plan = await findItem(tx, ctx, itemRef);
		await requireCap(tx, ctx, 'read', plan.projectId);
		return gatedState(tx, ctx, plan);
	});
}

/** The same, for a plan row already loaded inside a transaction. */
export async function gatedState(
	tx: Tx,
	ctx: Ctx,
	plan: { id: string; createdBy: string | null }
): Promise<MockupReadState[]> {
	const rows = await tx
		.select()
		.from(mockup)
		.where(and(eq(mockup.itemId, plan.id), eq(mockup.orgId, ctx.orgId), isNull(mockup.trashedAt)));
	const visible = rows.filter((m) => canSeeMockup(m, ctx.actor.userId, plan));
	const state = await readStateOf(tx, visible);
	return visible.map((m) => state.get(m.id)!);
}

/**
 * The mockups that hold an agent's last step of a phase: the unread ones, without any whose stored file is missing (nobody can
 * read those, so they never hold a step) and without all of them when this server has no file storage.
 */
export async function unreadForGate(
	tx: Tx,
	ctx: Ctx,
	plan: { id: string; createdBy: string | null }
): Promise<{ unread: MockupReadState[]; missing: string[] }> {
	const unread = (await gatedState(tx, ctx, plan)).filter((s) => !s.readComplete);
	if (!unread.length) return { unread, missing: [] };
	// No file storage on this server is a fault to fix, never a way past the gate: reading the mockup says so loudly
	const store = ctx.services?.storage;
	if (!store) return { unread, missing: [] };
	const missing: string[] = [];
	for (const s of unread) {
		// Only a mockup nobody has opened can have a missing file: a part that was served proves the file is there
		if (s.htmlLength !== null) continue;
		const [v] = await tx
			.select({ key: mockupVersion.storageKey })
			.from(mockupVersion)
			.where(and(eq(mockupVersion.mockupId, s.id), eq(mockupVersion.number, s.currentVersion)));
		// Only a definite "no such file" exempts. A storage error is thrown, so a passing fault never opens the gate
		if (!v || (await store.get(v.key)) === null) missing.push(s.id);
	}
	if (missing.length)
		console.error(
			'mockup gate: the stored file is missing, so the mockup is exempt',
			missing.join(', ')
		);
	return { unread: unread.filter((s) => !missing.includes(s.id)), missing };
}

/**
 * True once a plan was worked on: a step was ever marked, or its status was ever changed. It is read from the history, never
 * from the steps or the status as they stand, so reopening every step or moving the status back and forth changes nothing
 * (AFB-20261111-0046). A plan that was only written is free: planning moves steps and mockups around.
 */
export async function planWorked(tx: Tx, planId: string): Promise<boolean> {
	const [n] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(event)
		.where(and(eq(event.itemId, planId), inArray(event.verb, ['step.update', 'item.status'])));
	return n.n > 0;
}

/** One plain line about the unread mockups of a plan, or null when all are read. Ids, versions and counts only. */
export function unreadLine(states: MockupReadState[]): string | null {
	const unread = states.filter((s) => !s.readComplete);
	if (!unread.length) return null;
	const parts = unread.map((s) =>
		s.htmlLength === null
			? `${s.id} v${s.currentVersion} (not opened, ${s.sizeBytes.toLocaleString('en-US')} bytes)`
			: `${s.id} v${s.currentVersion} (${Math.max(0, s.htmlLength - s.readChars).toLocaleString('en-US')} of ${s.htmlLength.toLocaleString('en-US')} characters unread)`
	);
	return `This plan's mockup is not read to the end: ${parts.join('; ')}. Read it with mockup_get, passing your sessionId, until nextOffset is null.`;
}

/** Refuses with MOCKUP_UNREAD. Kept here so the message is written once. */
export function mockupUnreadError(
	states: MockupReadState[],
	/** What was refused: marking steps (the default), or another change that would close a step (an undo, a removal). */
	kind: 'steps' | 'change' = 'steps'
): OpError {
	const what =
		kind === 'steps'
			? 'Nothing was written by this call: the steps stay open, and any sections or decisions sent with it were not saved, so send them again.'
			: 'Nothing was changed by this call: it would close a step of a phase while the mockup is unread.';
	return new OpError(
		'MOCKUP_UNREAD',
		`${unreadLine(states)} ${what} Never unlink, trash or replace a mockup to get past this: that is the person's call.`,
		{
			mockups: states
				.filter((s) => !s.readComplete)
				.map((s) => ({
					id: s.id,
					version: s.currentVersion,
					htmlLength: s.htmlLength,
					readChars: s.readChars
				}))
		}
	);
}
