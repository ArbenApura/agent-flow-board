// THE OPERATIONS CONTEXT: WHO IS ACTING, WHAT THEIR LIVE ROLE ALLOWS, RATE LIMITS AND RETRY SAFETY (SPEC 4, 6 AND 7)
// Every verb of the operations layer takes a Ctx and checks the caller's CURRENT role inside its own transaction (L8).

// IMPORTED TYPES
import type { DbHandle, Tx } from '../db/client';
import type { Role } from '../orgs/roles';
import type { Storage } from '../adapters/storage';
import type { Mailer } from '../email/mailer';
import type { JobRunner } from '../adapters/jobs';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { member, org, project, projectCols, projectMember, requestLog } from '../db/schema';
import { withTenant } from '../db/tenant';
import { effectiveProjectRole } from '../orgs/roles';

// -- TYPES -- //

export type Capability = 'read' | 'comment' | 'write' | 'complete' | 'delete' | 'manage';

export type Actor = {
	userId: string;
	/** A person at the web app, or an agent through a token or session. Some rules differ (ADR-027). */
	kind: 'person' | 'agent';
	/** The tool name an agent connected with, for the activity log and the session title. */
	tool?: string;
	tokenId?: string;
	sessionId?: string;
	/** What the event log shows as the actor. */
	label?: string;
	/** A token's stored permissions are only an upper limit. Missing means no limit (a signed in person). */
	tokenCaps?: Capability[];
	/** The projects a token is limited to. Missing or empty means every project the user can reach. */
	tokenProjects?: string[];
};

export type Ctx = {
	handle: DbHandle;
	/**
	 * The one open tenant transaction of a whole call (an MCP tool call). When set, `run` joins it instead of opening
	 * another, so the token check, the session check, the verb and the reminders share one round of setup. Each verb still
	 * reads the caller's live role itself, inside this transaction.
	 */
	tx?: Tx;
	actor: Actor;
	orgId: string;
	/** Set by verbs that work inside one project. */
	projectId?: string;
	/** Repeating a call with the same id returns the stored result and writes nothing twice. */
	requestId?: string;
	/** What the request was (the verb and a hash of its input), so a reused id on another request is refused, not answered with the first one. */
	fingerprint?: string;
	/** Outside services a verb may need: file storage and the public address for links. */
	services?: {
		storage?: Storage;
		baseUrl?: string;
		mailer?: Mailer;
		jobs?: JobRunner;
		/** True when nightly backups are set up on this server, so a missing backup is a problem worth showing. */
		backups?: boolean;
		/** Wraps the org data keys that seal project secrets (ADR-024). Missing means secrets are off. */
		masterKey?: string;
		/** Minutes a run waits for a runner before it is reported stuck. */
		runnerQueueMinutes?: number;
		/** Secret used for HKDF-derived mockup file URL signing (BETTER_AUTH_SECRET in appServices). */
		mockupSecret?: string;
		/** Optional isolated second origin (MOCKUP_ORIGIN) for hosted mockup URLs. */
		mockupOrigin?: string;
	};
};

export type OpErrorCode =
	| 'FORBIDDEN'
	| 'NOT_FOUND'
	| 'INVALID'
	| 'STALE_VERSION'
	| 'RATE_LIMITED'
	| 'CONFLICT'
	| 'COMPLETED_REFUSED'
	| 'MOCKUP_UNREAD'
	| 'VISUAL_EVIDENCE_REQUIRED'
	| 'MISSING_PICTURE_PAIR'
	| 'CONFIRM_REQUIRED'
	| 'ORG_LOCKED';

export class OpError extends Error {
	constructor(
		readonly code: OpErrorCode,
		message: string,
		readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'OpError';
	}
}

// -- CONSTANTS -- //

const ROLE_CAPS: Record<Role, Capability[]> = {
	guest: ['read', 'comment'],
	viewer: ['read', 'comment'],
	member: ['read', 'comment', 'write', 'complete', 'delete'],
	admin: ['read', 'comment', 'write', 'complete', 'delete', 'manage'],
	owner: ['read', 'comment', 'write', 'complete', 'delete', 'manage']
};

export const ALL_CAPS: Capability[] = ['read', 'comment', 'write', 'complete', 'delete', 'manage'];

// -- FUNCTIONS -- //

