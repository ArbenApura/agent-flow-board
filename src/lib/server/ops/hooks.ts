// WHAT A TOOL'S HOOKS DO ON THE SERVER: THE BRIEF, THE SESSION TITLE, THE HEARTBEAT, THE CLOSE QUESTION AND THE STOP REMINDER (SPEC 9.3)
// The adapters in the bridge turn each tool's own hook payload into one small event and turn the answer back. Every rule lives
// here, so Claude Code, Antigravity and Gemini CLI behave alike. Hooks warn and ask, they never block work (ADR-014).

// -- TYPES -- //
import type { Ctx } from './context';
import type { SessionStatus } from './sessionStatus';
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { commits, isCodeFile } from '../../shared/code';
import { item, phase, session, step } from '../db/schema';
import { modVersion } from '../editor-status';
import { updateNotice } from '../editor-status/version';
import { notifyChange } from '../realtime/notify';
import { SESSION_PREFIX, displayTitle } from '../mcp/sessions';
import { requireCap, run } from './context';
import { findItem, mayView } from './resolve';
import { logSessionEvent } from './sessionEvents';
import { sessionStatusForRow } from './sessionStatus';
import { CLOSING_STATUSES, nudgeLevel, renewSession, staleProgressNote } from './tracking';

// -- TYPES -- //

export const hookInput = z.object({
	tool: z.enum(['claude-code', 'antigravity', 'gemini']),
	event: z.enum(['start', 'prompt', 'tool', 'closing', 'stop', 'end']),
	/** The tool's own id for the conversation. */
	externalId: z.string().min(8).max(100),
	/** The folder the tool works in, for the brief. */
	cwd: z.string().max(500).optional(),
	subagent: z.boolean().optional(),
	stopActive: z.boolean().optional(),
	/** A tool call that failed only counts as a heartbeat. */
	failed: z.boolean().optional(),
	action: z
		.discriminatedUnion('kind', [
			z.object({ kind: z.literal('edit'), file: z.string().max(1000) }),
			z.object({ kind: z.literal('shell'), command: z.string().max(4000) }),
			z.object({ kind: z.literal('board'), name: z.string().max(80) }),
			z.object({ kind: z.literal('read') })
		])
		.optional(),
	closing: z
		.array(z.object({ item: z.string().max(100), status: z.string().max(20) }))
		.max(10)
		.optional(),
	/** Ask for the status of this conversation's own session in the answer (the bridge writes it for an editor status line). */
	status: z.boolean().optional(),
	/** The version of the editor status mod the person has installed, sent on a start. Anything that is not a plain version is ignored. */
	modVersion: z.string().max(20).optional()
});
export type HookInput = z.infer<typeof hookInput>;
export type HookOutput = {
	/** Added to the conversation (the brief). */
	context?: string;
	/** The tab or conversation title, TAB_NAME: REF. */
	title?: string;
	/** A question to show the person before a tool call runs. */
	ask?: string;
	/** A reminder that asks the agent to carry on and record. */
	block?: string;
	/** Sent right after an edit when finished work is not recorded yet: progress first. Never blocks. */
	nudge?: string;
	/** Only when the request asked for it: what this conversation's session works on, for an editor status line. */
	status?: SessionStatus;
	/** A line for the person at the start of a conversation: a newer editor status mod is available. */
	notice?: string;
};

// -- FUNCTIONS -- //

async function sessionFor(ctx: Ctx, input: HookInput) {
	return run(ctx, async (tx) => {
		const tool = input.tool;
		const [found] = await tx
			.select()
			.from(session)
			.where(
				and(
					eq(session.orgId, ctx.orgId),
					eq(session.userId, ctx.actor.userId),
					eq(session.tool, tool),
					eq(session.externalId, input.externalId)
				)
			);
		if (found) {
			await renewSession(tx, found.id);
			return found;
		}
		const [made] = await tx
			.insert(session)
			.values({
				id: SESSION_PREFIX + randomBytes(12).toString('base64url'),
				orgId: ctx.orgId,
				userId: ctx.actor.userId,
				tokenId: ctx.actor.tokenId ?? null,
				tool,
				externalId: input.externalId
			})
			.onConflictDoNothing()
			.returning();
		if (made) return made;
		const [again] = await tx
			.select()
			.from(session)
			.where(
				and(
					eq(session.orgId, ctx.orgId),
					eq(session.userId, ctx.actor.userId),
					eq(session.tool, tool),
					eq(session.externalId, input.externalId)
				)
			);
		return again;
	});
}

