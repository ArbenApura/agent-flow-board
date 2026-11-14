// WHICH ITEM IS THE CONVERSATION WITH THIS EXTERNAL ID WORKING ON? A READ ONLY ANSWER FOR AN EDITOR STATUS LINE.
// It never renews a session, writes an event or sends a change notice, so a status line can poll it all day without
// keeping a dead conversation "running". The percent, status and step counts are the values the board already stored.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { WaitingBlocker } from '../db/schema/activity';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { item, itemAlias, org, phase, project, section, session, step } from '../db/schema';
import { OpError, requireCap, run } from './context';
import { mayView } from './resolve';

// -- CONSTANTS -- //

/** The tools whose hooks name their own conversation id (the same list as the hook endpoint). */
export const SESSION_TOOLS = ['claude-code', 'antigravity', 'gemini'] as const;
/** Notes written by other people are cut, so one long section cannot make every poll heavy. */
export const NOTE_LIMIT = 1200;
const CUT_MARK = ' [cut]';

export const sessionStatusInput = z.object({
	externalId: z.string().min(8).max(100),
	tool: z.enum(SESSION_TOOLS).default('claude-code'),
	/** The etag of the last answer. When nothing changed the answer is just { unchanged: true }. */
	etag: z.string().max(80).optional()
});

// -- TYPES -- //

export type SessionStatus = {
	sessionId: string;
	tool: string;
	externalId: string;
	etag: string;
	waiting: WaitingBlocker | null;
	item: {
		ref: string;
		aliases: string[];
		title: string;
		tabName: string | null;
		status: string;
		percent: number;
		phase: { key: string; title: string; position: number; of: number } | null;
		steps: { done: number; open: number; waived: number; total: number };
		manualChecksOpen: number;
		resumeHere: string;
		blockers: string;
		updatedAt: string;
		url: string | null;
	} | null;
};

// -- FUNCTIONS -- //

const cut = (text: string | undefined) =>
	!text ? '' : text.length > NOTE_LIMIT ? text.slice(0, NOTE_LIMIT) + CUT_MARK : text;

/**
 * The status of one session row the caller already holds, built inside the caller's transaction. One function serves the
 * lookup route and the hook answer, so both show the same fields, read the item through mayView and cut the notes the same way.
 */
async function buildStatus(
	tx: Tx,
	ctx: Ctx,
	row: typeof session.$inferSelect
): Promise<SessionStatus> {
	const base = {
		sessionId: row.id,
		tool: row.tool,
		externalId: row.externalId ?? '',
		waiting: row.waiting ?? null
	};
	let out: Omit<SessionStatus, 'etag'> = { ...base, item: null };

	const [it] = row.claimedItemId
		? await tx.select().from(item).where(eq(item.id, row.claimedItemId))
		: [];
	// The project, token and privacy rules of every item verb, not canSeeItem alone
	if (it && !it.deletedAt && (await mayView(tx, ctx, it))) {
		const phases = await tx
			.select({ key: phase.key, title: phase.title })
			.from(phase)
			.where(eq(phase.itemId, it.id))
			.orderBy(asc(phase.position));
		const [waived] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(step)
			.where(and(eq(step.itemId, it.id), eq(step.state, 'waived')));
		const notes = await tx
			.select({ slug: section.slug, body: section.body })
			.from(section)
			.where(and(eq(section.itemId, it.id), inArray(section.slug, ['resume-here', 'blockers'])));
		const aliases = await tx
			.select({ alias: itemAlias.alias })
			.from(itemAlias)
			.where(eq(itemAlias.itemId, it.id))
			.orderBy(asc(itemAlias.alias));
		const [where] = await tx
			.select({ key: project.key, slug: org.slug })
			.from(project)
			.innerJoin(org, eq(org.id, project.orgId))
			.where(eq(project.id, it.projectId));
		// A claimed phase that was removed, or an item with no phases, has no position to show
		const at = row.claimedPhase ? phases.findIndex((p) => p.key === row.claimedPhase) : -1;
		const siteUrl = ctx.services?.baseUrl;
		out = {
			...base,
			item: {
				ref: it.ref,
				aliases: aliases.map((a) => a.alias),
				title: it.title,
				tabName: it.tabName,
				status: it.status,
				// The stored percent already holds a frozen percent for an imported item (db/calc.ts), as the item page shows it
				percent: it.percent,
				phase: at < 0 ? null : { ...phases[at], position: at + 1, of: phases.length },
				steps: {
					done: it.doneSteps,
					open: it.totalSteps - it.doneSteps,
					waived: waived?.n ?? 0,
					total: it.totalSteps
				},
				manualChecksOpen: it.openManual,
				resumeHere: cut(notes.find((n) => n.slug === 'resume-here')?.body),
				blockers: cut(notes.find((n) => n.slug === 'blockers')?.body),
				updatedAt: it.updatedAt.toISOString(),
				url: siteUrl && where ? `${siteUrl}/${where.slug}/${where.key}/${it.ref}` : null
			}
		};
	}
	// The etag is a hash of the whole answer, so a note, a claim, a phase or a step that changes it changes the etag too
	const etag = createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 32);
	return { ...out, etag };
}

/**
 * The status of a session row that a hook already loaded, for the hook answer. It needs the read permission and answers
 * item null for a claimed item the caller may not see, exactly like the lookup. The row must be the caller's own.
 */
export async function sessionStatusForRow(
	ctx: Ctx,
	row: typeof session.$inferSelect
): Promise<SessionStatus> {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		// A row of another person or organisation is never shown, whatever the caller passes
		if (row.orgId !== ctx.orgId || row.userId !== ctx.actor.userId)
			throw new OpError('NOT_FOUND', 'Not found.');
		return buildStatus(tx, ctx, row);
	});
}

/**
 * The item the caller's own session with this external id has claimed, as a small answer for a status line.
 * A missing session, another person's session and an unknown id all answer the same NOT_FOUND, so ids cannot be probed.
 * A claimed item the caller may no longer see (private, another project, a lost role) answers item null.
 */
export async function sessionStatusByExternal(
	ctx: Ctx,
	raw: z.input<typeof sessionStatusInput>
): Promise<SessionStatus | { unchanged: true; etag: string }> {
	const input = sessionStatusInput.parse(raw);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const [row] = await tx
			.select()
			.from(session)
			.where(
				and(
					eq(session.orgId, ctx.orgId),
					eq(session.userId, ctx.actor.userId),
					eq(session.tool, input.tool),
					eq(session.externalId, input.externalId)
				)
			);
		if (!row) throw new OpError('NOT_FOUND', 'Not found.');
		const status = await buildStatus(tx, ctx, row);
		if (input.etag && input.etag === status.etag)
			return { unchanged: true as const, etag: status.etag };
		return status;
	});
}
