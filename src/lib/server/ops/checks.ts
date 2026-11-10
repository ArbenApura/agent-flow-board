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
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { classifyRun } from '../../shared/runErrors';
import { findSecret, maskSecrets, type Needle } from '../../shared/scan';
import { appendEvent } from '../db/events';
import {
	attachment,
	check,
	checkRun,
	environment,
	item,
	manualCheck,
	org,
	project,
	runner,
	secret,
	step,
	userPref
} from '../db/schema';
import { TARGETS } from '../db/schema/helpers';
import { withTenant } from '../db/tenant';
import { OpError, idempotent, projectAllowed, requireCap, run } from './context';
import {
	RUNNER_ONLINE_SECONDS,
	TOOL_ENV_NAME,
	TOOL_PROTOCOL_MIN,
	openProjectAccounts,
	reachesPrivate,
	toolEnvironment
} from './environments';
import { actorFields, canSeeItem } from './items';
import { findItem, findProject } from './resolve';
import { recordSteps } from './steps';
import { registrationFit, runnerRegistrationPairs } from './registrations';
import { addAttachment } from './attachments';
import { lintCheckScript } from './checkLint';

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
/** A run whose runner sends a heartbeat is reported stuck when the beat stops for this long. A runner that never beats keeps the longer rule above. */
export const BEAT_TIMEOUT_MINUTES = 10;
const LOG_KEEP = 20_000;
/** The longest a single wait may last, and the default, in seconds. Many MCP clients cut a call near 60 seconds, so a wait stays under that. */
export const WAIT_MAX_SECONDS = 50;
const WAIT_DEFAULT_SECONDS = 30;
const WAIT_POLL_MS = 2000;
/** How many runs per org may be waited for at once in one server process. */
const WAITERS_PER_ORG = 5;

/** A registration name of the afb-checks tool: plain letters, digits, dashes and underscores, as the tool allows. */
export const REGISTRATION_NAME = z
	.string()
	.regex(
		/^[A-Za-z0-9_-]{1,32}$/,
		'A registration name is 1 to 32 letters, digits, dashes or underscores'
	);

export const checkInput = z.object({
	item: z.string().min(1),
	/** The manual check this closes, such as M8. */
	key: z.string().regex(/^M[0-9]+$/, 'Use the manual check key, for example M8'),
	/** The whole script. Leave it out and give `edit` to change a saved script by one replacement. */
	script: z.string().min(1).max(100_000).optional(),
	/** One replacement in the saved script: `old` must appear exactly once. Saves resending a long script for a small fix. */
	edit: z.object({ old: z.string().min(1).max(20_000), new: z.string().max(20_000) }).optional(),
	coveredPaths: z.array(z.string().min(1).max(200)).max(50).default([]),
	requiredTarget: z.enum(TARGETS).default('preview'),
	pinnedTarget: z.enum(TARGETS).nullish(),
	/** The registration this check runs in. Leave it out to keep the one already saved; null clears it. */
	registration: REGISTRATION_NAME.nullish()
});

export const requestRunInput = z.object({
	item: z.string().min(1),
	key: z.string().regex(/^M[0-9]+$/),
	/** Names a target for this run only. */
	target: z.enum(TARGETS).optional(),
	/** Names one environment of that target when the project has more than one. */
	environment: z.string().max(40).optional(),
	/** The plan step to close when the run passes on its required target. */
	step: z.string().max(20).optional(),
	/** Names the registration for this run only; the check's own registration is used when it is left out. */
	registration: REGISTRATION_NAME.optional()
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
	/** The registration the tool used, and the folder name and branch of its repo. Tool-reported text: plain names only. */
	registration: REGISTRATION_NAME.optional(),
	repoName: z.string().max(100).optional(),
	branch: z
		.string()
		.regex(/^[A-Za-z0-9._/-]{1,100}$/)
		.optional(),
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
		// The afb-checks tool starts the preview itself, so a project needs no environment row for it
		if (!candidates.length && target === 'preview' && runners.some((r) => r.kind === 'tool'))
			return { target, available: true, environment: toolEnvironment(target).name, reason: null };
		if (!candidates.length)
			return {
				target,
				available: false,
				environment: null,
				reason:
					target === 'preview'
						? 'This project has no preview environment and no check runner is connected. Your agent connects the afb-checks tool by itself; runner_status lists the steps.'
						: `This project has no ${target} environment yet.`
			};
		if (!runners.length)
			return {
				target,
				available: false,
				environment: candidates[0].name,
				reason: 'No runner that serves this project is online.'
			};
		const reachable = candidates.find((e) =>
			runners.some((r) => reachesPrivate(r.kind) || !isPrivateUrl(e.url))
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
				// A runner that has beaten at least once is held to its beat below; one that never beats (an older tool) keeps this rule
				sql`${checkRun.lastBeatAt} is null`,
				sql`${checkRun.startedAt} < now() - make_interval(mins => ${RUNNING_TIMEOUT_MINUTES})`
			)
		)
		.returning({ id: checkRun.id });
	const silent = await tx
		.update(checkRun)
		.set({
			result: 'timeout',
			finishedAt: sql`now()`,
			reason: `The runner that took this run stopped reporting for ${BEAT_TIMEOUT_MINUTES} minutes.`
		})
		.where(
			and(
				eq(checkRun.orgId, orgId),
				eq(checkRun.result, 'running'),
				sql`${checkRun.lastBeatAt} < now() - make_interval(mins => ${BEAT_TIMEOUT_MINUTES})`
			)
		)
		.returning({ id: checkRun.id });
	return queued.length + stuck.length + silent.length;
}

