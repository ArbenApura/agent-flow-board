// BROWSER CHECKS: DEFINITIONS, THE RUN QUEUE, TARGET CHOICE AND WHAT A RESULT DOES TO THE PLAN (SPEC 10, ADR-017)
// A check belongs to one manual check (M8) of an item. A run is asked for, queued, taken by a runner and finished with a result.
// A pass on the required target (or a stronger one) closes the check's manual check and the step it was started for. A pass on a
// weaker target is recorded and ticks nothing (L25). A later fail on the same target reopens what the pass had closed (L29).

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { DbHandle } from '../db/client';
import type { Ctx } from './context';
import type { RunnerAuth } from './environments';
// -- DEP-MODULES -- //
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { findSecret, maskSecrets, type Needle } from '../../shared/scan';
import { appendEvent } from '../db/events';
import {
	check,
	checkRun,
	environment,
	item,
	manualCheck,
	project,
	runner,
	secret,
	step,
	uiShotRun,
	userPref
} from '../db/schema';
import { TARGETS } from '../db/schema/helpers';
import { withTenant } from '../db/tenant';
import { OpError, requireCap, run } from './context';
import { RUNNER_ONLINE_SECONDS, openProjectAccounts } from './environments';
import { actorFields, canSeeItem } from './items';
import { findItem } from './resolve';
import { recordSteps } from './steps';
import { addAttachment } from './attachments';

// -- TYPES -- //

export type Target = (typeof TARGETS)[number];
export type TargetStatus = {
	target: Target;
	available: boolean;
	environment: string | null;
	reason: string | null;
};

// -- CONSTANTS -- //

export const TARGET_RANK: Record<Target, number> = { dev: 1, preview: 2, deployed: 3 };
export const DEFAULT_QUEUE_MINUTES = 10;
/** A run that was taken and never reported back for this long is reported as stuck. */
export const RUNNING_TIMEOUT_MINUTES = 30;
const LOG_KEEP = 20_000;

export const checkInput = z.object({
	item: z.string().min(1),
	/** The manual check this closes, such as M8. */
	key: z.string().regex(/^M[0-9]+$/, 'Use the manual check key, for example M8'),
	script: z.string().min(1).max(100_000),
	coveredPaths: z.array(z.string().min(1).max(200)).max(50).default([]),
	requiredTarget: z.enum(TARGETS).default('preview'),
	pinnedTarget: z.enum(TARGETS).nullish()
});

export const requestRunInput = z.object({
	item: z.string().min(1),
	key: z.string().regex(/^M[0-9]+$/),
	/** Names a target for this run only. */
	target: z.enum(TARGETS).optional(),
	/** Names one environment of that target when the project has more than one. */
	environment: z.string().max(40).optional(),
	/** The plan step to close when the run passes on its required target. */
	step: z.string().max(20).optional()
});

export const runReport = z.object({
	result: z.enum(['pass', 'fail', 'error']),
	durationMs: z
		.number()
		.int()
		.min(0)
		.max(24 * 3600 * 1000)
		.optional(),
	url: z.string().max(300).optional(),
	commit: z.string().max(80).nullish(),
	diffHash: z.string().max(80).nullish(),
	reason: z.string().max(2000).optional(),
	log: z.string().max(400_000).optional(),
	/** The run passed only on a retry, so it is flagged as flaky. */
	retried: z.boolean().optional(),
	/** Nothing proved the code under test was this tree (a server that was already running, a site that names no version). */
	unverified: z.boolean().optional(),
	evidence: z.array(z.string().uuid()).max(30).default([])
});

// -- FUNCTIONS: HELPERS -- //