/** True only for a person acting through a live web session (never an agent or any API/MCP token). */
export function isLivePersonSession(ctx: Pick<Ctx, 'actor'>): boolean {
	return (
		ctx.actor.kind === 'person' &&
		!ctx.actor.tokenId &&
		!ctx.actor.tokenCaps &&
		!ctx.actor.tokenProjects?.length
	);
}

/** What a role may do, before any token limit. */
export const capsOf = (role: Role | null): Capability[] => (role ? ROLE_CAPS[role] : []);

/** False when the caller holds a token limited to other projects. The answer is the same as for a project that does not exist. */
export const projectAllowed = (actor: Actor, projectId: string): boolean =>
	!actor.tokenProjects?.length || actor.tokenProjects.includes(projectId);

/**
 * What this caller may do right now: the role's capabilities intersected with the token's stored permissions (L8).
 * A token never grants more than its user holds today, so demoting the user takes effect on the next call.
 */
export function effectiveCaps(role: Role | null, actor: Actor): Capability[] {
	const roleCaps = capsOf(role);
	return actor.tokenCaps ? roleCaps.filter((c) => actor.tokenCaps!.includes(c)) : roleCaps;
}

export const ORG_LOCKED_MESSAGE =
	'This organisation is scheduled for deletion. Its owner can restore it until it is erased.';

// -- PER TRANSACTION MEMO -- //
// A verb and the helpers it calls ask the same live questions (is the org live, what is this person's role) several times
// inside one transaction. The answers are kept for the life of that transaction only, so they are always as fresh as the
// transaction itself and a role change still takes effect on the next call.

const liveOrgs = new WeakMap<Tx, Set<string>>();
const memberRoles = new WeakMap<Tx, Map<string, Role | null>>();
const projectRoles = new WeakMap<Tx, Map<string, Role | null>>();

const memoOf = <V>(store: WeakMap<Tx, Map<string, V>>, tx: Tx): Map<string, V> => {
	let m = store.get(tx);
	if (!m) store.set(tx, (m = new Map()));
	return m;
};

/** Refuses any work in an org that an owner has deleted. Only the restore and summary verbs read such an org. */
export async function assertOrgLive(tx: Tx, orgId: string): Promise<void> {
	let seen = liveOrgs.get(tx);
	if (seen?.has(orgId)) return;
	const [o] = await tx.select({ deletedAt: org.deletedAt }).from(org).where(eq(org.id, orgId));
	if (o?.deletedAt) throw new OpError('ORG_LOCKED', ORG_LOCKED_MESSAGE);
	if (!seen) liveOrgs.set(tx, (seen = new Set()));
	seen.add(orgId);
}

/** A person's role in the org, read once per transaction. Null when they are not a member. */
export async function orgRoleOf(tx: Tx, orgId: string, userId: string): Promise<Role | null> {
	const memo = memoOf(memberRoles, tx);
	const key = `${orgId}:${userId}`;
	if (memo.has(key)) return memo.get(key)!;
	const [m] = await tx
		.select({ role: member.role })
		.from(member)
		.where(and(eq(member.orgId, orgId), eq(member.userId, userId)));
	const role = m?.role ?? null;
	// Only a found role is kept, so a membership added in this transaction is still seen
	if (role) memo.set(key, role);
	return role;
}

/** A person's own role on one project (null when they have none there), read once per transaction. */
export async function projectRoleOf(
	tx: Tx,
	projectId: string,
	userId: string
): Promise<Role | null> {
	const memo = memoOf(projectRoles, tx);
	const key = `${projectId}:${userId}`;
	if (memo.has(key)) return memo.get(key)!;
	const [o] = await tx
		.select({ role: projectMember.role })
		.from(projectMember)
		.where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, userId)));
	const role = o?.role ?? null;
	// No override is an answer too: most people have none, and it would be asked again for every item
	memo.set(key, role);
	return role;
}

/**
 * Reads the caller's live role in this org (and project, when given) inside the open transaction, and refuses the
 * call unless it holds the capability. Returns the role for the verb to use.
 */