// -- FUNCTIONS: CHECKS -- //

/**
 * Adds or replaces the browser check of one manual check, and marks that manual check automatic in the same transaction so
 * the check can run. A manual check that is already done or waived keeps its state and is not flipped; the answer says so.
 */
export async function saveCheck(ctx: Ctx, raw: z.input<typeof checkInput>) {
	const input = checkInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
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
			const [existing] = await tx
				.select()
				.from(check)
				.where(and(eq(check.itemId, it.id), eq(check.manualKey, input.key)));
			// The script is the whole text, or the saved text with one replacement. Both are read before anything is written
			if ((input.script === undefined) === (input.edit === undefined))
				throw new OpError(
					'INVALID',
					'Give either the whole script or one edit, not both and not neither.'
				);
			let script = input.script;
			if (input.edit) {
				if (!existing)
					throw new OpError(
						'NOT_FOUND',
						`${input.key} has no saved script to edit. Save the whole script first.`
					);
				const parts = existing.script.split(input.edit.old);
				if (parts.length !== 2)
					throw new OpError(
						'INVALID',
						parts.length === 1
							? 'The text to replace was not found in the saved script, so nothing was saved.'
							: `The text to replace appears ${parts.length - 1} times in the saved script: give more of the line, so it is unique. Nothing was saved.`
					);
				script = `${parts[0]}${input.edit.new}${parts[1]}`;
			}
			const blocked = lintCheckScript(script!);
			if (blocked.length)
				throw new OpError(
					'INVALID',
					`The script cannot run in the afb-checks tool, so it was not saved. ${blocked.join(' ')}`,
					{ code: 'SCRIPT_BLOCKED', blocked }
				);
			// An edit keeps what the saved check already says unless the call names it
			const keep = !!input.edit;
			const values = {
				script: script!,
				coveredPaths: keep && !raw.coveredPaths ? existing!.coveredPaths : input.coveredPaths,
				requiredTarget:
					keep && !raw.requiredTarget ? existing!.requiredTarget : input.requiredTarget,
				pinnedTarget:
					keep && raw.pinnedTarget === undefined
						? existing!.pinnedTarget
						: (input.pinnedTarget ?? null),
				// Left out keeps the registration already saved; null clears it
				...(input.registration === undefined ? {} : { registration: input.registration })
			};
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
			// The manual check must be automatic for the check to run. A closed one is left as the person closed it
			let auto = mc.auto;
			let note: string | null = null;
			if (mc.state !== 'open') {
				note = `${input.key} is ${mc.state}, so its automatic flag was not changed.`;
			} else if (!mc.auto) {
				await tx
					.update(manualCheck)
					.set({ auto: true, updatedAt: sql`now()`, version: sql`${manualCheck.version} + 1` })
					.where(eq(manualCheck.id, mc.id));
				auto = true;
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
					pinnedTarget: values.pinnedTarget,
					registration: input.registration,
					auto
				} as never,
				undoable: false
			});
			return { id, created: !existing, auto, note };
		})
	);
}