async function claimedItem(ctx: Ctx, s: typeof session.$inferSelect) {
	if (!s.claimedItemId) return null;
	return run(ctx, async (tx) => {
		const [it] = await tx.select().from(item).where(eq(item.id, s.claimedItemId!));
		// An item turned private after the claim is no longer shown to a session that may not see it
		return it && (await mayView(tx, ctx, it)) ? it : null;
	});
}

/** The keys of the steps still open on an item, in plan order, limited to the claimed phase when there is one. */
async function openStepKeys(
	ctx: Ctx,
	itemId: string,
	phaseKey: string | null,
	limit: number
): Promise<string[]> {
	const rows = await run(ctx, (tx) =>
		tx
			.select({ key: step.key })
			.from(step)
			.innerJoin(phase, eq(phase.id, step.phaseId))
			.where(
				and(
					eq(step.itemId, itemId),
					eq(step.state, 'open'),
					phaseKey ? eq(phase.key, phaseKey) : undefined
				)
			)
			.orderBy(phase.position, step.position)
			.limit(limit)
	);
	return rows.map((r) => r.key);
}

/**
 * Said at Stop to a session that records steps and still holds an item with open steps, once per record.
 * It never fires for a session that has recorded nothing (a plan waiting for approval), so a legitimate pause stays quiet.
 */
async function openStepsReminder(
	ctx: Ctx,
	s: typeof session.$inferSelect,
	mine: typeof item.$inferSelect | null
): Promise<string | null> {
	if (!mine || (CLOSING_STATUSES as string[]).includes(mine.status) || !s.lastRecordAt) return null;
	if (s.remindedAt && s.remindedAt.getTime() >= s.lastRecordAt.getTime()) return null;
	const open = await openStepKeys(ctx, mine.id, null, 3);
	if (!open.length) return null;
	return `${mine.ref} still has open steps (next: ${open.join(', ')}). Carry on with the next one, unless you are waiting for the user's answer. When the work is finished, call work_stop so the Running badge clears.`;
}

/** The board brief: what is open, and the three rules that matter at the start of work. */
async function brief(ctx: Ctx, s: typeof session.$inferSelect): Promise<string> {
	const rows = await run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const found = await tx
			.select()
			.from(item)
			.where(
				and(
					sql`${item.deletedAt} is null`,
					inArray(item.status, ['IN PROGRESS', 'IN REVIEW', 'PLANNED'])
				)
			)
			.orderBy(desc(item.lastActivityAt))
			.limit(80);
		// Only what this person may see: a project they have no role in, and a private item that is not theirs, stay out
		const seen: {
			ref: string;
			title: string;
			status: string;
			percent: number;
			tab: string | null;
		}[] = [];
		for (const r of found) {
			if (seen.length >= 15) break;
			if (await mayView(tx, ctx, r))
				seen.push({
					ref: r.ref,
					title: r.title,
					status: r.status,
					percent: r.percent,
					tab: r.tabName
				});
		}
		return seen;
	});
	const lines = rows.map((r) => `- ${r.ref} ${r.title} | ${r.status} ${r.percent}%`);
	const mine = await claimedItem(ctx, s);
	return [
		`agent-flow-board: ${rows.length} open item${rows.length === 1 ? '' : 's'}.`,
		...lines,
		// The session the hooks keep is the one the tools must use, so a claim and the hooks' reminders belong together
		`Your session id is ${s.id}. Pass it as sessionId to every tracking and write tool. session_start is not needed.`,
		mine
			? `This session is working on ${mine.ref}.`
			: 'When the user names an item, call work_start for it before editing. Progress first: call step_done the moment each step is finished, before you start the next one, never at the end of a phase.',
		'Status and percent follow your records, so never type them. Ask the user about money, intent and priority only.'
	].join('\n');
}

/** The title this session should show, when it has not been sent yet or the item changed. */
async function titleFor(
	ctx: Ctx,
	s: typeof session.$inferSelect,
	force = false
): Promise<string | null> {
	const it = await claimedItem(ctx, s);
	if (!it) return null;
	const title = displayTitle(it.tabName, it.ref);
	if (!force && s.titleSent === title) return null;
	await run(ctx, async (tx) => {
		await tx
			.update(session)
			.set({ titleSent: title, label: title.slice(0, 60) })
			.where(eq(session.id, s.id));
		if (it) await notifyChange(tx, { o: ctx.orgId, p: it.projectId, k: 'claim', i: it.id });
	});
	return title;
}

