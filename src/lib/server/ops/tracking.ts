// SESSION CLAIMS, EVIDENCE, CLOSE HANDLING AND THE REMINDERS THAT RIDE INSIDE REPLIES (SPEC 9.2, 9.4)
// A session says which item and phase it works on (a claim). The claim renews on every call made with the session id, goes
// idle after a generous time without being released silently, moves to the next open phase when a phase finishes, and is
// cleared when its item closes. Everything here warns and asks; nothing blocks work (ADR-014 Warn, never block).

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { check, checkRun, item, phase, session, step } from '../db/schema';
import { notifyChange } from '../realtime/notify';
import { OpError } from './context';

// -- TYPES -- //

export type Evidence = {
	commit?: string;
	checkRunId?: string;
	target?: 'dev' | 'preview' | 'deployed';
	note?: string;
};
type Closing = 'COMPLETED' | 'REMOVED';

// -- CONSTANTS -- //

/** A session id renews its claim on any call, but the row is written at most this often. */
export const RENEW_SECONDS = 60;
/**
 * The one limit for a claim: it counts as running while it was seen within this time, and it is idle after it. Idle claims stay and
 * are shown as idle, never released silently (L23). A crash or a closed laptop sends no end event, so it clears by this time only.
 */
export const RUNNING_WINDOW_MINUTES = 120;
/** A busy session that recorded nothing for this long is reminded in its next reply. */
export const QUIET_RECORD_MINUTES = 45;
/** Progress first: this many code edits without a recorded step, or this many minutes since the first, earn a nudge (AFB-20261110-0353: sooner, so agents record before the badge shows). */
export const NUDGE_EDITS = 3;
export const NUDGE_MINUTES = 5;
/**
 * The Not recorded badge means a session LEFT edits unrecorded, never that a step is taking long (AFB-20261110-1448). It shows
 * when the session's turn ended on the Stop reminder and nothing was recorded within the grace time, or when the session has
 * been quiet for BADGE_MINUTES with unrecorded edits. A session that is still working (a long step, a long turn) shows none,
 * and neither does one that edited within the grace time. Known gaps: a tool with no Stop hook is seen only by the quiet rule,
 * and one command that runs longer than BADGE_MINUTES with no other call looks quiet until it returns.
 */
export const BADGE_MINUTES = 10;
export const BADGE_GRACE_MINUTES = 2;
/** A second session of one person and tool takes over an item's claim, and a finished item shows idle, after this quiet time. */
export const QUIET_RELEASE_MINUTES = 10;
export const CLOSING_STATUSES: Closing[] = ['COMPLETED', 'REMOVED'];
const TARGET_RANK = { dev: 1, preview: 2, deployed: 3 } as const;

// -- FUNCTIONS -- //

/** Renews a session, writing at most once a minute. A burst of calls costs one write. */
export async function renewSession(tx: Tx, sessionId: string): Promise<void> {
	await tx
		.update(session)
		.set({ lastSeenAt: sql`now()` })
		.where(
			and(
				eq(session.id, sessionId),
				sql`${session.lastSeenAt} < now() - make_interval(secs => ${RENEW_SECONDS})`
			)
		);
}

/**
 * Minutes of work a session left unrecorded, or null: the one rule behind the Not recorded badge, for a query that joins
 * `session` to its claimed `item`. Only steps of the claimed phase count when the claim names one, so open steps of a later
 * phase never mark a session that finished its own.
 */
export const staleMinutesSql = () =>
	sql<
		number | null
	>`case when ${session.firstUnrecordedEditAt} is not null and ((${session.remindedAt} >= ${session.firstUnrecordedEditAt} and ${session.remindedAt} < now() - make_interval(mins => ${BADGE_GRACE_MINUTES}) and coalesce(${session.codeTouchedAt}, ${session.firstUnrecordedEditAt}) < now() - make_interval(mins => ${BADGE_GRACE_MINUTES})) or ${session.lastSeenAt} < now() - make_interval(mins => ${BADGE_MINUTES})) and exists (select 1 from ${step} inner join ${phase} on ${phase.id} = ${step.phaseId} where ${step.itemId} = ${item.id} and ${step.state} = 'open' and (${session.claimedPhase} is null or ${phase.key} = ${session.claimedPhase})) then floor(extract(epoch from now() - ${session.firstUnrecordedEditAt}) / 60)::int else null end`;

/**
 * How far a session is behind on recording: 0 is fine, 1 starts at the first threshold (NUDGE_EDITS edits, or NUDGE_MINUTES
 * minutes since the first unrecorded edit), and every further threshold is one more level, so a nudge repeats but never on every edit.
 */
export function nudgeLevel(edits: number, firstEditAt: Date | null, now = new Date()): number {
	if (edits <= 0) return 0;
	const byCount = Math.floor(edits / NUDGE_EDITS);
	// Every further NUDGE_MINUTES without a record is one more level too, so a slow start does not use up the edit count nudge
	const byTime = firstEditAt
		? Math.floor((now.getTime() - firstEditAt.getTime()) / (NUDGE_MINUTES * 60_000))
		: 0;
	return Math.max(byCount, byTime);
}

