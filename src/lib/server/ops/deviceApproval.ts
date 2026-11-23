// AN AGENT APPROVES THE SIGN IN CODE OF ITS OWN BRIDGE (tool_connection_approve), IN PLACE OF A PERSON TYPING IT ON THE /device PAGE
// Two checks keep it from becoming a way to attach someone else's machine: the code must belong to the bridge client, and the caller must
// present the verifier whose hash the bridge sent when it asked for the code (so the code was started by the tool whose output the agent
// read, not handed to it). The permissions given are fixed here and never come from the request, and only when the caller holds them today.
// Nothing secret comes back: the bridge receives its token by polling, as in the person's flow.

// IMPORTED TYPES
import type { Capability, Ctx } from './context';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { deviceCode, org } from '../db/schema';
import { OpError, idempotent, requireCap, run } from './context';
import { connectionName } from '../../shared/orgConnection';
import { appendOrgEvent } from './settings';

// -- TYPES -- //

export const toolApprovalInput = z.object({
	userCode: z.string().min(8).max(12),
	verifier: z
		.string()
		.regex(/^[A-Za-z0-9_-]{43,128}$/, 'The verifier is the one the tool printed with its code.')
});

// -- CONSTANTS -- //

/**
 * The tools an agent may sign in through MCP: the exact client name each starts its code under, and the permissions its token is given.
 * The bridge gets no `manage` over others: a stolen bridge token can read, comment and write, and cannot change roles, delete or complete
 * (AFB-20261108-0427 ADR-1). Any other client name is refused.
 */
/** The name packages/bridge/src/device.ts sends when it starts a sign in. */
export const BRIDGE_CLIENT = 'agent-flow-board bridge';
export const APPROVAL_CLIENTS: Readonly<Record<string, readonly Capability[]>> = {
	[BRIDGE_CLIENT]: ['read', 'comment', 'write']
};
const APPROVAL_CLIENT_NAMES = Object.keys(APPROVAL_CLIENTS);
const APPROVAL_FAILURES_MAX = 10;
const APPROVAL_FAILURES_WINDOW_MS = 600_000;
/** Wrong or foreign codes counted per caller token (or session), so an agent in a loop never spends the person's own budget at /device. */
const approvalFailures = new Map<string, { n: number; since: number }>();

// -- FUNCTIONS -- //

export async function approveToolConnection(ctx: Ctx, raw: z.input<typeof toolApprovalInput>) {
	const input = toolApprovalInput.parse(raw);
	const who = ctx.actor.tokenId ?? ctx.actor.sessionId ?? ctx.actor.userId;
	// Entries older than the window are forgotten, so the map cannot grow without end
	for (const [k, v] of approvalFailures)
		if (Date.now() - v.since >= APPROVAL_FAILURES_WINDOW_MS) approvalFailures.delete(k);
	const failed = approvalFailures.get(who);
	if (
		failed &&
		Date.now() - failed.since < APPROVAL_FAILURES_WINDOW_MS &&
		failed.n >= APPROVAL_FAILURES_MAX
	)
		throw new OpError(
			'RATE_LIMITED',
			'Too many codes were refused. Wait ten minutes, then start the tool again.'
		);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			await requireCap(tx, ctx, 'write');
			// The token the tool receives has no project limit, so a token that is limited to some projects may not approve one: it would hand out more than it holds
			if (ctx.actor.tokenProjects?.length)
				throw new OpError(
					'FORBIDDEN',
					'This token is limited to some projects, so it cannot approve a tool: the tool would reach every project of the organisation. Use a token without a project limit.'
				);
			const code = input.userCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
			const challenge = createHash('sha256').update(input.verifier).digest('base64url');
			// The code this caller may approve: pending, not expired, started by a known client, and the caller holds the verifier
			const [pending] = await tx
				.select({
					id: deviceCode.id,
					client: deviceCode.client,
					requestedOrg: deviceCode.requestedOrg
				})
				.from(deviceCode)
				.where(
					and(
						eq(deviceCode.userCode, code),
						eq(deviceCode.status, 'pending'),
						inArray(deviceCode.client, APPROVAL_CLIENT_NAMES),
						eq(deviceCode.challengeHash, challenge),
						gt(deviceCode.expiresAt, sql`now()`)
					)
				);
			// The tool asked for one organisation (login --org): an agent on another organisation's connection must not approve it, or the sign in would land in the wrong org
			if (pending?.requestedOrg) {
				const [mine] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, ctx.orgId));
				if (mine?.slug !== pending.requestedOrg) {
					const now = Date.now();
					approvalFailures.set(
						who,
						failed && now - failed.since < APPROVAL_FAILURES_WINDOW_MS
							? { n: failed.n + 1, since: failed.since }
							: { n: 1, since: now }
					);
					throw new OpError(
						'FORBIDDEN',
						`This code was started for another organisation. Approve it with the ${connectionName(pending.requestedOrg)} connection, not the one you used.`
					);
				}
			}
			// Approving the sign in of the bridge itself needs manage
			if (pending) await requireCap(tx, ctx, 'manage');
			const scopes = pending ? APPROVAL_CLIENTS[pending.client] : undefined;
			// The token is never given more than the caller holds today in the role and in the caller's own token
			if (scopes) for (const scope of scopes) await requireCap(tx, ctx, scope);
			// One conditional update decides it: still pending, so two callers can never both approve the same code
			const approved =
				pending && scopes
					? await tx
							.update(deviceCode)
							.set({
								status: 'approved',
								approvedBy: ctx.actor.userId,
								approvedOrgId: ctx.orgId,
								scopes: [...scopes]
							})
							.where(and(eq(deviceCode.id, pending.id), eq(deviceCode.status, 'pending')))
							.returning({ id: deviceCode.id })
					: [];
			if (approved.length === 0) {
				// A retry of an approval that already went through (a timeout on the way back, no request id) is the same answer, not a refusal and not a failure to count
				const [again] = await tx
					.select({ id: deviceCode.id, client: deviceCode.client })
					.from(deviceCode)
					.where(
						and(
							eq(deviceCode.userCode, code),
							inArray(deviceCode.client, APPROVAL_CLIENT_NAMES),
							eq(deviceCode.challengeHash, challenge),
							inArray(deviceCode.status, ['approved', 'issued']),
							eq(deviceCode.approvedBy, ctx.actor.userId),
							eq(deviceCode.approvedOrgId, ctx.orgId)
						)
					);
				if (again) return { ok: true as const, client: again.client };
				const now = Date.now();
				approvalFailures.set(
					who,
					failed && now - failed.since < APPROVAL_FAILURES_WINDOW_MS
						? { n: failed.n + 1, since: failed.since }
						: { n: 1, since: now }
				);
				throw new OpError(
					'INVALID',
					'That code is not valid, has expired, was already used, or was not started by the tool that printed this verifier.'
				);
			}
			await appendOrgEvent(
				tx,
				ctx,
				'runner.approve',
				{},
				{ client: pending?.client ?? '', by: ctx.actor.kind }
			);
			return { ok: true as const, client: pending?.client ?? '' };
		})
	);
}