/** True for an address only a machine on the same network can reach. A hosted runner cannot use one. */
export function isPrivateUrl(raw: string): boolean {
	let host: string;
	try {
		host = new URL(raw).hostname.toLowerCase();
	} catch {
		return true;
	}
	if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.local'))
		return true;
	if (host.endsWith('.internal') || host.endsWith('.localhost') || !host.includes('.')) return true;
	if (host === '0.0.0.0' || host.startsWith('[')) return true;
	const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

const queueMinutes = (ctx: Ctx) => ctx.services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES;

/**
 * Which targets can take a run right now: the project has an environment of that kind and a runner that is online, serves the
 * project, and can reach the environment's address. A reason is given for each target that cannot.
 */
export async function targetStatuses(
	tx: Tx,
	orgId: string,
	projectId: string
): Promise<TargetStatus[]> {
	const envs = await tx.select().from(environment).where(eq(environment.projectId, projectId));
	const runners = await tx
		.select()
		.from(runner)
		.where(
			and(
				eq(runner.orgId, orgId),
				sql`${projectId}::uuid = any(${runner.projectIds})`,
				sql`${runner.lastSeenAt} > now() - make_interval(secs => ${RUNNER_ONLINE_SECONDS})`
			)
		);
	return TARGETS.map((target) => {
		const candidates = envs.filter((e) => e.kind === target);
		if (!candidates.length)
			return {
				target,
				available: false,
				environment: null,
				reason: `This project has no ${target} environment yet.`
			};
		if (!runners.length)
			return {
				target,
				available: false,
				environment: candidates[0].name,
				reason: 'No runner that serves this project is online.'
			};
		const reachable = candidates.find((e) =>
			runners.some((r) => r.kind === 'local' || !isPrivateUrl(e.url))
		);
		if (!reachable)
			return {
				target,
				available: false,
				environment: candidates[0].name,
				reason:
					'Only a hosted runner is online, and this environment is on a private address. Start a local runner.'
			};
		return { target, available: true, environment: reachable.name, reason: null };
	});
}

/** Reports runs that waited for a runner too long, and runs a runner took and never finished. */
export async function sweepRuns(tx: Tx, orgId: string, minutes: number): Promise<number> {
	const queued = await tx
		.update(checkRun)
		.set({
			result: 'timeout',
			finishedAt: sql`now()`,
			reason: `No runner took this run within ${minutes} minutes. Check that a runner that serves this project is online, then ask again, or pick another target.`
		})
		.where(
			and(
				eq(checkRun.orgId, orgId),
				eq(checkRun.result, 'queued'),
				sql`${checkRun.createdAt} < now() - make_interval(mins => ${minutes})`
			)
		)
		.returning({ id: checkRun.id });
	const stuck = await tx
		.update(checkRun)
		.set({
			result: 'timeout',
			finishedAt: sql`now()`,
			reason: `The runner took this run and did not report back within ${RUNNING_TIMEOUT_MINUTES} minutes.`
		})
		.where(
			and(
				eq(checkRun.orgId, orgId),
				eq(checkRun.result, 'running'),
				sql`${checkRun.startedAt} < now() - make_interval(mins => ${RUNNING_TIMEOUT_MINUTES})`
			)
		)
		.returning({ id: checkRun.id });
	return queued.length + stuck.length;
}

// -- FUNCTIONS: CHECKS -- //

/** Adds or replaces the browser check of one manual check. */
export async function saveCheck(ctx: Ctx, raw: z.input<typeof checkInput>) {
	const input = checkInput.parse(raw);
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, input.item);
		await requireCap(tx, ctx, 'write', it.projectId);
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		if (!p.webApp)
			throw new OpError(
				'INVALID',
				'Browser checks are for web app projects. Turn on the web app switch in the project settings.'
			);
		const [mc] = await tx
			.select()
			.from(manualCheck)
			.where(and(eq(manualCheck.itemId, it.id), eq(manualCheck.key, input.key)));
		if (!mc) throw new OpError('NOT_FOUND', `${it.ref} has no manual check ${input.key}.`);
		const values = {
			script: input.script,
			coveredPaths: input.coveredPaths,
			requiredTarget: input.requiredTarget,
			pinnedTarget: input.pinnedTarget ?? null
		};
		const [existing] = await tx
			.select({ id: check.id })
			.from(check)
			.where(and(eq(check.itemId, it.id), eq(check.manualKey, input.key)));
		let id: string;
		if (existing) {
			await tx
				.update(check)
				.set({ ...values, updatedAt: sql`now()`, version: sql`${check.version} + 1` })
				.where(eq(check.id, existing.id));
			id = existing.id;
		} else {
			const [row] = await tx
				.insert(check)
				.values({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					manualKey: input.key,
					...values
				})
				.returning({ id: check.id });
			id = row.id;
		}
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: it.projectId,
			itemId: it.id,
			...actorFields(ctx),
			verb: 'check.save',
			targetType: 'check',
			targetId: id,
			after: {
				key: input.key,
				requiredTarget: input.requiredTarget,
				pinnedTarget: values.pinnedTarget
			} as never,
			undoable: false
		});
		return { id, created: !existing };
	});
}