export async function deleteCheck(ctx: Ctx, itemName: string, key: string) {
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const it = await findItem(tx, ctx, itemName);
			await requireCap(tx, ctx, 'write', it.projectId);
			const gone = await tx
				.delete(check)
				.where(and(eq(check.itemId, it.id), eq(check.manualKey, key)))
				.returning({ id: check.id });
			if (!gone.length)
				throw new OpError('NOT_FOUND', `${it.ref} has no browser check for ${key}.`);
			// With no browser check left the manual check is plain again. A closed one is left as it was closed
			await tx
				.update(manualCheck)
				.set({ auto: false, updatedAt: sql`now()`, version: sql`${manualCheck.version} + 1` })
				.where(
					and(
						eq(manualCheck.itemId, it.id),
						eq(manualCheck.key, key),
						eq(manualCheck.state, 'open'),
						eq(manualCheck.auto, true)
					)
				);
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
		})
	);
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
	// The registration the run was asked for, and what the tool says it used (tool-reported plain names)
	registration: r.registration,
	ran: r.ranRegistration
		? { registration: r.ranRegistration, repo: r.ranRepo, branch: r.ranBranch }
		: null,
	evidence: r.evidence,
	requestedBy: r.requestedBy,
	createdAt: r.createdAt,
	startedAt: r.startedAt,
	finishedAt: r.finishedAt,
	// The code and fix line are the board's own text, never the tool's. Both are null when nothing needs fixing
	...classifyRun(r.result, r.reason)
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
		// The files a run saved (screenshots, trace, video), named so the board shows pictures as pictures and the rest as links
		const evidenceIds = [...new Set(runs.flatMap((r) => r.evidence))];
		const files = evidenceIds.length
			? await tx
					.select({
						id: attachment.id,
						filename: attachment.filename,
						caption: attachment.caption,
						mime: attachment.mime
					})
					.from(attachment)
					.where(and(inArray(attachment.id, evidenceIds), isNull(attachment.deletedAt)))
			: [];
		// The time windows of the organisation's runs since the oldest shown run began, to tell which ones shared the machine
		const firstStart = runs.reduce<Date | null>(
			(m, r) => (r.startedAt && (!m || r.startedAt < m) ? r.startedAt : m),
			null
		);
		const windows = firstStart
			? await tx
					.select({ id: checkRun.id, s: checkRun.startedAt, f: checkRun.finishedAt })
					.from(checkRun)
					.where(and(eq(checkRun.orgId, ctx.orgId), gte(checkRun.startedAt, firstStart)))
			: [];
		const overlapped = (r: typeof checkRun.$inferSelect) =>
			!!r.startedAt &&
			windows.some(
				(w) =>
					w.id !== r.id &&
					!!w.s &&
					w.s < (r.finishedAt ?? new Date()) &&
					(w.f ?? new Date()) > r.startedAt!
			);
		const [pref] = await tx.select().from(userPref).where(eq(userPref.userId, ctx.actor.userId));
		const envs = await tx.select().from(environment).where(eq(environment.projectId, it.projectId));
		return {
			item: { id: it.id, ref: it.ref },
			webApp: p.webApp,
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
					registration: c.registration,
					coveredPaths: c.coveredPaths,
					runs: runs
						.filter((r) => r.checkId === c.id)
						.slice(0, 8)
						.map((r) => ({
							...runView(r),
							// A run that shared the machine with another run of the organisation is no speed measurement
							sharedCpu: overlapped(r),
							files: r.evidence.flatMap((fid) => files.filter((f) => f.id === fid))
						}))
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
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
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
			const [pref] = await tx.select().from(userPref).where(eq(userPref.userId, ctx.actor.userId));
			// A run that names no target, and has no pin or saved choice, is on the build preview: the only target the afb-checks tool runs
			const asked = (input.target ?? chk.pinnedTarget ?? pref?.checkTarget ?? 'preview') as Target;
			const statuses = await targetStatuses(tx, ctx.orgId, it.projectId);
			let status = statuses.find((s) => s.target === asked)!;
			// The registration this run uses: the one named now, else the check's own, else none (the project's only registration)
			// Only the preview runs in the afb-checks tool, and only the tool has registrations: a dev or deployed run carries none
			if (input.registration && asked !== 'preview')
				throw new OpError(
					'INVALID',
					`A registration applies to the preview target only (this run is on ${asked}).`
				);
			const registration =
				asked === 'preview' ? (input.registration ?? chk.registration ?? null) : null;
			if (asked === 'preview') {
				const [proj] = await tx
					.select({ key: project.key })
					.from(project)
					.where(eq(project.id, it.projectId));
				const fit = await registrationFit(tx, ctx.orgId, it.projectId, proj.key, registration);
				// Never a guess: a project with several registrations needs one named, and the answer lists them
				if (!registration && fit.choices)
					throw new OpError(
						'INVALID',
						`REGISTRATION_REQUIRED: ${proj.key} has ${fit.choices.length} registrations (${fit.choices.join(', ')}) and none was named. Name one with registration on check_run or check_save.`,
						{ code: 'REGISTRATION_REQUIRED', registrations: fit.choices }
					);
				// A registration no online tool holds is reported at once, with what the tools do hold
				if (status.available && !fit.ok)
					status = { ...status, available: false, reason: fit.reason };
			}
			// One open run per check and target: two agents, or a retry, get the run that is already waiting or running. The check
			// row is locked so two calls at the same moment cannot both insert
			await tx.select({ id: check.id }).from(check).where(eq(check.id, chk.id)).for('update');
			// A target that cannot run now is reported as unavailable, as before, never answered with a run that is still waiting
			const [open] = status.available
				? await tx
						.select()
						.from(checkRun)
						.where(
							and(
								eq(checkRun.checkId, chk.id),
								eq(checkRun.target, asked),
								// A run for another registration is a different run: its pass says nothing about this one
								registration === null
									? sql`${checkRun.registration} is null`
									: sql`lower(${checkRun.registration}) = ${registration.toLowerCase()}`,
								inArray(checkRun.result, ['queued', 'running'])
							)
						)
						.orderBy(desc(checkRun.createdAt))
						.limit(1)
				: [];
			// A run asked for a named environment is reused only when that is the environment the open run was queued for
			const sameEnv = !input.environment || open?.reason === `Environment ${input.environment}`;
			if (open && sameEnv) {
				// A run that has no step yet takes the one named now, so the pass still closes it
				if (input.step && !open.stepKey)
					await tx.update(checkRun).set({ stepKey: input.step }).where(eq(checkRun.id, open.id));
				return {
					run: runView({ ...open, stepKey: open.stepKey ?? input.step ?? null }),
					unavailable: false,
					offer: [] as Target[],
					target: asked,
					reused: true
				};
			}
			let envName = status.environment;
			if (
				input.environment &&
				input.environment === TOOL_ENV_NAME &&
				status.environment === TOOL_ENV_NAME
			) {
				// The name the board offered for a tool preview is accepted as it was offered
				envName = TOOL_ENV_NAME;
			} else if (input.environment) {
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
					registration,
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
				after: {
					key: input.key,
					target: asked,
					available: status.available,
					registration
				} as never,
				undoable: false
			});
			// A target that cannot run because no tool is online comes with what the agent does about it, not a note for a person
			// Only the preview is run by the afb-checks tool, so a deployed or dev target that has no runner gets no tool steps
			const toolOffline =
				!status.available &&
				asked === 'preview' &&
				/afb-checks|No runner that serves/i.test(status.reason ?? '');
			const [o] = toolOffline
				? await tx.select({ slug: org.slug }).from(org).where(eq(org.id, ctx.orgId))
				: [];
			const hasTool = toolOffline
				? (
						await tx
							.select({ id: runner.id })
							.from(runner)
							.where(
								and(
									eq(runner.orgId, ctx.orgId),
									eq(runner.kind, 'tool'),
									sql`${it.projectId}::uuid = any(${runner.projectIds})`
								)
							)
							.limit(1)
					).length > 0
				: false;
			return {
				run: runView(row),
				unavailable: !status.available,
				offer,
				target: asked,
				reused: false,
				...(toolOffline
					? {
							agentAction: toolAgentAction(hasTool ? 'repair' : 'connect', {
								board: ctx.services?.baseUrl,
								org: o?.slug
							})
						}
					: {})
			};
		})
	);
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

