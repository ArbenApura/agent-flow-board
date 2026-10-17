// SESSION CLAIMS, EVIDENCE, CLOSE HANDLING AND THE REMINDERS THAT RIDE INSIDE REPLIES (SPEC 9.2, 9.4)
// A session says which item and phase it works on (a claim). The claim renews on every call made with the session id, goes
// idle after a generous time without being released silently, moves to the next open phase when a phase finishes, and is
// cleared when its item closes. Everything here warns and asks; nothing blocks work (ADR-014 Warn, never block).

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
// -- MODULES -- //
import { check, checkRun, commitLink, item, session, step } from '../db/schema';
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
/** A claim not renewed for this long is idle. It stays, and is shown as idle, never released silently (L23). */
export const IDLE_MINUTES = 90;
/** A busy session that recorded nothing for this long is reminded in its next reply. */
export const QUIET_RECORD_MINUTES = 45;
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

/** True when the claim has not been renewed within the idle time. */
export const isIdle = (lastSeenAt: Date, now = new Date()) =>
	now.getTime() - lastSeenAt.getTime() > IDLE_MINUTES * 60_000;

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
 * that it recorded, and commits of the item count as recorded. Returns the claim as it now stands, or null with no session.
 */
export async function afterRecord(
	tx: Tx,
	ctx: Ctx,
	it: { id: string },
	result: {
		finishedPhases: string[];
		nextPhase: string | null;
		anyDone: boolean;
		changedAny: boolean;
	}
): Promise<{ item: string; phase: string | null; moved: boolean } | null> {
	if (result.anyDone)
		await tx
			.update(commitLink)
			.set({ recorded: true, updatedAt: sql`now()` })
			.where(and(eq(commitLink.itemId, it.id), eq(commitLink.recorded, false)));
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
		const unrecorded = await tx
			.select({ sha: commitLink.sha, message: commitLink.message })
			.from(commitLink)
			.where(and(eq(commitLink.itemId, s.claimedItemId), eq(commitLink.recorded, false)))
			.orderBy(desc(commitLink.createdAt))
			.limit(3);
		if (it && unrecorded.length)
			notes.push(
				`${unrecorded.length === 3 ? '3 or more commits' : unrecorded.length === 1 ? '1 commit' : `${unrecorded.length} commits`} on ${it.ref} ${unrecorded.length === 1 ? 'has' : 'have'} no recorded step (${unrecorded.map((c) => c.sha.slice(0, 7)).join(', ')}). Record the finished steps with step_done.`
			);
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
 * Evidence is checked by the server, never taken on trust (L22). A commit must be known and must change files. A check run
 * must exist on this item, have passed, match the commit, and be on a target at least as strong as the step requires.
 * `verifyCommit` asks GitHub when the commit was not seen through a webhook.
 */
export async function validateEvidence(
	tx: Tx,
	ctx: Ctx,
	it: { id: string; ref: string; projectId: string },
	stepRow: { key: string; requiredTarget: string | null },
	evidence: Evidence | undefined,
	verifyCommit?: (sha: string) => Promise<{ files: string[]; message: string } | null>
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
		const rows = await tx
			.select({ files: commitLink.files, sha: commitLink.sha })
			.from(commitLink)
			.where(
				and(
					eq(commitLink.projectId, it.projectId),
					sql`${commitLink.sha} like ${evidence.commit.toLowerCase() + '%'}`
				)
			);
		let files = rows[0]?.files;
		if (!rows.length) {
			if (!verifyCommit)
				fail(
					'this project has no connected repository, so a commit cannot be verified. Leave the commit out, or connect a repository.'
				);
			const found = await verifyCommit!(evidence.commit);
			if (!found) fail('that commit is not in the connected repository.');
			files = found!.files;
		}
		if (!files || files.length === 0) fail('that commit changes no files.');
	}
}

/** The newest 20 unrecorded commits of one item, for the item page and the health panel. */
export async function unrecordedCommits(tx: Tx, itemIds: string[]) {
	if (!itemIds.length) return [];
	return tx
		.select()
		.from(commitLink)
		.where(and(inArray(commitLink.itemId, itemIds), eq(commitLink.recorded, false)))
		.orderBy(desc(commitLink.createdAt))
		.limit(200);
}

/** Open steps that need a passed check on a target and have none, among done steps (SPEC 9.4 "steps without evidence"). */
export async function stepsWithoutEvidence(tx: Tx, projectId: string) {
	return tx
		.select({ itemId: step.itemId, key: step.key, text: step.text, target: step.requiredTarget })
		.from(step)
		.where(
			and(
				eq(step.projectId, projectId),
				eq(step.state, 'done'),
				sql`${step.requiredTarget} is not null`,
				isNull(step.evidence)
			)
		)
		.limit(200);
}

/** Sessions currently claiming something in a project, newest first. */
export async function claimsIn(tx: Tx, projectId: string, since?: Date) {
	return tx
		.select({
			sessionId: session.id,
			tool: session.tool,
			lastSeenAt: session.lastSeenAt,
			phase: session.claimedPhase,
			itemId: item.id,
			ref: item.ref,
			status: item.status
		})
		.from(session)
		.innerJoin(item, eq(item.id, session.claimedItemId))
		.where(and(eq(item.projectId, projectId), since ? gt(session.lastSeenAt, since) : undefined))
		.orderBy(desc(session.lastSeenAt));
}
