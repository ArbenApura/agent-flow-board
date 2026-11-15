// BRIDGE APPROVALS THE AGENT HANDLES ON ITS OWN (AFB-20261108-2349), BUILT ON THE REQUEST/CLAIM PATH OF AFB-20261108-1444
// An agent that runs the bridge files a request over the tool's own runner token. A request from a machine whose owner still exists, is still a member and still holds manage is approved
// the moment it is filed. Nobody clicks, and there is no switch (AFB-20261115-1229: the per-person switch was removed, agent approvals are always on). The safety that stays: only the tool's
// own runner token reaches this path, the owner's live role is checked at the request AND at the claim, a decision is single use (one action, one server-normalised target, one machine,
// ten minutes), hourly caps bound the rate, and every batch leaves an org event. The agent's own words (`why`) are untrusted plain text.

// IMPORTED TYPES
import type { Ctx } from './context';
import type { DbHandle, Tx } from '../db/client';
import type { RunnerAuth } from './environments';
// IMPORTED DEP-MODULES
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { APPROVAL_ACTIONS, bridgeApproval, project } from '../db/schema';
import { withTenant } from '../db/tenant';
import { OpError, capsOf, orgRoleOf, requireCap, run } from './context';
import { appendOrgEvent } from './settings';

// -- TYPES -- //

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export type ApprovalRow = typeof bridgeApproval.$inferSelect;

// -- CONSTANTS -- //

/** After a request is approved the bridge has this long to claim, the same ten minutes a terminal code lives. */
export const APPROVAL_CLAIM_MINUTES = 10;
/** Requests that nobody decided wait this long (only rows filed before agent approvals were made permanent can be left like this). */
export const APPROVAL_WAIT_MINUTES = 30;
/** Decided and ended rows are kept this long for the history, then removed. */
export const APPROVAL_RETENTION_DAYS = 30;
/** Most waiting requests one machine may hold. */
export const MAX_PENDING_PER_RUNNER = 20;
/** Most entries of one batch (the bridge's own cap). */
export const MAX_BATCH = 20;
/** Most requests one machine may file in an hour. */
const MAX_PER_HOUR = 200;
/** Most auto-approved requests of one kind a machine may file in an hour: a runaway agent cannot open windows or add folders without limit. */
const AUTO_PER_HOUR: Record<ApprovalAction, number> = {
	login: 10,
	roots: 20,
	register: 30,
	secrets: 30,
	'adopt-env': 30,
	pictures: 30,
	dev: 20
};
const WHY_MAX = 300;
const TARGET_MAX = 400;
export const OWNER_REFUSED_MESSAGE =
	'This computer cannot be approved: the person it belongs to is no longer a member of the organisation with the manage role. Reconnect the computer as a person who has it.';

export const approvalEntryInput = z.object({
	action: z.enum(APPROVAL_ACTIONS),
	target: z.string().min(1).max(TARGET_MAX)
});
export const approvalRequestInput = z.object({
	/** The bridge's id for this ask, so a retry is the same ask. */
	requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
	entries: z.array(approvalEntryInput).min(1).max(MAX_BATCH),
	why: z.string().max(2000).optional(),
	project: z.string().max(40).optional()
});
export const approvalIdsInput = z.object({
	ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH)
});

// -- FUNCTIONS -- //

/** The target as the server keeps it. A name is lower case; a folder was resolved on the machine by the bridge and is kept as sent. */
export function normaliseApprovalTarget(action: ApprovalAction, target: string): string {
	const text = String(target ?? '').trim();
	// eslint-disable-next-line no-control-regex
	if (!text || text.length > TARGET_MAX || /[\u0000-\u001f\u007f]/.test(text))
		throw new OpError('INVALID', 'An approval needs a target (a name or a folder) in plain text.');
	return action === 'roots' ? text : text.toLowerCase();
}

/** The agent's own words, as plain text of at most 300 characters. */
export function plainWhy(why: string | undefined): string | null {
	if (!why) return null;
	// eslint-disable-next-line no-control-regex
	const text = why.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
	return text ? text.slice(0, WHY_MAX) : null;
}