// -- FUNCTIONS: WAITING FOR A RUN AND RUNNER STATUS -- //

const OPEN_RESULTS = new Set(['queued', 'running']);
/** Waiters per org in this process, so a few agents waiting cannot starve the database of connections. */
const waiters = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** How many waits an org has open in this process. Read by the tests, so they wait for the real state and not a fixed time. */
export const waitersFor = (orgId: string) => waiters.get(orgId) ?? 0;

export const waitRunInput = z.object({
	run: z.string().uuid('Give the run id from check_run or check_status'),
	seconds: z.number().int().min(0).max(WAIT_MAX_SECONDS).default(WAIT_DEFAULT_SECONDS)
});

/**
 * One run by id, for a person who may read its item. A missing run, a private item of someone else, another org and a project
 * the token does not cover all answer the same NOT_FOUND, so a run id cannot be used to probe. Sweeps stale runs first.
 */
export async function getRun(ctx: Ctx, runId: string) {
	return run(ctx, async (tx) => {
		// The role check does not depend on the run, so it says nothing about whether the run exists
		await requireCap(tx, ctx, 'read');
		await sweepRuns(tx, ctx.orgId, queueMinutes(ctx));
		const gone = () => new OpError('NOT_FOUND', 'No such run.');
		const [row] = await tx
			.select({ run: checkRun, itemId: check.itemId, key: check.manualKey })
			.from(checkRun)
			.innerJoin(check, eq(check.id, checkRun.checkId))
			.where(eq(checkRun.id, runId));
		if (!row) throw gone();
		let ref: string;
		try {
			const it = await findItem(tx, ctx, row.itemId);
			await requireCap(tx, ctx, 'read', it.projectId);
			ref = it.ref;
		} catch (e) {
			if (e instanceof OpError && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN')) throw gone();
			throw e;
		}
		return { ...runView(row.run), key: row.key, item: ref };
	});
}

/**
 * Waits for a run to finish. Each look is its own short transaction with a sleep between, never one transaction held open, and
 * at most a few waiters per org run at once. Returns the run and whether it finished; unfinished means ask again.
 */
export async function waitForRun(
	ctx: Ctx,
	raw: z.input<typeof waitRunInput>,
	opts: { pollMs?: number } = {}
) {
	const input = waitRunInput.parse(raw);
	let view = await getRun(ctx, input.run);
	if (!OPEN_RESULTS.has(view.result) || input.seconds === 0)
		return { run: view, finished: !OPEN_RESULTS.has(view.result) };
	const now = waiters.get(ctx.orgId) ?? 0;
	if (now >= WAITERS_PER_ORG)
		throw new OpError(
			'RATE_LIMITED',
			'Too many runs are being waited for at once. Try again in a moment.',
			{ limit: WAITERS_PER_ORG }
		);
	waiters.set(ctx.orgId, now + 1);
	try {
		const until = Date.now() + input.seconds * 1000;
		const poll = opts.pollMs ?? WAIT_POLL_MS;
		while (OPEN_RESULTS.has(view.result) && Date.now() < until) {
			await sleep(Math.min(poll, Math.max(0, until - Date.now())));
			view = await getRun(ctx, input.run);
		}
	} finally {
		const left = (waiters.get(ctx.orgId) ?? 1) - 1;
		if (left <= 0) waiters.delete(ctx.orgId);
		else waiters.set(ctx.orgId, left);
	}
	return { run: view, finished: !OPEN_RESULTS.has(view.result) };
}

/** The audit chain of the newest tool runner that has reported one: its length, and when the report last went backwards. Never an action or a path. */
function toolAudit(
	runners: {
		kind: string;
		lastSeenAt: Date | null;
		auditLines: number | null;
		auditRegressedAt: Date | null;
	}[]
) {
	const t = runners
		.filter((r) => r.kind === 'tool' && r.auditLines !== null)
		.sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))[0];
	return t ? { lines: t.auditLines, regressedAt: t.auditRegressedAt } : null;
}