/** The conversation ended: its session lets go of its claim, so no running badge outlives the tab. Only this person's own session. */
async function endSession(ctx: Ctx, input: HookInput): Promise<HookOutput> {
	await run(ctx, async (tx) => {
		const [found] = await tx
			.select({ id: session.id, itemId: session.claimedItemId })
			.from(session)
			.where(
				and(
					eq(session.orgId, ctx.orgId),
					eq(session.userId, ctx.actor.userId),
					eq(session.tool, input.tool),
					eq(session.externalId, input.externalId)
				)
			);
		if (!found?.itemId) return;
		const [held] = await tx
			.select({ projectId: item.projectId })
			.from(item)
			.where(eq(item.id, found.itemId));
		await tx
			.update(session)
			.set({
				claimedItemId: null,
				claimedPhase: null,
				// Asked already, so no reminder asks this finished session to bind again
				askedAt: sql`now()`,
				codeEditsSinceRecord: 0,
				firstUnrecordedEditAt: null,
				nudgedLevel: 0,
				updatedAt: sql`now()`
			})
			.where(eq(session.id, found.id));
		await logSessionEvent(tx, {
			orgId: ctx.orgId,
			sessionId: found.id,
			itemId: found.itemId,
			tool: input.tool,
			kind: 'end'
		});
		if (held)
			await notifyChange(tx, { o: ctx.orgId, p: held.projectId, k: 'claim', i: found.itemId });
	});
	return {};
}

/**
 * One hook event of one tool. Always answers, never throws on a bad item name or an unknown session.
 * With the flag status the answer also carries the status of this conversation's own session, built after the event ran so it
 * shows the claim as it is now. A failure to build it leaves the field out and never loses a block, a nudge or a question.
 */
export async function handleHook(ctx: Ctx, raw: z.input<typeof hookInput>): Promise<HookOutput> {
	const input = hookInput.parse(raw);
	const held: { s?: typeof session.$inferSelect } = {};
	const out = await handleEvent(ctx, input, held);
	// The end of a conversation has no status: the bridge removes its file
	if (!input.status || input.event === 'end' || !held.s) return out;
	try {
		return { ...out, status: await sessionStatusForRow(ctx, held.s) };
	} catch {
		return out;
	}
}