export async function deleteCheck(ctx: Ctx, itemName: string, key: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemName);
		await requireCap(tx, ctx, 'write', it.projectId);
		const gone = await tx
			.delete(check)
			.where(and(eq(check.itemId, it.id), eq(check.manualKey, key)))
			.returning({ id: check.id });
		if (!gone.length) throw new OpError('NOT_FOUND', `${it.ref} has no browser check for ${key}.`);
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: it.projectId,
			itemId: it.id,
			...actorFields(ctx),
			verb: 'check.delete',
			targetType: 'check',
			targetId: gone[0].id,
			before: { key } as never,
			undoable: false
		});
		return { deleted: true };
	});
}

const runView = (r: typeof checkRun.$inferSelect) => ({
	id: r.id,
	target: r.target,
	requestedTarget: r.requestedTarget,
	url: r.url,
	commit: r.commit,
	diffHash: r.diffHash,
	durationMs: r.durationMs,
	result: r.result,
	flaky: r.flaky,
	reason: r.reason,
	stepKey: r.stepKey,
	evidence: r.evidence,
	requestedBy: r.requestedBy,
	createdAt: r.createdAt,
	startedAt: r.startedAt,
	finishedAt: r.finishedAt
});

/** What the Checks view of an item shows: each check with its manual check, its newest runs and which targets can run now. */
export async function itemChecks(ctx: Ctx, itemName: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemName);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${itemName}".`);
		await sweepRuns(tx, ctx.orgId, queueMinutes(ctx));
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		const checks = await tx
			.select()
			.from(check)
			.where(eq(check.itemId, it.id))
			.orderBy(asc(check.manualKey));
		const manual = await tx.select().from(manualCheck).where(eq(manualCheck.itemId, it.id));
		const runs = checks.length
			? await tx
					.select()
					.from(checkRun)
					.where(
						inArray(
							checkRun.checkId,
							checks.map((c) => c.id)
						)
					)
					.orderBy(desc(checkRun.createdAt))
					.limit(60)
			: [];
		const [pref] = await tx.select().from(userPref).where(eq(userPref.userId, ctx.actor.userId));
		const envs = await tx.select().from(environment).where(eq(environment.projectId, it.projectId));
		return {
			item: { id: it.id, ref: it.ref },
			webApp: p.webApp,
			defaultTarget: p.defaultTarget,
			preferredTarget: pref?.checkTarget ?? null,
			canRun: role !== 'viewer' && role !== 'guest',
			targets: await targetStatuses(tx, ctx.orgId, it.projectId),
			environments: envs.map((e) => ({
				name: e.name,
				kind: e.kind,
				production: e.production,
				writeAllowed: e.writeAllowed
			})),
			checks: checks.map((c) => {
				const mc = manual.find((m) => m.key === c.manualKey);
				return {
					id: c.id,
					key: c.manualKey,
					text: mc?.text ?? '',
					auto: mc?.auto ?? false,
					state: mc?.state ?? 'open',
					reason: mc?.reason ?? null,
					script: c.script,
					requiredTarget: c.requiredTarget,
					pinnedTarget: c.pinnedTarget,
					coveredPaths: c.coveredPaths,
					runs: runs
						.filter((r) => r.checkId === c.id)
						.slice(0, 8)
						.map(runView)
				};
			})
		};
	});
}

// -- FUNCTIONS: ASKING FOR A RUN -- //

/**
 * Target choice order: this run, then the check's pin, then the person's preference, then the project default. A target that
 * cannot run is reported with the targets that can, and nothing is swapped without asking.
 */