/** The slots of the tools that are online and how many of them are busy, or null when none has reported. */
function toolCapacity(
	online: { kind: string; capacitySlots: number | null; capacityBusy: number | null }[]
) {
	const t = online.filter((r) => r.kind === 'tool' && r.capacitySlots !== null);
	if (!t.length) return null;
	const slots = t.reduce((n, r) => n + (r.capacitySlots ?? 0), 0);
	const busy = t.reduce((n, r) => n + (r.capacityBusy ?? 0), 0);
	return { slots, busy, free: Math.max(0, slots - busy) };
}

/**
 * What an agent does, on the machine that runs the afb-checks tool, when no tool is online. The board never starts anything on that machine (it only
 * answers the tool's calls), so this is a list of steps for the agent: the tool repairs itself with `doctor --fix`, and a tool that was never connected is
 * connected by the agent through the approve tool, with nobody typing a code.
 */
export function toolAgentAction(
	state: 'repair' | 'connect' | 'runner',
	where: { board?: string; org?: string }
) {
	const server = where.board ?? '<board address>';
	const org = where.org ?? '<org slug>';
	if (state === 'connect')
		return {
			action: 'connect',
			why: 'No afb-checks tool is connected to this project.',
			steps: [
				`On the machine that runs the tool, with the bridge installed (agent-flow-board), start in the background: agent-flow-board check connect --server ${server} --org ${org} --json (one machine serves every organisation: this adds ${org} next to the others and never replaces one, so never add --force for it)`,
				'Read its first output line. It holds userCode and verifier.',
				'Call tool_connection_approve with both. Only a code that tool started is accepted.',
				'When the tool prints its connected line, start the worker yourself. On Windows: agent-flow-board check service install (it starts now and at every sign-in). On macOS or Linux: start agent-flow-board check watch in the background. Then run agent-flow-board check doctor --fix --json and call runner_status again. Doctor repairs, it does not start the worker.'
			]
		};
	if (state === 'repair')
		return {
			action: 'repair',
			why: 'The tool is connected but is not running or cannot reach this board.',
			steps: [
				'On the machine that runs the tool, run: agent-flow-board check doctor --fix --json',
				'If it lists a problem with a next step, do that step (for a stale board address it names the connect command).',
				'Doctor does not start a worker that is not running. Start it yourself: on Windows agent-flow-board check service install (or check service status when it is installed), on macOS or Linux agent-flow-board check watch in the background.',
				'Call runner_status again.'
			]
		};
	return {
		action: 'runner',
		why: 'A runner serves this project but is offline.',
		steps: ['Start that runner, then call runner_status again.']
	};
}

