// BRIDGE APPROVALS THE AGENT HANDLES ON ITS OWN (AFB-20261108-2349), BUILT ON THE REQUEST/CLAIM PATH OF AFB-20261108-1444
// An agent that runs the bridge files a request over the tool's own runner token. A person can turn on "let my agent handle approvals on its own" for themselves: then a request from a
// machine that person owns is approved the moment it is filed. Nobody clicks. The safety that stays: only a signed-in person with manage turns the switch on (never a token, an MCP
// session or an agent), a decision is single use (one action, one server-normalised target, one machine, ten minutes), and the claim is one conditional update by the asking machine.
// The agent's own words (`why`) are untrusted plain text.

// -- TYPES -- //
import type { Ctx } from './context';
import type { DbHandle, Tx } from '../db/client';
import type { RunnerAuth } from './environments';
// -- DEP-MODULES -- //
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { APPROVAL_ACTIONS, bridgeApproval, org, project, runner } from '../db/schema';
import { withTenant } from '../db/tenant';
import { OpError, capsOf, orgRoleOf, requireCap, run } from './context';
import { appendOrgEvent } from './settings';

// -- TYPES -- //

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export type ApprovalRow = typeof bridgeApproval.$inferSelect;

// -- CONSTANTS -- //

/** After a request is approved the bridge has this long to claim, the same ten minutes a terminal code lives. */
export const APPROVAL_CLAIM_MINUTES = 10;
/** Requests that nobody decided wait this long (only rows filed while the switch was off can be left like this). */
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
export const SWITCH_OFF_MESSAGE =
	'Your agent is not allowed to approve on its own yet. Turn on "Let my agent handle approvals on its own" under Settings, Agent access.';

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

/** Only a signed-in person at the board changes the switch: not a token, not an MCP session, not an agent. */
function requireWebPerson(ctx: Ctx) {
	const a = ctx.actor;
	if (a.kind !== 'person' || a.tokenId || a.sessionId || a.tokenCaps || a.tool)
		throw new OpError('FORBIDDEN', 'Only a person signed in at the board can change this.');
}

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
 * Whether the person who owns this machine has turned the switch on. The owner must still exist, still be a member and still hold manage today; a machine with no owner
 * (the person was deleted) never auto-approves.
 */
async function ownerAuto(tx: Tx, auth: RunnerAuth): Promise<boolean> {
	if (!auth.ownerId) return false;
	const [o] = await tx.select({ settings: org.settings }).from(org).where(eq(org.id, auth.orgId));
	if (!o?.settings?.autoApproveBy?.[auth.ownerId]) return false;
	const role = await orgRoleOf(tx, auth.orgId, auth.ownerId);
	return capsOf(role).includes('manage');
}

/** Only the tool's own runner token reaches the approvals: never a run key, a local or a hosted runner. */
function requireTool(auth: RunnerAuth): void {
	if (auth.kind !== 'tool')
		throw new OpError('FORBIDDEN', 'Only the checks tool of a person can ask for approvals.');
}

/** The page where the person turns the switch on, for the agent to relay when it is off. */
async function approvalLink(
	tx: Tx,
	orgId: string,
	baseUrl: string | undefined,
	projectKey: string | undefined
): Promise<string | null> {
	const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, orgId));
	let key = projectKey;
	if (key) {
		const [p] = await tx
			.select({ key: project.key })
			.from(project)
			.where(and(eq(project.orgId, orgId), eq(project.key, key.toUpperCase())));
		key = p?.key;
	}
	if (!key) {
		const [p] = await tx
			.select({ key: project.key })
			.from(project)
			.where(eq(project.orgId, orgId))
			.orderBy(asc(project.key))
			.limit(1);
		key = p?.key;
	}
	if (!o || !key) return null;
	return `${(baseUrl ?? '').replace(/\/$/, '')}/${o.slug}/${key}/settings?tab=agent-access`;
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
 * Files one request: one entry, or a batch of up to 20 under an id the server assigns. With the owner's switch on every row is approved at once (decided_via auto); with it
 * off nothing is made and the answer says where to turn it on. A second ask for an action and target that is already open on this machine is the same row.
 */