export async function requestRun(ctx: Ctx, raw: z.input<typeof requestRunInput>) {
	const input = requestRunInput.parse(raw);
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, input.item);
		const { role } = await requireCap(tx, ctx, 'write', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${input.item}".`);
		const [chk] = await tx
			.select()
			.from(check)
			.where(and(eq(check.itemId, it.id), eq(check.manualKey, input.key)));
		if (!chk)
			throw new OpError(
				'NOT_FOUND',
				`${it.ref} has no browser check for ${input.key}. Save one first.`
			);
		if (input.step) {
			const [s] = await tx
				.select({ id: step.id })
				.from(step)
				.where(and(eq(step.itemId, it.id), eq(step.key, input.step)));
			if (!s) throw new OpError('NOT_FOUND', `${it.ref} has no step ${input.step}.`);
		}
		await sweepRuns(tx, ctx.orgId, queueMinutes(ctx));
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		const [pref] = await tx.select().from(userPref).where(eq(userPref.userId, ctx.actor.userId));
		const asked = (input.target ??
			chk.pinnedTarget ??
			pref?.checkTarget ??
			p.defaultTarget) as Target;
		const statuses = await targetStatuses(tx, ctx.orgId, it.projectId);
		const status = statuses.find((s) => s.target === asked)!;
		let envName = status.environment;
		if (input.environment) {
			const [e] = await tx
				.select()
				.from(environment)
				.where(
					and(
						eq(environment.projectId, it.projectId),
						eq(environment.name, input.environment),
						eq(environment.kind, asked)
					)
				);
			if (!e)
				throw new OpError(
					'NOT_FOUND',
					`This project has no ${asked} environment named "${input.environment}".`
				);
			envName = e.name;
		}
		const offer = statuses.filter((s) => s.available && s.target !== asked).map((s) => s.target);
		const [row] = await tx
			.insert(checkRun)
			.values({
				orgId: ctx.orgId,
				projectId: it.projectId,
				checkId: chk.id,
				target: asked,
				requestedTarget: asked,
				requestedBy: ctx.actor.userId,
				stepKey: input.step ?? null,
				result: status.available ? 'queued' : 'unavailable',
				url: null,
				reason: status.available
					? envName
						? `Environment ${envName}`
						: null
					: `${status.reason}${offer.length ? ` You can run it on ${offer.join(' or ')} instead.` : ''}`,
				finishedAt: status.available ? null : sql`now()`
			})
			.returning();
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: it.projectId,
			itemId: it.id,
			...actorFields(ctx),
			verb: 'check_run.request',
			targetType: 'check_run',
			targetId: row.id,
			after: { key: input.key, target: asked, available: status.available } as never,
			undoable: false
		});
		return { run: runView(row), unavailable: !status.available, offer, target: asked };
	});
}

/** Newest runs of a project or an item, for the checks view. Sweeps stale runs first so a stuck one shows as stuck. */
export async function listRuns(ctx: Ctx, opts: { item?: string; limit?: number } = {}) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		await sweepRuns(tx, ctx.orgId, queueMinutes(ctx));
		const limit = Math.min(opts.limit ?? 30, 100);
		const base = tx
			.select({
				run: checkRun,
				key: check.manualKey,
				itemId: check.itemId,
				ref: item.ref,
				visibility: item.visibility,
				createdBy: item.createdBy,
				assigneeId: item.assigneeId,
				projectId: item.projectId
			})
			.from(checkRun)
			.innerJoin(check, eq(check.id, checkRun.checkId))
			.innerJoin(item, eq(item.id, check.itemId));
		const rows = await (
			opts.item ? base.where(eq(item.id, (await findItem(tx, ctx, opts.item)).id)) : base
		)
			.orderBy(desc(checkRun.createdAt))
			.limit(limit * 2);
		const out = [];
		for (const r of rows) {
			const { role } = await requireCap(tx, ctx, 'read', r.projectId);
			if (!canSeeItem(role, r, ctx.actor.userId)) continue;
			out.push({ ...runView(r.run), key: r.key, item: r.ref });
			if (out.length >= limit) break;
		}
		return out;
	});
}

// -- FUNCTIONS: THE RUNNER SIDE -- //

/** The acting person for a run: whoever asked for it, as an agent called browser-check. Their live role still applies. */
export function runnerCtx(
	handle: DbHandle,
	auth: RunnerAuth,
	userId: string,
	services?: Ctx['services']
): Ctx {
	return {
		handle,
		orgId: auth.orgId,
		services,
		actor: { userId, kind: 'agent', tool: 'browser-check', label: `Runner ${auth.name}` }
	};
}