export async function requireCap(
	tx: Tx,
	ctx: Ctx,
	cap: Capability,
	projectId?: string
): Promise<{ role: Role; caps: Capability[] }> {
	await assertOrgLive(tx, ctx.orgId);
	const orgRole = await orgRoleOf(tx, ctx.orgId, ctx.actor.userId);
	if (!orgRole) throw new OpError('FORBIDDEN', 'You are not a member of this organisation.');
	let role: Role | null = orgRole;
	if (projectId) {
		if (!projectAllowed(ctx.actor, projectId))
			throw new OpError('NOT_FOUND', 'That project does not exist.');
		role = effectiveProjectRole(orgRole, await projectRoleOf(tx, projectId, ctx.actor.userId));
		if (!role) throw new OpError('NOT_FOUND', 'That project does not exist.');
	}
	const caps = effectiveCaps(role, ctx.actor);
	if (!caps.includes(cap)) {
		throw new OpError('FORBIDDEN', `Your role or token does not allow this (needs "${cap}").`, {
			needed: cap,
			role
		});
	}
	return { role: role!, caps };
}

/** Refuses a person who is not a member of this org, so an assignee can only be someone who belongs here. */
export async function requireOrgMember(tx: Tx, ctx: Ctx, userId: string | null | undefined) {
	if (!userId) return;
	const [m] = await tx
		.select({ id: member.userId })
		.from(member)
		.where(and(eq(member.orgId, ctx.orgId), eq(member.userId, userId)));
	if (!m) throw new OpError('INVALID', 'That person is not a member of this organisation.');
}

/** The project row of this org, or NOT_FOUND (the same answer for another org's project). */
export async function projectOf(tx: Tx, ctx: Ctx, projectId: string) {
	const [p] = await tx
		.select(projectCols)
		.from(project)
		.where(and(eq(project.id, projectId), eq(project.orgId, ctx.orgId)));
	if (!p) throw new OpError('NOT_FOUND', 'That project does not exist.');
	return p;
}

/** The tenant for a verb: this org, this project when set, and the acting person. */
export const tenantOf = (ctx: Ctx, projectId?: string) => ({
	orgId: ctx.orgId,
	projectId: projectId ?? ctx.projectId,
	userId: ctx.actor.userId
});

/** What each open call transaction was set up for, so a verb only joins it when it is the same org, person and project. */
const ambient = new WeakMap<Tx, { orgId: string; userId: string; projectId: string }>();

/**
 * Runs a whole call (an MCP tool call) in one tenant transaction. Every verb that runs with the returned context joins
 * it, so a call pays for one transaction setup, one org check and one role lookup instead of one per step. An error
 * anywhere rolls the whole call back.
 */
export function runCall<T>(ctx: Ctx, fn: (callCtx: Ctx) => Promise<T>): Promise<T> {
	return withTenant(ctx.handle, tenantOf(ctx), async (tx) => {
		ambient.set(tx, {
			orgId: ctx.orgId,
			userId: ctx.actor.userId,
			projectId: ctx.projectId ?? ''
		});
		await assertOrgLive(tx, ctx.orgId);
		return fn({ ...ctx, tx });
	});
}

/** Runs a verb in one transaction inside the caller's tenant, or in the open call transaction when the context carries one. */
export function run<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>, projectId?: string): Promise<T> {
	const joined = ctx.tx && ambient.get(ctx.tx);
	if (
		ctx.tx &&
		joined &&
		joined.orgId === ctx.orgId &&
		joined.userId === ctx.actor.userId &&
		joined.projectId === (projectId ?? ctx.projectId ?? '')
	) {
		const tx = ctx.tx;
		return assertOrgLive(tx, ctx.orgId).then(() => fn(tx));
	}
	return withTenant(ctx.handle, tenantOf(ctx, projectId), async (tx) => {
		await assertOrgLive(tx, ctx.orgId);
		return fn(tx);
	});
}

// -- RATE LIMITS (L9) -- //

export const LIMITS: Record<'write' | 'create' | 'sync', { max: number; windowSeconds: number }> = {
	/** Live editing calls per person per minute, in a bucket of their own so typing never uses up the write limit (PROPOSED). */
	sync: { max: 600, windowSeconds: 60 },
	/** Writes per actor per minute. */
	write: { max: 240, windowSeconds: 60 },
	/** New items per actor per hour, so a runaway agent cannot flood a project. */
	create: { max: 120, windowSeconds: 3600 }
};

/**
 * Counts one call against a limit for this actor and refuses the call when the window is full. The counter row is
 * locked by the upsert, so concurrent calls count correctly.
 */