const hashOf = (action: string, target: string, runnerId: string) =>
	createHash('sha256').update(`${action}\0${target}\0${runnerId}`).digest('hex');

/** Moves waiting requests and unclaimed decisions past their time to expired, and removes old history. Runs inside the tenant transaction. */
export async function sweepApprovals(tx: Tx, orgId: string): Promise<void> {
	await tx
		.update(bridgeApproval)
		.set({ status: 'expired', updatedAt: sql`now()` })
		.where(
			and(
				eq(bridgeApproval.orgId, orgId),
				inArray(bridgeApproval.status, ['pending', 'approved']),
				sql`${bridgeApproval.expiresAt} <= now()`
			)
		);
	await tx
		.delete(bridgeApproval)
		.where(
			and(
				eq(bridgeApproval.orgId, orgId),
				inArray(bridgeApproval.status, ['refused', 'expired', 'cancelled', 'claimed']),
				lt(bridgeApproval.updatedAt, sql`now() - make_interval(days => ${APPROVAL_RETENTION_DAYS})`)
			)
		);
}

/**
 * Whether the person who owns this machine may have it approved. The owner must still exist, still be a member and still hold manage today; a machine with no owner
 * (the person was deleted) never auto-approves. Checked at the request and again at the claim, so a demoted or removed owner claims nothing.
 */
async function ownerMayApprove(tx: Tx, auth: RunnerAuth): Promise<boolean> {
	if (!auth.ownerId) return false;
	const role = await orgRoleOf(tx, auth.orgId, auth.ownerId);
	return capsOf(role).includes('manage');
}

/** Only the tool's own runner token reaches the approvals: never a run key, a local or a hosted runner. */
function requireTool(auth: RunnerAuth): void {
	if (auth.kind !== 'tool')
		throw new OpError('FORBIDDEN', 'Only the checks tool of a person can ask for approvals.');
}

const shape = (r: ApprovalRow) => ({
	id: r.id,
	batchId: r.batchId,
	action: r.action,
	target: r.target,
	status: r.status,
	expiresAt: r.expiresAt.toISOString()
});

// -- THE BRIDGE'S SIDE (RUNNER TOKEN OF KIND TOOL) -- //

/**
 * Files one request: one entry, or a batch of up to 20 under an id the server assigns. Every row is approved at once (decided_via auto) while the owner may still approve; when
 * the owner is gone or no longer holds manage nothing is made. A second ask for an action and target that is already open on this machine is the same row.
 */