export type CheckJob = {
	kind: 'check';
	id: string;
	project: { id: string; key: string };
	item: { id: string; ref: string };
	check: { key: string; script: string; coveredPaths: string[]; requiredTarget: Target };
	target: Target;
	environment: {
		name: string;
		url: string;
		kind: Target;
		production: boolean;
		writeAllowed: boolean;
		versionPath: string | null;
	};
	/** True when the run must not write: a production environment unless writes were allowed on purpose (L28). */
	readOnly: boolean;
	accounts: string[];
	stepKey: string | null;
};

/** Hands the oldest queued check run to a runner that serves its project, or nothing. */
export async function claimCheckJob(
	handle: DbHandle,
	auth: RunnerAuth,
	services?: Ctx['services']
): Promise<CheckJob | null> {
	if (!auth.projectIds.length) return null;
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		await sweepRuns(tx, auth.orgId, services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES);
		// The oldest runs first. A runner takes only a run whose environment it can reach, so a hosted runner never
		// uses up a run that sits on a private address
		const waiting = await tx
			.select({ id: checkRun.id })
			.from(checkRun)
			.where(
				and(
					eq(checkRun.orgId, auth.orgId),
					eq(checkRun.result, 'queued'),
					inArray(checkRun.projectId, auth.projectIds)
				)
			)
			.orderBy(asc(checkRun.createdAt))
			.limit(25)
			.for('update', { skipLocked: true });
		let picked: { r: typeof checkRun.$inferSelect; env: typeof environment.$inferSelect } | null =
			null;
		for (const w of waiting) {
			const [r] = await tx.select().from(checkRun).where(eq(checkRun.id, w.id));
			const envs = await tx
				.select()
				.from(environment)
				.where(
					and(eq(environment.projectId, r.projectId), eq(environment.kind, r.target as Target))
				);
			// A local runner reaches any address; a hosted one only a public address
			const usable = envs.filter((e) => auth.kind === 'local' || !isPrivateUrl(e.url));
			const wanted = r.reason?.startsWith('Environment ')
				? r.reason.slice('Environment '.length)
				: null;
			// An environment asked for by name is that one or none: it is never swapped for another of the same kind
			const env = wanted
				? usable.find((e) => e.name === wanted)
				: usable.sort((a, b) => Number(a.production) - Number(b.production))[0];
			if (env) {
				picked = { r, env };
				break;
			}
		}
		if (!picked) return null;
		const { r, env } = picked;
		await tx
			.update(checkRun)
			.set({ result: 'running', runnerId: auth.runnerId, startedAt: sql`now()` })
			.where(eq(checkRun.id, r.id));
		const [chk] = await tx.select().from(check).where(eq(check.id, r.checkId));
		const [it] = await tx.select().from(item).where(eq(item.id, chk.itemId));
		const [p] = await tx.select().from(project).where(eq(project.id, r.projectId));
		const accounts = await tx
			.select({ name: secret.name })
			.from(secret)
			.where(eq(secret.projectId, r.projectId));
		await tx.update(checkRun).set({ url: env.url, reason: null }).where(eq(checkRun.id, r.id));
		return {
			kind: 'check' as const,
			id: r.id,
			project: { id: p.id, key: p.key },
			item: { id: it.id, ref: it.ref },
			check: {
				key: chk.manualKey,
				script: chk.script,
				coveredPaths: chk.coveredPaths,
				requiredTarget: chk.requiredTarget as Target
			},
			target: r.target as Target,
			environment: {
				name: env.name,
				url: env.url,
				kind: env.kind as Target,
				production: env.production,
				writeAllowed: env.writeAllowed,
				versionPath: env.versionPath
			},
			readOnly: env.production && !env.writeAllowed,
			accounts: accounts.map((a) => a.name),
			stepKey: r.stepKey
		};
	});
}

/** A run this runner holds, or a refusal. Returns what the other runner calls need. */
async function heldRun(tx: Tx, auth: RunnerAuth, runId: string) {
	const [r] = await tx
		.select()
		.from(checkRun)
		.where(and(eq(checkRun.id, runId), eq(checkRun.orgId, auth.orgId)));
	if (!r) throw new OpError('NOT_FOUND', 'No such run.');
	if (r.runnerId !== auth.runnerId)
		throw new OpError('FORBIDDEN', 'This run is held by another runner.');
	if (!auth.projectIds.includes(r.projectId))
		throw new OpError('FORBIDDEN', 'This runner no longer serves that project.');
	return r;
}