export async function rateLimit(tx: Tx, ctx: Ctx, kind: keyof typeof LIMITS): Promise<void> {
	const { max, windowSeconds } = LIMITS[kind];
	const actor = `${ctx.actor.tokenId ?? ctx.actor.userId}:${kind}`;
	const res = await tx.execute(sql`
		insert into rate_bucket (org_id, actor, window_start, count)
		values (${ctx.orgId}, ${actor}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
		on conflict (org_id, actor, window_start) do update set count = rate_bucket.count + 1
		returning count`);
	const count = Number((res as unknown as { rows: { count: number }[] }).rows[0].count);
	if (count > max)
		throw new OpError('RATE_LIMITED', `Too many ${kind} calls. Wait a moment and try again.`, {
			limit: max,
			windowSeconds
		});
}

// -- IDEMPOTENCY (L-RETRY) -- //

/** A short hash of what a request asked for, with object keys in a fixed order. */
export function fingerprintOf(verb: string, ...parts: unknown[]): string {
	const canon = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(canon)
			: v && typeof v === 'object'
				? Object.fromEntries(
						Object.entries(v as Record<string, unknown>)
							.sort(([a], [b]) => (a < b ? -1 : 1))
							.map(([k, x]) => [k, canon(x)])
					)
				: v;
	return `${verb}:${createHash('sha256')
		.update(JSON.stringify(canon(parts)))
		.digest('hex')
		.slice(0, 32)}`;
}

/**
 * The context for one write inside a call that makes several writes (item_update saves fields, sections and decisions).
 * Each write gets its own request id and fingerprint, so a second write is never answered with the first one's stored
 * result, and a retry of the whole call replays every write on its own. Without a request id nothing changes.
 */
export function subRequest(ctx: Ctx, label: string, ...parts: unknown[]): Ctx {
	if (!ctx.requestId) return ctx;
	return {
		...ctx,
		requestId: `${ctx.requestId}#${label}`,
		fingerprint: fingerprintOf(label, ...parts)
	};
}

/**
 * Makes a write safe to retry. The first call with a requestId runs and stores its result; a repeat returns that
 * stored result and writes nothing. The unique row is the lock, so two simultaneous retries cannot both run.
 */
export async function idempotent<T>(ctx: Ctx, tx: Tx, fn: () => Promise<T>): Promise<T> {
	if (!ctx.requestId) return fn();
	const actor = ctx.actor.tokenId ?? ctx.actor.sessionId ?? ctx.actor.userId;
	const inserted = await tx
		.insert(requestLog)
		.values({ orgId: ctx.orgId, actor, requestId: ctx.requestId, result: {} })
		.onConflictDoNothing()
		.returning({ id: requestLog.id });
	if (inserted.length === 0) {
		const [row] = await tx
			.select({ result: requestLog.result })
			.from(requestLog)
			.where(
				and(
					eq(requestLog.orgId, ctx.orgId),
					eq(requestLog.actor, actor),
					eq(requestLog.requestId, ctx.requestId)
				)
			);
		const stored = row.result as { fp?: string; value?: T };
		if (ctx.fingerprint && stored.fp && stored.fp !== ctx.fingerprint)
			throw new OpError('CONFLICT', 'That request id was already used for a different request.');
		return ('fp' in stored ? stored.value : row.result) as T;
	}
	const result = await fn();
	await tx
		.update(requestLog)
		.set({ result: { fp: ctx.fingerprint ?? null, value: result } as never })
		.where(eq(requestLog.id, inserted[0].id));
	return result;
}

/** A thrown marker that rolls a transaction back after a dry run and carries the preview out. */
export class DryRun<T> extends Error {
	constructor(readonly result: T) {
		super('dry run');
	}
}

/** Runs the body, and when `dryRun` is set rolls everything back and returns what would have happened. */
export async function maybeDry<T>(
	dryRun: boolean | undefined,
	ctx: Ctx,
	fn: (tx: Tx) => Promise<T>,
	projectId?: string
): Promise<T & { dryRun?: boolean }> {
	if (!dryRun) return (await run(ctx, fn, projectId)) as T & { dryRun?: boolean };
	try {
		await run(
			ctx,
			async (tx) => {
				// Inside a call transaction a savepoint rolls back only this dry run, not the whole call
				if (ctx.tx === tx)
					return tx.transaction(async (sp) => {
						throw new DryRun(await fn(sp as unknown as Tx));
					});
				throw new DryRun(await fn(tx));
			},
			projectId
		);
	} catch (e) {
		if (e instanceof DryRun)
			return { ...(e.result as object), dryRun: true } as T & { dryRun: boolean };
		throw e;
	}
	throw new Error('unreachable');
}