export async function requestApprovals(
	handle: DbHandle,
	auth: RunnerAuth,
	baseUrl: string | undefined,
	raw: z.input<typeof approvalRequestInput>
) {
	requireTool(auth);
	const input = approvalRequestInput.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		if (!(await ownerAuto(tx, auth))) throw new OpError('FORBIDDEN', SWITCH_OFF_MESSAGE);
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
		const link = await approvalLink(tx, auth.orgId, baseUrl, input.project);
		if (asked.length === input.entries.length)
			return { batchId: asked[0]?.batchId ?? null, requests: asked.map(shape), link };
		if (asked.length) throw new OpError('CONFLICT', 'That request id was used for another ask.');
		const normal = input.entries.map((e) => ({
			action: e.action,
			target: normaliseApprovalTarget(e.action, e.target)
		}));
		if (new Set(normal.map((e) => `${e.action}\0${e.target}`)).size !== normal.length)
			throw new OpError('INVALID', 'The same action and target is listed twice.');
		// Rows filed while the switch was off can still be waiting: this machine's own are approved now, the same way
		await tx
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
			return { batchId: null, requests: normal.map((e) => shape(same(e)!)), link };
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
		return { batchId, requests: all.map(shape), link };
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
 * claimed or foreign row is simply not in the answer. An auto row is claimable only while its owner's switch is still on. The bridge mints a local code only from a row returned here.
 */
export async function claimApprovals(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: z.input<typeof approvalIdsInput>
) {
	requireTool(auth);
	const { ids } = approvalIdsInput.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
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
					sql`${bridgeApproval.expiresAt} > now()`,
					sql`(${bridgeApproval.decidedVia} is distinct from 'auto' or jsonb_exists((select settings->'autoApproveBy' from org where id = ${auth.orgId}), ${auth.ownerId ?? ''}))`
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
 * The person's own switch and what their agents did on their own (the last 20, from the machines this person owns). Everyone who can read the org sees whether their own switch
 * is on; only a person with manage sees the list, and never another person's.
 */
export async function approvalList(ctx: Ctx) {
	return run(ctx, async (tx) => {
		const { caps } = await requireCap(tx, ctx, 'read');
		const canManage = caps.includes('manage');
		await sweepApprovals(tx, ctx.orgId);
		const [o] = await tx.select({ settings: org.settings }).from(org).where(eq(org.id, ctx.orgId));
		const mine = o?.settings?.autoApproveBy?.[ctx.actor.userId];
		const rows = canManage
			? await tx
					.select({ row: getTableColumns(bridgeApproval), machine: runner.name })
					.from(bridgeApproval)
					.innerJoin(runner, eq(runner.id, bridgeApproval.runnerId))
					.where(
						and(
							eq(bridgeApproval.orgId, ctx.orgId),
							eq(bridgeApproval.decidedVia, 'auto'),
							eq(runner.ownerId, ctx.actor.userId)
						)
					)
					.orderBy(desc(bridgeApproval.createdAt))
					.limit(20)
			: [];
		return {
			canManage,
			enabled: Boolean(mine),
			since: mine?.at ?? null,
			link: await approvalLink(tx, ctx.orgId, ctx.services?.baseUrl, undefined),
			history: rows.map((x) => ({
				id: x.row.id,
				action: x.row.action,
				target: x.row.target,
				status: x.row.status,
				at: x.row.createdAt.toISOString(),
				machine: x.machine
			}))
		};
	});
}

/**
 * The person's own switch. A signed-in person with manage only: no token, no MCP session and no agent can turn it on, because that would let an injected agent grant itself
 * everything. It changes only the caller's own key, in one statement, so another person's switch and a limits save are never overwritten. Turning it off also withdraws
 * this person's approved rows that were not claimed yet.
 */
export async function setAutoApprove(ctx: Ctx, on: boolean) {
	requireWebPerson(ctx);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const uid = ctx.actor.userId;
		const at = new Date().toISOString();
		const [before] = await tx
			.select({ settings: org.settings })
			.from(org)
			.where(eq(org.id, ctx.orgId));
		const was = Boolean(before?.settings?.autoApproveBy?.[uid]);
		await tx
			.update(org)
			.set({
				settings: on
					? sql`jsonb_set(coalesce(${org.settings}, '{}'::jsonb), '{autoApproveBy}', coalesce(${org.settings}->'autoApproveBy', '{}'::jsonb) || jsonb_build_object(${uid}::text, jsonb_build_object('at', ${at}::text)), true)`
					: sql`jsonb_set(coalesce(${org.settings}, '{}'::jsonb), '{autoApproveBy}', coalesce(${org.settings}->'autoApproveBy', '{}'::jsonb) - ${uid}::text, true)`,
				updatedAt: sql`now()`,
				version: sql`${org.version} + 1`
			})
			.where(eq(org.id, ctx.orgId));
		let withdrawn = 0;
		if (!on) {
			const gone = await tx
				.update(bridgeApproval)
				.set({ status: 'cancelled', updatedAt: sql`now()` })
				.where(
					and(
						eq(bridgeApproval.orgId, ctx.orgId),
						eq(bridgeApproval.decidedVia, 'auto'),
						inArray(bridgeApproval.status, ['approved']),
						isNull(bridgeApproval.claimedAt),
						sql`${bridgeApproval.runnerId} in (select id from runner where owner_id = ${uid})`
					)
				)
				.returning({ id: bridgeApproval.id });
			withdrawn = gone.length;
		}
		if (was !== on) await appendOrgEvent(tx, ctx, 'approval.auto', { on: was }, { on, withdrawn });
		return { enabled: on, changed: was !== on };
	});
}