/**
 * Whether a tool is online to take runs, per project the caller can reach. Built on the same online window as targetStatuses.
 * Shows a fixed shape and never a token, an owner or a device name.
 */
export async function runnerStatus(ctx: Ctx, keyOrId?: string) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, ctx.orgId));
		const orgSlug = o?.slug;
		const projects: { id: string; key: string }[] = [];
		if (keyOrId) {
			const p = await findProject(tx, ctx, keyOrId);
			await requireCap(tx, ctx, 'read', p.id);
			projects.push({ id: p.id, key: p.key });
		} else {
			const all = await tx
				.select({ id: project.id, key: project.key })
				.from(project)
				.where(eq(project.orgId, ctx.orgId))
				.orderBy(asc(project.key));
			for (const p of all) {
				if (!projectAllowed(ctx.actor, p.id)) continue;
				try {
					await requireCap(tx, ctx, 'read', p.id);
					projects.push(p);
				} catch (e) {
					if (!(e instanceof OpError)) throw e;
				}
			}
		}
		const out = [];
		for (const p of projects) {
			const runners = await tx
				.select({
					id: runner.id,
					kind: runner.kind,
					lastSeenAt: runner.lastSeenAt,
					auditLines: runner.auditLines,
					auditRegressedAt: runner.auditRegressedAt,
					capacitySlots: runner.capacitySlots,
					capacityBusy: runner.capacityBusy,
					registrations: runner.registrations
				})
				.from(runner)
				.where(and(eq(runner.orgId, ctx.orgId), sql`${p.id}::uuid = any(${runner.projectIds})`));
			// The registrations the online tools hold for this project. The folder name and branch are tool-reported text, so a guest sees the names only
			const { role: seeing } = await requireCap(tx, ctx, 'read', p.id);
			const onlineNow = runners.filter(
				(r) => r.lastSeenAt && Date.now() - r.lastSeenAt.getTime() < RUNNER_ONLINE_SECONDS * 1000
			);
			const seen = runners
				.map((r) => r.lastSeenAt)
				.filter((d): d is Date => Boolean(d))
				.sort((a, b) => b.getTime() - a.getTime())[0];
			const [held] = runners.length
				? await tx
						.select({ n: sql<number>`count(*)::int` })
						.from(checkRun)
						.where(
							and(
								eq(checkRun.projectId, p.id),
								eq(checkRun.result, 'running'),
								inArray(
									checkRun.runnerId,
									runners.map((r) => r.id)
								)
							)
						)
				: [{ n: 0 }];
			const kind = (onlineNow[0] ?? runners[0])?.kind ?? null;
			const hasTool = runners.some((r) => r.kind === 'tool');
			const registrations = [
				...new Map(
					onlineNow
						.flatMap((r) => r.registrations ?? [])
						.filter((r) => r.project === p.key)
						.map((r) => [
							r.name.toLowerCase(),
							seeing === 'guest'
								? { name: r.name }
								: { name: r.name, repo: r.repo ?? null, branch: r.branch ?? null }
						])
				).values()
			];
			out.push({
				project: p.key,
				online: onlineNow.length > 0,
				lastSeen: seen ?? null,
				kind,
				minProtocol: TOOL_PROTOCOL_MIN,
				heldRuns: held?.n ?? 0,
				// The tool's local audit chain as it last reported it: only a length, and when it last got shorter or changed under the same length
				audit: toolAudit(runners),
				// How many runs the online tools take at once and hold. Display only: the board never uses it to decide where a run goes
				capacity: toolCapacity(onlineNow),
				// The registrations an online tool holds for this project (tool-reported). With more than one, a run must name one: registration on check_run or check_save
				registrations,
				registrationRequired: registrations.length > 1,
				hint: onlineNow.length
					? 'A runner is online and will take the next run.'
					: hasTool
						? 'The afb-checks tool is connected but not running. Follow agentAction on the machine that runs the tool, then ask again.'
						: runners.length
							? 'A runner serves this project but is offline. Start it and ask again.'
							: 'No afb-checks tool is connected to this project. Follow agentAction to connect it; nobody needs to type a command.',
				agentAction: onlineNow.length
					? null
					: toolAgentAction(hasTool ? 'repair' : runners.length ? 'runner' : 'connect', {
							board: ctx.services?.baseUrl,
							org: orgSlug
						})
			});
		}
		// The board's own address, so a tool that was connected to an older host is seen at once: compare it with `status --json` of the tool
		return { board: ctx.services?.baseUrl ?? null, projects: out };
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