async function handleEvent(
	ctx: Ctx,
	input: HookInput,
	held: { s?: typeof session.$inferSelect }
): Promise<HookOutput> {
	// The end of a conversation only lets go of its own claim. It never makes a session that does not exist.
	if (input.event === 'end') return endSession(ctx, input);
	const s = await sessionFor(ctx, input);
	held.s = s;
	if (input.event === 'start') {
		const [context, title] = await Promise.all([brief(ctx, s), titleFor(ctx, s, true)]);
		// Only Claude Code has the mod, and only a start says so: one line per conversation
		// The line is a courtesy: it is looked up only when the bridge sent a version, and a problem with it never costs the brief
		let notice: string | null = null;
		try {
			if (input.tool === 'claude-code' && input.modVersion)
				notice = updateNotice(input.modVersion, modVersion());
		} catch {
			notice = null;
		}
		return { context, ...(title ? { title } : {}), ...(notice ? { notice } : {}) };
	}
	if (input.event === 'prompt') {
		const title = await titleFor(ctx, s);
		return title ? { title } : {};
	}
	if (input.event === 'tool') {
		// A failed call and a read are heartbeats and nothing more. A subagent's edit counts for the session (its work is the
		// session's work) but never sends a nudge, because the subagent cannot record a step.
		const a = input.action;
		if (input.failed || !a) return {};
		const codeChange =
			(a.kind === 'edit' && isCodeFile(a.file)) || (a.kind === 'shell' && commits(a.command));
		if (!codeChange) return {};
		// One atomic update counts the edit, so two hooks running at once never lose a count
		const [counted] = await run(ctx, (tx) =>
			tx
				.update(session)
				.set({
					codeTouchedAt: sql`now()`,
					codeEditsSinceRecord: sql`${session.codeEditsSinceRecord} + 1`,
					firstUnrecordedEditAt: sql`coalesce(${session.firstUnrecordedEditAt}, now())`
				})
				.where(eq(session.id, s.id))
				.returning({
					edits: session.codeEditsSinceRecord,
					firstAt: session.firstUnrecordedEditAt,
					level: session.nudgedLevel
				})
		);
		if (!counted || input.subagent) return {};
		const level = nudgeLevel(counted.edits, counted.firstAt);
		if (level < 1 || level <= counted.level) return {};
		const mine = await claimedItem(ctx, s);
		if (!mine || (CLOSING_STATUSES as string[]).includes(mine.status)) return {};
		const openSteps = await run(ctx, async (tx) => {
			const [row] = await tx
				.select({ n: sql<number>`count(*)::int` })
				.from(step)
				.where(and(eq(step.itemId, mine.id), eq(step.state, 'open')));
			return row?.n ?? 0;
		});
		if (!openSteps) return {};
		// Taking the level is one conditional update, so only one of several parallel hooks sends the nudge
		const taken = await run(ctx, (tx) =>
			tx
				.update(session)
				.set({ nudgedLevel: level })
				.where(and(eq(session.id, s.id), sql`${session.nudgedLevel} < ${level}`))
				.returning({ id: session.id })
		);
		if (!taken.length) return {};
		await run(ctx, (tx) =>
			logSessionEvent(tx, {
				orgId: ctx.orgId,
				sessionId: s.id,
				itemId: mine.id,
				tool: s.tool,
				kind: 'nudge',
				detail: `${counted.edits} edits, level ${level}`
			})
		);
		return { nudge: staleProgressNote(mine.ref, counted.edits) };
	}
	if (input.event === 'closing') {
		const targets = (input.closing ?? []).filter((c) =>
			(CLOSING_STATUSES as string[]).includes(c.status.toUpperCase())
		);
		if (!targets.length) return {};
		const mine = await claimedItem(ctx, s);
		for (const t of targets) {
			const found = await run(ctx, (tx) => findItem(tx, ctx, t.item)).catch(() => null);
			if (!found || found.id === mine?.id) continue;
			const name = (r: { ref: string; title: string }) => `${r.ref} (${r.title})`;
			return {
				ask: `${mine ? `This session works on ${name(mine)}.` : 'This session works on no item.'} You are closing ${name(found)}.`
			};
		}
		return {};
	}
	// stop: one reminder per code change, never twice for the same one
	if (input.stopActive) return {};
	const mine = await claimedItem(ctx, s);
	const changed =
		!!s.codeTouchedAt && !(s.remindedAt && s.codeTouchedAt.getTime() <= s.remindedAt.getTime());
	let block: string | null = null;
	if (changed && s.codeTouchedAt) {
		// A session that was told to work on no item (a close released it, or "none" was said) is not asked again
		if (!mine && s.askedAt) return {};
		if (!mine) {
			block =
				'Code changed in this session, but it works on no item. If the work belongs to an item, call work_start with it and record the finished steps with step_done. If it belongs to none, say so and carry on.';
		} else if (!(CLOSING_STATUSES as string[]).includes(mine.status)) {
			const recorded = s.lastRecordAt && s.lastRecordAt.getTime() >= s.codeTouchedAt.getTime();
			if (!recorded) {
				// Name the steps still open in the claimed phase (or the item), so the agent sees which ones to record
				const open = await openStepKeys(ctx, mine.id, s.claimedPhase, 8);
				const named = open.length
					? ` Steps still open: ${open.join(', ')}.`
					: ' No step is open in this phase: call work_stop when the work is finished, so the Running badge clears.';
				block = `Code changed after the last record on ${mine.ref}. Record progress with step_done for the steps you finished before you end the turn, or add one log line saying what changed.${named}`;
			}
		}
	}
	// Mid build with steps still open: one reminder per record, so an agent does not end its turn early (it may still wait for the user)
	if (!block) block = await openStepsReminder(ctx, s, mine);
	if (!block) return {};
	await run(ctx, async (tx) => {
		await tx
			.update(session)
			.set({ remindedAt: sql`now()` })
			.where(eq(session.id, s.id));
		await logSessionEvent(tx, {
			orgId: ctx.orgId,
			sessionId: s.id,
			itemId: mine?.id ?? null,
			tool: s.tool,
			kind: 'stop_reminder',
			detail: mine ? undefined : 'no item'
		});
	});
	return { block };
}