/** The one text a nudge and a reply line use, so the hook and the board tools never drift apart. */
export const staleProgressNote = (ref: string, edits: number) =>
	`${edits} code edit${edits === 1 ? '' : 's'} on ${ref} since the last step_done. Progress first: record the steps you finished with step_done now, before the next edit.`;

/** True when the claim has not been renewed within the idle time. */
export const isIdle = (lastSeenAt: Date, now = new Date()) =>
	now.getTime() - lastSeenAt.getTime() > RUNNING_WINDOW_MINUTES * 60_000;

/**
 * Item closed (COMPLETED or REMOVED): every session claiming it lets go in the same transaction, is marked as already asked to
 * bind so no reminder asks it to bind right after, and is told in its next reply (SPEC 9.2).
 */
export async function releaseClaimsOn(
	tx: Tx,
	ctx: Ctx,
	it: { id: string; projectId: string; ref: string },
	status: Closing
): Promise<number> {
	const note = `${it.ref} was set to ${status}, so your claim on it was released. Claim another item with work_start if you continue.`;
	const released = await tx
		.update(session)
		.set({
			claimedItemId: null,
			claimedPhase: null,
			askedAt: sql`now()`,
			notices: sql`${session.notices} || ${JSON.stringify([note])}::jsonb`,
			updatedAt: sql`now()`
		})
		.where(eq(session.claimedItemId, it.id))
		.returning({ id: session.id });
	if (released.length)
		await notifyChange(tx, { o: ctx.orgId, p: it.projectId, k: 'claim', i: it.id });
	return released.length;
}

/**
 * An item turned private: every session of someone other than its creator lets go of it in the same transaction and is told
 * in its next reply, so no session keeps the reference and title of an item it can no longer see.
 */
export async function releaseOthersClaimsOn(
	tx: Tx,
	ctx: Ctx,
	it: { id: string; projectId: string; ref: string },
	creatorId: string | null
): Promise<number> {
	const note = `${it.ref} was made private by its creator, so your claim on it was released. Claim another item with work_start if you continue.`;
	const released = await tx
		.update(session)
		.set({
			claimedItemId: null,
			claimedPhase: null,
			askedAt: sql`now()`,
			notices: sql`${session.notices} || ${JSON.stringify([note])}::jsonb`,
			updatedAt: sql`now()`
		})
		.where(
			and(
				eq(session.claimedItemId, it.id),
				creatorId ? sql`${session.userId} <> ${creatorId}` : undefined
			)
		)
		.returning({ id: session.id });
	if (released.length)
		await notifyChange(tx, { o: ctx.orgId, p: it.projectId, k: 'claim', i: it.id });
	return released.length;
}

/**
 * Closing an item the session is not bound to asks first (ADR-029). A person closing from the web app is never asked. The
 * server answers CONFIRM_REQUIRED naming both items, and the agent repeats the call with `confirmed` after the user agrees.
 */
export async function requireCloseConfirmation(
	tx: Tx,
	ctx: Ctx,
	it: { id: string; ref: string; title: string },
	confirmed: boolean | undefined
): Promise<void> {
	if (ctx.actor.kind !== 'agent' || confirmed) return;
	let bound: { ref: string; title: string } | null = null;
	if (ctx.actor.sessionId) {
		const [s] = await tx
			.select({ ref: item.ref, title: item.title, id: item.id })
			.from(session)
			.innerJoin(item, eq(item.id, session.claimedItemId))
			.where(eq(session.id, ctx.actor.sessionId));
		if (s?.id === it.id) return;
		bound = s ? { ref: s.ref, title: s.title } : null;
	}
	throw new OpError(
		'CONFIRM_REQUIRED',
		`${bound ? `This session works on ${bound.ref} (${bound.title}).` : 'This session works on no item.'} You are closing ${it.ref} (${it.title}). Show this to the user and repeat the call with confirmed true only after they agree.`,
		{ closing: { ref: it.ref, title: it.title }, bound }
	);
}

/**
 * After steps were recorded: the claim moves to the next phase with an open step when its phase finished, the session notes
 * that it recorded. Returns the claim as it now stands, or null with no session. (A commit is no unrecorded edit: hooks.ts
 * counts it as a code change for the Stop reminder only.)
 */
export async function afterRecord(
	tx: Tx,
	ctx: Ctx,
	it: { id: string },
	result: {
		finishedPhases: string[];
		nextPhase: string | null;
		changedAny: boolean;
	}
): Promise<{ item: string; phase: string | null; moved: boolean } | null> {
	// A recorded step clears the unrecorded edit count of every session working on the item, not only the recording one
	if (result.changedAny)
		await tx
			.update(session)
			.set({ codeEditsSinceRecord: 0, firstUnrecordedEditAt: null, nudgedLevel: 0 })
			.where(and(eq(session.orgId, ctx.orgId), eq(session.claimedItemId, it.id)));
	if (!ctx.actor.sessionId) return null;
	if (result.changedAny)
		await tx
			.update(session)
			.set({ lastRecordAt: sql`now()` })
			.where(eq(session.id, ctx.actor.sessionId));
	const [s] = await tx.select().from(session).where(eq(session.id, ctx.actor.sessionId));
	if (!s || s.claimedItemId !== it.id) return null;
	// Only a claim on the phase that just finished moves. A claim on the whole item (no phase) stays item level.
	if (s.claimedPhase && result.finishedPhases.includes(s.claimedPhase)) {
		await tx
			.update(session)
			.set({ claimedPhase: result.nextPhase, updatedAt: sql`now()` })
			.where(eq(session.id, s.id));
		return { item: it.id, phase: result.nextPhase, moved: true };
	}
	return { item: it.id, phase: s.claimedPhase, moved: false };
}