type JobEnv = Pick<
	typeof environment.$inferSelect,
	'name' | 'url' | 'kind' | 'production' | 'writeAllowed' | 'versionPath'
>;

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
	/** The registration of the tool this run must use, or null when the project's only registration serves it. */
	registration: string | null;
};

/** Runs a tool may take: those that name no registration, and those that name one the tool reports (compared without regard to case). */
const registrationClaimable = (held: string[]) =>
	held.length
		? or(
				isNull(checkRun.registration),
				sql`exists (select 1 from project where project.id = ${checkRun.projectId} and lower(project.key || ':' || ${checkRun.registration}) in (${sql.join(
					held.map((h) => sql`${h}`),
					sql`, `
				)}))`
			)
		: isNull(checkRun.registration);

/**
 * Hands the oldest queued check run to a runner that serves its project, or nothing. With `only.runId` it takes that one run and no other
 * (the bridge claims the run it just asked for, so it never takes someone else's queued run), and nothing when that run is not queued
 * for this runner.
 */
export async function claimCheckJob(
	handle: DbHandle,
	auth: RunnerAuth,
	services?: Ctx['services'],
	only?: { runId?: string }
): Promise<CheckJob | null> {
	if (!auth.projectIds.length) return null;
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		await sweepRuns(tx, auth.orgId, services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES);
		// A run that names a registration is taken only by a tool that reports it (an older tool reports none, so it takes only runs that name none).
		// The filter is part of the query, before the limit, so a long line of runs for one registration never hides the runs of another
		const held = await runnerRegistrationPairs(tx, auth);
		// The oldest runs first. A runner takes only a run whose environment it can reach, so a hosted runner never
		// uses up a run that sits on a private address
		const waiting = await tx
			.select({ id: checkRun.id })
			.from(checkRun)
			.where(
				and(
					eq(checkRun.orgId, auth.orgId),
					eq(checkRun.result, 'queued'),
					inArray(checkRun.projectId, auth.projectIds),
					registrationClaimable(held),
					only?.runId ? eq(checkRun.id, only.runId) : undefined
				)
			)
			.orderBy(asc(checkRun.createdAt))
			.limit(25)
			.for('update', { skipLocked: true });
		let picked: { r: typeof checkRun.$inferSelect; env: JobEnv } | null = null;
		for (const w of waiting) {
			const [r] = await tx.select().from(checkRun).where(eq(checkRun.id, w.id));
			const envs = await tx
				.select()
				.from(environment)
				.where(
					and(eq(environment.projectId, r.projectId), eq(environment.kind, r.target as Target))
				);
			// A local runner reaches any address; a hosted one only a public address
			const usable = envs.filter((e) => reachesPrivate(auth.kind) || !isPrivateUrl(e.url));
			const wanted = r.reason?.startsWith('Environment ')
				? r.reason.slice('Environment '.length)
				: null;
			// An environment asked for by name is that one or none: it is never swapped for another of the same kind
			let env: JobEnv | undefined = wanted
				? usable.find((e) => e.name === wanted)
				: usable.sort((a, b) => Number(a.production) - Number(b.production))[0];
			// The tool brings its own preview, so it takes a preview run that has no environment row
			if (
				!env &&
				auth.kind === 'tool' &&
				r.target === 'preview' &&
				(!wanted || wanted === TOOL_ENV_NAME)
			)
				env = toolEnvironment('preview');
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
			stepKey: r.stepKey,
			registration: r.registration
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

/**
 * The runner says it is alive and still working on a run it holds. A run the board already gave up on (timeout) or that finished answers
 * CONFLICT, with the code RUN_TIMED_OUT for a timeout, so the tool stops instead of working on a run nobody will read.
 */
export async function beatCheckRun(handle: DbHandle, auth: RunnerAuth, runId: string) {
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const r = await heldRun(tx, auth, runId);
		if (r.result !== 'running')
			throw new OpError(
				'CONFLICT',
				`The run already finished (${r.result}).`,
				r.result === 'timeout' ? { code: 'RUN_TIMED_OUT' } : undefined
			);
		await tx
			.update(checkRun)
			.set({ lastBeatAt: sql`now()` })
			.where(eq(checkRun.id, runId));
		return { ok: true, beatMinutes: BEAT_TIMEOUT_MINUTES };
	});
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
			throw new OpError(
				'CONFLICT',
				`The run already finished (${r.result}).`,
				r.result === 'timeout' ? { code: 'RUN_TIMED_OUT' } : undefined
			);
		return r;
	});
	const needles = await scanNeedles(handle, auth, held.projectId, held.requestedBy, services);
	const leaked = report.log ? findSecret(report.log, needles) : null;
	const log = report.log && !leaked ? maskSecrets(report.log, needles).slice(-LOG_KEEP) : null;
	// A run that was asked for a registration is accepted only from that registration: a tool that ran another one (or did not say) cannot close a step
	// (an error report closes nothing, so it keeps its own reason even when the tool stopped before it knew its registration)
	const wrongRegistration =
		held.registration !== null &&
		report.result !== 'error' &&
		report.registration?.toLowerCase() !== held.registration.toLowerCase();
	const result = leaked || wrongRegistration ? 'error' : report.result;
	const reason = leaked
		? `The run log held ${leaked} and was not kept.`
		: wrongRegistration
			? `This run was asked for the registration ${held.registration}, but the tool reported ${report.registration ?? 'none'}, so the result was not used.`
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
				ranRegistration: report.registration ?? null,
				ranRepo: report.repoName ?? null,
				ranBranch: report.branch ?? null,
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
				and(
					eq(checkRun.checkId, chk.id),
					eq(checkRun.target, target),
					eq(checkRun.result, 'pass'),
					// A fail in one registration does not reopen what a pass in another one closed
					r.registration === null
						? isNull(checkRun.registration)
						: sql`lower(${checkRun.registration}) = ${r.registration.toLowerCase()}`
				)
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
 * How many runs wait for this runner: queued check runs of the projects it serves. A supervisor asks this
 * before it starts a container, so an idle queue starts nothing.
 */