export async function requestApprovals(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: z.input<typeof approvalRequestInput>
) {
	requireTool(auth);
	const input = approvalRequestInput.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		if (!(await ownerMayApprove(tx, auth))) throw new OpError('FORBIDDEN', OWNER_REFUSED_MESSAGE);
		await sweepApprovals(tx, auth.orgId);
		// A retry of the same ask returns what it made
		const asked = await tx
			.select()
			.from(bridgeApproval)
			.where(
				and(
					eq(bridgeApproval.runnerId, auth.runnerId),
					inArray(
						bridgeApproval.requestId,
						input.entries.map((_, i) => `${input.requestId}:${i}`)
					)
				)
			);
		if (asked.length === input.entries.length)
			return { batchId: asked[0]?.batchId ?? null, requests: asked.map(shape) };
		if (asked.length) throw new OpError('CONFLICT', 'That request id was used for another ask.');
		const normal = input.entries.map((e) => ({
			action: e.action,
			target: normaliseApprovalTarget(e.action, e.target)
		}));
		if (new Set(normal.map((e) => `${e.action}\0${e.target}`)).size !== normal.length)
			throw new OpError('INVALID', 'The same action and target is listed twice.');
		// Rows filed before agent approvals were made permanent can still be waiting: this machine's own are approved now, the same way
		const swept = await tx
			.update(bridgeApproval)
			.set({
				status: 'approved',
				decidedBy: auth.ownerId,
				decidedAt: sql`now()`,
				decidedVia: 'auto',
				expiresAt: sql`now() + make_interval(mins => ${APPROVAL_CLAIM_MINUTES})`,
				updatedAt: sql`now()`
			})
			.where(
				and(
					eq(bridgeApproval.runnerId, auth.runnerId),
					eq(bridgeApproval.status, 'pending'),
					sql`${bridgeApproval.expiresAt} > now()`
				)
			)
			.returning({ action: bridgeApproval.action, target: bridgeApproval.target });
		// The audit also covers the old waiting rows approved just now
		if (swept.length)
			await appendOrgEvent(
				tx,
				{
					handle,
					orgId: auth.orgId,
					actor: { userId: auth.ownerId as string, kind: 'agent', label: `${auth.name} (auto)` }
				},
				'approval.auto',
				{},
				{
					machine: auth.name,
					entries: swept
						.map((m) => `${m.action}:${m.target}`)
						.join('; ')
						.slice(0, 1000)
				}
			);
		// Caps: the hourly total, and an hourly cap for each kind of thing that opens something
		const recent = await tx
			.select({ action: bridgeApproval.action, n: sql<number>`count(*)::int` })
			.from(bridgeApproval)
			.where(
				and(
					eq(bridgeApproval.runnerId, auth.runnerId),
					sql`${bridgeApproval.createdAt} > now() - interval '1 hour'`
				)
			)
			.groupBy(bridgeApproval.action);
		const total = recent.reduce((a, r) => a + r.n, 0);
		if (total + normal.length > MAX_PER_HOUR)
			throw new OpError(
				'RATE_LIMITED',
				'Your agent asked for too many things in the last hour. It stopped to be safe; try again later.'
			);
		for (const kind of new Set(normal.map((e) => e.action))) {
			const have = recent.find((r) => r.action === kind)?.n ?? 0;
			const add = normal.filter((e) => e.action === kind).length;
			if (have + add > AUTO_PER_HOUR[kind])
				throw new OpError(
					'RATE_LIMITED',
					`Your agent asked for too many "${kind}" approvals in the last hour. It stopped to be safe; try again later.`
				);
		}
		// An entry that is already open on this machine is the same row: nothing new is made for it
		const open = await tx
			.select()
			.from(bridgeApproval)
			.where(
				and(
					eq(bridgeApproval.runnerId, auth.runnerId),
					inArray(bridgeApproval.status, ['pending', 'approved']),
					isNull(bridgeApproval.claimedAt),
					sql`${bridgeApproval.expiresAt} > now()`
				)
			);
		const same = (e: { action: string; target: string }) =>
			open.find((x) => x.action === e.action && x.target === e.target);
		if (normal.every((e) => same(e)))
			return { batchId: null, requests: normal.map((e) => shape(same(e)!)) };
		const batchId = normal.length > 1 ? randomUUID() : null;
		const [projectRow] = input.project
			? await tx
					.select({ id: project.id })
					.from(project)
					.where(and(eq(project.orgId, auth.orgId), eq(project.key, input.project.toUpperCase())))
			: [];
		const made: ApprovalRow[] = [];
		for (const [i, e] of normal.entries()) {
			if (same(e)) continue;
			const [row] = await tx
				.insert(bridgeApproval)
				.values({
					orgId: auth.orgId,
					projectId: projectRow?.id ?? null,
					runnerId: auth.runnerId,
					requestId: `${input.requestId}:${i}`,
					batchId,
					action: e.action,
					target: e.target,
					contentHash: hashOf(e.action, e.target, auth.runnerId),
					why: plainWhy(input.why),
					status: 'approved',
					decidedBy: auth.ownerId,
					decidedAt: sql`now()`,
					decidedVia: 'auto',
					expiresAt: sql`now() + make_interval(mins => ${APPROVAL_CLAIM_MINUTES})`,
					requestedBy: auth.ownerId
				})
				.returning();
			made.push(row);
		}
		const all = normal.map(
			(e) => made.find((m) => m.action === e.action && m.target === e.target) ?? same(e)!
		);
		// One org event for the whole batch, so the audit outlives the 30 day retention of the rows
		await appendOrgEvent(
			tx,
			{
				handle,
				orgId: auth.orgId,
				actor: { userId: auth.ownerId as string, kind: 'agent', label: `${auth.name} (auto)` }
			},
			'approval.auto',
			{},
			{
				machine: auth.name,
				entries: made
					.map((m) => `${m.action}:${m.target}`)
					.join('; ')
					.slice(0, 1000)
			}
		);
		return { batchId, requests: all.map(shape) };
	});
}