const ago = (d: Date, now: Date) => {
	const m = Math.round((now.getTime() - d.getTime()) / 60_000);
	return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};

/**
 * What a session is told inside its replies: notices queued for it (consumed once), commits of its item nobody recorded, and
 * a claim that has been quiet. Reminders only, never an error.
 */
export async function trackingNotes(
	tx: Tx,
	sessionId: string,
	now = new Date()
): Promise<string[]> {
	const [s] = await tx.select().from(session).where(eq(session.id, sessionId));
	if (!s) return [];
	const notes: string[] = [...(s.notices ?? [])];
	if (notes.length)
		await tx
			.update(session)
			.set({ notices: sql`'[]'::jsonb` })
			.where(eq(session.id, s.id));
	if (s.claimedItemId) {
		const [it] = await tx.select({ ref: item.ref }).from(item).where(eq(item.id, s.claimedItemId));
		// Edits since the last record: a read only line, the nudge state is never consumed here, so a session without hooks still hears it
		if (
			it &&
			s.codeEditsSinceRecord > 0 &&
			nudgeLevel(s.codeEditsSinceRecord, s.firstUnrecordedEditAt, now) >= 1
		) {
			const [open] = await tx
				.select({ n: sql<number>`count(*)::int` })
				.from(step)
				.where(and(eq(step.itemId, s.claimedItemId), eq(step.state, 'open')));
			if (open && open.n > 0) notes.push(staleProgressNote(it.ref, s.codeEditsSinceRecord));
		}
		const since = s.lastRecordAt ?? s.createdAt;
		if (it && now.getTime() - since.getTime() > QUIET_RECORD_MINUTES * 60_000)
			notes.push(
				`You claimed ${it.ref} ${ago(since, now)} ago and recorded nothing since. Record finished steps with step_done, or release the claim with work_stop.`
			);
	}
	return notes;
}

const sameCommit = (sha: string, given: string) =>
	given.length >= 7 && sha.toLowerCase().startsWith(given.toLowerCase());

/**
 * Evidence is checked by the server, never taken on trust (L22). A commit is plain text and only has to look like a git hash. A check run
 * must exist on this item, have passed, match the commit, and be on a target at least as strong as the step requires.
 */
export async function validateEvidence(
	tx: Tx,
	ctx: Ctx,
	it: { id: string; ref: string; projectId: string },
	stepRow: { key: string; requiredTarget: string | null },
	evidence: Evidence | undefined
): Promise<void> {
	const fail = (message: string) => {
		throw new OpError('INVALID', `Step ${stepRow.key}: ${message}`, {
			reason: 'evidence',
			step: stepRow.key
		});
	};
	const required = stepRow.requiredTarget as keyof typeof TARGET_RANK | null;
	if (required && !evidence?.checkRunId)
		fail(`it needs a passed check run on ${required}. Send checkRunId in the evidence.`);
	if (!evidence) return;
	if (evidence.target && !evidence.checkRunId)
		fail('a target needs the checkRunId of the run that passed on it.');
	let runCommit: string | null = null;
	if (evidence.checkRunId) {
		if (!/^[0-9a-f-]{36}$/i.test(evidence.checkRunId)) fail('the check run id is not valid.');
		const [run] = await tx
			.select({
				result: checkRun.result,
				target: checkRun.target,
				commit: checkRun.commit,
				itemId: check.itemId
			})
			.from(checkRun)
			.innerJoin(check, eq(check.id, checkRun.checkId))
			.where(and(eq(checkRun.id, evidence.checkRunId), eq(checkRun.orgId, ctx.orgId)));
		if (!run) fail('no such check run in this organisation.');
		if (run!.itemId !== it.id) fail(`that check run belongs to another item, not ${it.ref}.`);
		if (run!.result !== 'pass') fail(`that check run did not pass (${run!.result}).`);
		if (evidence.target && evidence.target !== run!.target)
			fail(`that check run ran on ${run!.target}, not ${evidence.target}.`);
		if (required && TARGET_RANK[run!.target as keyof typeof TARGET_RANK] < TARGET_RANK[required])
			fail(`it needs a pass on ${required}, and that run was on ${run!.target}.`);
		runCommit = run!.commit;
	}
	if (evidence.commit) {
		if (!/^[0-9a-fA-F]{7,40}$/.test(evidence.commit)) fail('the commit is not a git hash.');
		if (runCommit && !sameCommit(runCommit, evidence.commit))
			fail('the check run was made on a different commit than the one given.');
	}
}