export async function peekQueue(handle: DbHandle, auth: RunnerAuth): Promise<number> {
	if (!auth.projectIds.length) return 0;
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		// Only the runs this tool could claim are counted, so a tool is never woken for a run it cannot take
		const held = await runnerRegistrationPairs(tx, auth);
		const [a] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(checkRun)
			.where(
				and(
					eq(checkRun.orgId, auth.orgId),
					eq(checkRun.result, 'queued'),
					inArray(checkRun.projectId, auth.projectIds),
					registrationClaimable(held)
				)
			);
		return a?.n ?? 0;
	});
}

/**
 * Runs that are not finished and belong to a runner that has been offline for long: a runner restart gives them back. With `runIds` only
 * those runs are given back, so one process of a runner that stops never takes the live runs of another process of the same runner.
 */
export async function releaseRunnerRuns(handle: DbHandle, auth: RunnerAuth, runIds?: string[]) {
	if (runIds && runIds.length === 0) return 0;
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const back = await tx
			.update(checkRun)
			.set({ result: 'queued', runnerId: null, startedAt: null, lastBeatAt: null })
			.where(
				and(
					eq(checkRun.runnerId, auth.runnerId),
					eq(checkRun.result, 'running'),
					runIds ? inArray(checkRun.id, runIds) : undefined
				)
			)
			.returning({ id: checkRun.id });
		return back.length;
	});
}