/** The test accounts for a run the runner holds, opened. Only this project's accounts, and only while the run is running. */
export async function runAccounts(
	handle: DbHandle,
	auth: RunnerAuth,
	runId: string,
	services?: Ctx['services']
) {
	const held = await withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const r = await heldRun(tx, auth, runId);
		if (r.result !== 'running') throw new OpError('CONFLICT', 'The run is not running.');
		return r;
	});
	const ctx = runnerCtx(handle, auth, held.requestedBy ?? auth.ownerId ?? '', services);
	return openProjectAccounts(ctx, held.projectId);
}

/** The secrets of a project, as the values to scan for. Used by the server's own scan of logs and artifacts. */
export async function scanNeedles(
	handle: DbHandle,
	auth: RunnerAuth,
	projectId: string,
	requestedBy: string | null,
	services?: Ctx['services']
): Promise<Needle[]> {
	if (!services?.masterKey) return [];
	const ctx = runnerCtx(handle, auth, requestedBy ?? auth.ownerId ?? '', services);
	const accounts = await openProjectAccounts(ctx, projectId);
	return Object.entries(accounts).map(([name, a]) => ({
		label: `the password of the test account "${name}"`,
		value: a.password
	}));
}

/**
 * Stores a picture, trace or video from a run as a private attachment of the item. The bytes are scanned for the project's
 * secrets first and refused when one is found (SPEC 10). A refused upload also marks the run as an error.
 */
export async function storeRunArtifact(
	handle: DbHandle,
	auth: RunnerAuth,
	runId: string,
	file: { filename: string; caption: string; bytes: Uint8Array },
	services?: Ctx['services']
) {
	const info = await withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const r = await heldRun(tx, auth, runId);
		if (r.result !== 'running') throw new OpError('CONFLICT', 'The run is not running.');
		const [chk] = await tx.select().from(check).where(eq(check.id, r.checkId));
		return { run: r, itemId: chk.itemId, key: chk.manualKey };
	});
	const needles = await scanNeedles(
		handle,
		auth,
		info.run.projectId,
		info.run.requestedBy,
		services
	);
	const hit = findSecret(file.bytes, needles);
	if (hit) {
		await withTenant(handle, { orgId: auth.orgId }, (tx) =>
			tx
				.update(checkRun)
				.set({
					result: 'error',
					finishedAt: sql`now()`,
					reason: `An artifact held ${hit} and was refused. Nothing from this run was kept.`
				})
				.where(eq(checkRun.id, runId))
		);
		throw new OpError(
			'INVALID',
			`The file holds ${hit}, so it was not stored and the run was stopped.`
		);
	}
	const ctx = runnerCtx(handle, auth, info.run.requestedBy ?? auth.ownerId ?? '', services);
	const { attachment } = await addAttachment(
		ctx,
		{
			item: info.itemId,
			filename: file.filename,
			caption: file.caption,
			kind: 'check-evidence',
			refs: [info.key, runId],
			visibility: 'private'
		},
		file.bytes
	);
	return { attachmentId: attachment.id };
}

/** Pass on a target at least as strong as the one required. */
const meets = (target: string, required: string) =>
	TARGET_RANK[target as Target] >= TARGET_RANK[required as Target];

/**
 * Records a finished run, then does what the result means for the plan. The result is stored first, so a failure to update the
 * plan (the person who asked lost their access, say) never loses the run.
 */