/** The state of the named requests of this machine. Nothing about another machine's rows is ever returned. */
export async function pollApprovals(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: z.input<typeof approvalIdsInput>
) {
	requireTool(auth);
	const { ids } = approvalIdsInput.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		await sweepApprovals(tx, auth.orgId);
		const rows = await tx
			.select()
			.from(bridgeApproval)
			.where(and(inArray(bridgeApproval.id, ids), eq(bridgeApproval.runnerId, auth.runnerId)));
		return { requests: rows.map(shape) };
	});
}

/** Withdraws open requests of this machine. */
export async function cancelApprovals(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: z.input<typeof approvalIdsInput>
) {
	requireTool(auth);
	const { ids } = approvalIdsInput.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const done = await tx
			.update(bridgeApproval)
			.set({ status: 'cancelled', updatedAt: sql`now()` })
			.where(
				and(
					inArray(bridgeApproval.id, ids),
					eq(bridgeApproval.runnerId, auth.runnerId),
					inArray(bridgeApproval.status, ['pending', 'approved']),
					isNull(bridgeApproval.claimedAt)
				)
			)
			.returning({ id: bridgeApproval.id });
		return { cancelled: done.length };
	});
}

/**
 * Claims approved decisions, once. One conditional update per call: an approved, unclaimed, unexpired row of this machine becomes claimed and is returned; a refused, expired,
 * claimed or foreign row is simply not in the answer. Nothing is claimable once the owner is gone or no longer holds manage (the live role is checked here too, so a
 * demoted or removed owner claims nothing from rows approved before). The bridge mints a local code only from a row returned here.
 */
export async function claimApprovals(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: z.input<typeof approvalIdsInput>
) {
	requireTool(auth);
	const { ids } = approvalIdsInput.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		if (!(await ownerMayApprove(tx, auth))) return { claimed: [] };
		const rows = await tx
			.update(bridgeApproval)
			.set({
				status: 'claimed',
				claimedAt: sql`now()`,
				claimedByRunner: auth.runnerId,
				updatedAt: sql`now()`
			})
			.where(
				and(
					inArray(bridgeApproval.id, ids),
					eq(bridgeApproval.runnerId, auth.runnerId),
					eq(bridgeApproval.status, 'approved'),
					isNull(bridgeApproval.claimedAt),
					sql`${bridgeApproval.expiresAt} > now()`
				)
			)
			.returning();
		return {
			claimed: rows.map((r) => ({
				id: r.id,
				action: r.action,
				target: r.target,
				decidedBy: auth.name,
				decidedVia: r.decidedVia ?? 'auto',
				decidedAt: (r.decidedAt ?? new Date()).toISOString(),
				// The ten minutes of the code are judged by the bridge's own clock; this is the length, not a time
				validMinutes: APPROVAL_CLAIM_MINUTES
			}))
		};
	});
}

// -- THE PERSON'S SIDE (A SIGNED-IN PERSON) -- //

/**
 * Kept for one release for the shipped flow-check skill text, which tells an agent to call approval_list first (decision 7 of AFB-20261115-1229). Agent approvals are always on,
 * so it only says so: there is no switch, no link and no history list. Everyone who can read the org may call it.
 */
export async function approvalList(ctx: Ctx) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		return { enabled: true, link: null as string | null, history: [] as never[] };
	});
}