export async function finishCheckRun(
	handle: DbHandle,
	auth: RunnerAuth,
	runId: string,
	raw: z.input<typeof runReport>,
	services?: Ctx['services']
) {
	const report = runReport.parse(raw);
	const held = await withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const r = await heldRun(tx, auth, runId);
		if (r.result !== 'running')
			throw new OpError('CONFLICT', `The run already finished (${r.result}).`);
		return r;
	});
	const needles = await scanNeedles(handle, auth, held.projectId, held.requestedBy, services);
	const leaked = report.log ? findSecret(report.log, needles) : null;
	const log = report.log && !leaked ? maskSecrets(report.log, needles).slice(-LOG_KEEP) : null;
	const result = leaked ? 'error' : report.result;
	const reason = leaked
		? `The run log held ${leaked} and was not kept.`
		: report.reason
			? maskSecrets(report.reason, needles)
			: null;

	const stored = await withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		// The commit and the diff hash say what code was tested. The same code passing and failing is flaky.
		let flaky = Boolean(report.retried);
		if (report.diffHash) {
			const [def] = await tx
				.select({ updatedAt: check.updatedAt })
				.from(check)
				.where(eq(check.id, held.checkId));
			const earlier = await tx
				.select()
				.from(checkRun)
				.where(
					and(
						eq(checkRun.checkId, held.checkId),
						eq(checkRun.target, held.target),
						report.commit ? eq(checkRun.commit, report.commit) : sql`${checkRun.commit} is null`,
						// A different answer after the check itself was edited is not flakiness
						sql`${checkRun.createdAt} >= ${def.updatedAt}`,
						eq(checkRun.diffHash, report.diffHash),
						inArray(checkRun.result, ['pass', 'fail']),
						sql`${checkRun.id} <> ${runId}`
					)
				);
			if (earlier.some((e) => e.result !== result && ['pass', 'fail'].includes(result))) {
				flaky = true;
				await tx
					.update(checkRun)
					.set({ flaky: true })
					.where(
						inArray(
							checkRun.id,
							earlier.filter((e) => e.result !== result).map((e) => e.id)
						)
					);
			}
		}
		const [row] = await tx
			.update(checkRun)
			.set({
				result,
				flaky,
				commit: report.commit ?? null,
				diffHash: report.diffHash ?? null,
				url: report.url ?? held.url,
				durationMs: report.durationMs ?? null,
				reason,
				log,
				evidence: report.evidence,
				finishedAt: sql`now()`
			})
			.where(eq(checkRun.id, runId))
			.returning();
		const [chk] = await tx.select().from(check).where(eq(check.id, held.checkId));
		const [it] = await tx.select().from(item).where(eq(item.id, chk.itemId));
		await appendEvent(tx, {
			orgId: auth.orgId,
			projectId: held.projectId,
			itemId: it.id,
			actorUserId: held.requestedBy,
			actorLabel: `Runner ${auth.name}`,
			tool: 'browser-check',
			verb: 'check_run.finish',
			targetType: 'check_run',
			targetId: runId,
			after: { key: chk.manualKey, target: held.target, result, flaky } as never,
			undoable: false
		});
		return { row, chk, it };
	});

	// What the result means for the plan, done as the person who asked
	const outcome = { ticked: [] as string[], reopened: [] as string[], note: null as string | null };
	if (held.requestedBy && (result === 'pass' || result === 'fail')) {
		const ctx = runnerCtx(handle, auth, held.requestedBy, services);
		try {
			if (result === 'pass' && report.unverified)
				outcome.note =
					'Passed, but the code under test could not be tied to this commit, so nothing was closed.';
			else if (result === 'pass') await tickOnPass(ctx, stored.chk, stored.it, stored.row, outcome);
			else await reopenOnFail(ctx, stored.chk, stored.it, stored.row, outcome);
		} catch (e) {
			outcome.note = `The plan was not updated: ${e instanceof OpError ? e.message : 'unexpected error'}`;
		}
		if (outcome.note)
			await withTenant(handle, { orgId: auth.orgId }, (tx) =>
				tx
					.update(checkRun)
					.set({ reason: sql`coalesce(${checkRun.reason} || ' ', '') || ${outcome.note}` })
					.where(eq(checkRun.id, runId))
			);
	}
	return { id: runId, result, flaky: stored.row.flaky, ...outcome };
}

async function tickOnPass(
	ctx: Ctx,
	chk: typeof check.$inferSelect,
	it: typeof item.$inferSelect,
	r: typeof checkRun.$inferSelect,
	outcome: { ticked: string[]; note: string | null }
) {
	const marks: {
		key: string;
		mark: 'done' | 'waived';
		reason?: string;
		evidence?: { checkRunId: string; target: Target };
	}[] = [];
	const target = r.target as Target;
	// The manual check closes only on a target at least as strong as the one the check requires
	const mcRow = await run(ctx, async (tx) => {
		const [mc] = await tx
			.select()
			.from(manualCheck)
			.where(and(eq(manualCheck.itemId, it.id), eq(manualCheck.key, chk.manualKey)));
		const steps = r.stepKey
			? await tx
					.select()
					.from(step)
					.where(and(eq(step.itemId, it.id), eq(step.key, r.stepKey)))
			: [];
		return { mc, step: steps[0] };
	});
	if (mcRow.mc && mcRow.mc.auto && mcRow.mc.state === 'open' && meets(target, chk.requiredTarget))
		marks.push({
			key: chk.manualKey,
			mark: 'waived',
			reason: `Browser check passed on ${target} (run ${r.id.slice(0, 8)})`
		});
	if (mcRow.step && mcRow.step.state === 'open') {
		const need = mcRow.step.requiredTarget ?? chk.requiredTarget;
		if (meets(target, need))
			marks.push({ key: mcRow.step.key, mark: 'done', evidence: { checkRunId: r.id, target } });
		else
			outcome.note = `Passed on ${target}, which is weaker than the ${need} that step ${mcRow.step.key} needs, so the step stays open.`;
	}
	if (!marks.length) {
		if (!outcome.note && !meets(target, chk.requiredTarget))
			outcome.note = `Passed on ${target}, which is weaker than the ${chk.requiredTarget} this check needs, so nothing was closed.`;
		return;
	}
	await recordSteps(ctx, {
		item: it.ref,
		marks,
		log: `Browser check ${chk.manualKey} passed on ${target}`
	});
	outcome.ticked.push(...marks.map((m) => m.key));
}

async function reopenOnFail(
	ctx: Ctx,
	chk: typeof check.$inferSelect,
	it: typeof item.$inferSelect,
	r: typeof checkRun.$inferSelect,
	outcome: { reopened: string[] }
) {
	const target = r.target as Target;
	const found = await run(ctx, async (tx) => {
		const earlier = await tx
			.select({ id: checkRun.id })
			.from(checkRun)
			.where(
				and(eq(checkRun.checkId, chk.id), eq(checkRun.target, target), eq(checkRun.result, 'pass'))
			);
		const ids = earlier.map((e) => e.id);
		const steps = ids.length
			? await tx
					.select({ key: step.key })
					.from(step)
					.where(
						and(
							eq(step.itemId, it.id),
							eq(step.state, 'done'),
							inArray(sql<string>`${step.evidence}->>'checkRunId'`, ids)
						)
					)
			: [];
		const [mc] = await tx
			.select()
			.from(manualCheck)
			.where(
				and(
					eq(manualCheck.itemId, it.id),
					eq(manualCheck.key, chk.manualKey),
					eq(manualCheck.state, 'waived'),
					sql`${manualCheck.reason} like ${`Browser check passed on ${target}%`}`
				)
			);
		return { steps: steps.map((s) => s.key), manual: mc?.key ?? null };
	});
	const keys = [...found.steps, ...(found.manual ? [found.manual] : [])];
	if (!keys.length) return;
	await recordSteps(ctx, {
		item: it.ref,
		marks: keys.map((key) => ({ key, mark: 'open' as const })),
		log: `Browser check ${chk.manualKey} failed on ${target} (run ${r.id.slice(0, 8)}), so ${keys.join(', ')} reopened`
	});
	outcome.reopened.push(...keys);
}

/**
 * How many runs wait for this runner: queued check runs and UI shots runs of the projects it serves. A supervisor asks this
 * before it starts a container, so an idle queue starts nothing.
 */
export async function peekQueue(handle: DbHandle, auth: RunnerAuth): Promise<number> {
	if (!auth.projectIds.length) return 0;
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const [a] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(checkRun)
			.where(
				and(
					eq(checkRun.orgId, auth.orgId),
					eq(checkRun.result, 'queued'),
					inArray(checkRun.projectId, auth.projectIds)
				)
			);
		const [b] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(uiShotRun)
			.where(
				and(
					eq(uiShotRun.orgId, auth.orgId),
					eq(uiShotRun.state, 'queued'),
					inArray(uiShotRun.projectId, auth.projectIds)
				)
			);
		return (a?.n ?? 0) + (b?.n ?? 0);
	});
}

/** Runs that are not finished and belong to a runner that has been offline for long: a runner restart gives them back. */
export async function releaseRunnerRuns(handle: DbHandle, auth: RunnerAuth) {
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const back = await tx
			.update(checkRun)
			.set({ result: 'queued', runnerId: null, startedAt: null })
			.where(and(eq(checkRun.runnerId, auth.runnerId), eq(checkRun.result, 'running')))
			.returning({ id: checkRun.id });
		return back.length;
	});
}
