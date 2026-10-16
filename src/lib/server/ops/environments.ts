// ENVIRONMENTS, TEST ACCOUNT SECRETS AND RUNNERS: THE SETUP BROWSER CHECKS AND UI SHOTS NEED (SPEC 10, ADR-017, ADR-024)
// Environments say where a check may run and whether it may write. Secrets are test accounts, sealed with the org's data key and
// never returned by any call. Runners are the programs that run checks; a runner token is shown once and stored as a hash.

// -- TYPES -- //
import type { Ctx } from './context';
import type { DbHandle } from '../db/client';
// -- DEP-MODULES -- //
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import { checkRun, environment, project, runner, secret, uiShotRun } from '../db/schema';
import { withTenant } from '../db/tenant';
import { OpError, requireCap, run } from './context';
import { actorFields } from './items';
import { findProject } from './resolve';
import { openSecret, sealSecret } from '../secrets/vault';
import { appendOrgEvent } from './settings';
import { TARGETS } from '../db/schema/helpers';

// -- CONSTANTS -- //

export const RUNNER_PREFIX = 'afx_';
/** A key for ONE run: `afrun_<runs|shots>.<org>.<run>.<key>`. It opens that run's accounts, uploads and result, and nothing else. */
export const RUN_KEY_PREFIX = 'afrun_';
/** A runner that has not called for this long is offline. */
export const RUNNER_ONLINE_SECONDS = 90;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const environmentFields = z.object({
	project: z.string().min(1),
	name: z.string().min(1).max(40),
	url: z
		.string()
		.url()
		.max(300)
		.refine((u) => /^https?:\/\//i.test(u), 'Use an http or https address'),
	kind: z.enum(TARGETS),
	/** A production environment is read only unless writes are allowed on purpose (L28). */
	production: z.boolean().default(false),
	writeAllowed: z.boolean().default(false),
	/** Where a deployed environment says which commit it runs, for example /version. */
	versionPath: z
		.string()
		.regex(/^\/[^\s]{0,100}$/, 'Write the path starting with /')
		.nullish()
});
export const environmentInput = environmentFields.refine(
	(e) => !e.production || e.kind === 'deployed',
	{ message: 'Only a deployed environment can be production.', path: ['production'] }
);

export const accountInput = z.object({
	project: z.string().min(1),
	name: z.string().regex(ACCOUNT_NAME, 'Use lower case letters, digits, - or _ (up to 40)'),
	email: z.string().email().max(200),
	password: z.string().min(8, 'A test account password has at least 8 characters').max(500)
});

export const runnerInput = z.object({
	name: z.string().min(2).max(60),
	kind: z.enum(['local', 'hosted']),
	/** Project keys or ids the runner may take jobs from. */
	projects: z.array(z.string().min(1)).max(50).default([])
});

// -- FUNCTIONS: ENVIRONMENTS -- //

export async function listEnvironments(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'read', p.id);
		const rows = await tx
			.select()
			.from(environment)
			.where(eq(environment.projectId, p.id))
			.orderBy(asc(environment.kind), asc(environment.name));
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			url: r.url,
			kind: r.kind,
			production: r.production,
			writeAllowed: r.writeAllowed,
			versionPath: r.versionPath
		}));
	});
}

/** Adds an environment, or changes the one with the same name. */
export async function saveEnvironment(ctx: Ctx, raw: z.input<typeof environmentInput>) {
	const input = environmentInput.parse(raw);
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'manage', p.id);
		if (!p.webApp)
			throw new OpError(
				'INVALID',
				'Browser checks are for web app projects. Turn on "This project is a web app" in the project settings first.'
			);
		const values = {
			url: input.url.replace(/\/$/, ''),
			kind: input.kind,
			production: input.production,
			writeAllowed: input.writeAllowed,
			versionPath: input.versionPath ?? null
		};
		const [existing] = await tx
			.select()
			.from(environment)
			.where(and(eq(environment.projectId, p.id), eq(environment.name, input.name)));
		let id: string;
		if (existing) {
			await tx
				.update(environment)
				.set({ ...values, updatedAt: sql`now()`, version: sql`${environment.version} + 1` })
				.where(eq(environment.id, existing.id));
			id = existing.id;
		} else {
			const [row] = await tx
				.insert(environment)
				.values({ orgId: ctx.orgId, projectId: p.id, name: input.name, ...values })
				.returning({ id: environment.id });
			id = row.id;
		}
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actorFields(ctx),
			verb: 'environment.save',
			targetType: 'environment',
			targetId: id,
			after: {
				name: input.name,
				kind: input.kind,
				production: input.production,
				writeAllowed: values.writeAllowed
			} as never,
			undoable: false
		});
		return { id, created: !existing };
	});
}

export async function deleteEnvironment(ctx: Ctx, projectKey: string, name: string) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'manage', p.id);
		const gone = await tx
			.delete(environment)
			.where(and(eq(environment.projectId, p.id), eq(environment.name, name)))
			.returning({ id: environment.id });
		if (!gone.length) throw new OpError('NOT_FOUND', `No environment named "${name}".`);
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actorFields(ctx),
			verb: 'environment.delete',
			targetType: 'environment',
			targetId: gone[0].id,
			before: { name } as never,
			undoable: false
		});
		return { deleted: true };
	});
}

// -- FUNCTIONS: SECRETS (TEST ACCOUNTS) -- //

/** The names of a project's test accounts. Never the values: no call returns a secret. */
export async function listAccounts(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'write', p.id);
		const rows = await tx
			.select({ name: secret.name, updatedAt: secret.updatedAt })
			.from(secret)
			.where(eq(secret.projectId, p.id))
			.orderBy(asc(secret.name));
		return rows.map((r) => ({ name: r.name, updatedAt: r.updatedAt }));
	});
}

/** Stores a test account (email and password), sealed. A second call with the same name replaces it. */
export async function saveAccount(ctx: Ctx, raw: z.input<typeof accountInput>) {
	const input = accountInput.parse(raw);
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'manage', p.id);
		const sealed = await sealSecret(
			tx,
			{ orgId: ctx.orgId, projectId: p.id, name: input.name },
			JSON.stringify({ email: input.email, password: input.password }),
			ctx.services?.masterKey
		);
		const [existing] = await tx
			.select({ id: secret.id })
			.from(secret)
			.where(and(eq(secret.projectId, p.id), eq(secret.name, input.name)));
		if (existing)
			await tx
				.update(secret)
				.set({ ...sealed, updatedAt: sql`now()` })
				.where(eq(secret.id, existing.id));
		else
			await tx
				.insert(secret)
				.values({ orgId: ctx.orgId, projectId: p.id, name: input.name, ...sealed });
		// The event names the account and never holds a value
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actorFields(ctx),
			verb: 'secret.set',
			targetType: 'secret',
			after: { name: input.name } as never,
			undoable: false
		});
		return { name: input.name, replaced: Boolean(existing) };
	});
}

export async function deleteAccount(ctx: Ctx, projectKey: string, name: string) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'manage', p.id);
		const gone = await tx
			.delete(secret)
			.where(and(eq(secret.projectId, p.id), eq(secret.name, name)))
			.returning({ id: secret.id });
		if (!gone.length) throw new OpError('NOT_FOUND', `No test account named "${name}".`);
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actorFields(ctx),
			verb: 'secret.delete',
			targetType: 'secret',
			before: { name } as never,
			undoable: false
		});
		return { deleted: true };
	});
}

/**
 * Opens every test account of one project. Only the runner API calls this, for a run the runner holds, so a runner never sees
 * the secrets of another project or another org.
 */
export async function openProjectAccounts(
	ctx: Ctx,
	projectId: string,
	wanted?: string[]
): Promise<Record<string, { email: string; password: string }>> {
	return run(
		ctx,
		async (tx) => {
			const rows = await tx.select().from(secret).where(eq(secret.projectId, projectId));
			const out: Record<string, { email: string; password: string }> = {};
			for (const r of rows) {
				if (wanted && !wanted.includes(r.name)) continue;
				out[r.name] = JSON.parse(await openSecret(tx, r, ctx.services?.masterKey));
			}
			return out;
		},
		projectId
	);
}

// -- FUNCTIONS: RUNNERS -- //

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Registers a runner and returns its token once. Admins and owners only. */
export async function createRunner(ctx: Ctx, raw: z.input<typeof runnerInput>) {
	const input = runnerInput.parse(raw);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const ids: string[] = [];
		for (const key of input.projects) {
			const p = await findProject(tx, ctx, key);
			ids.push(p.id);
		}
		const secretPart = randomBytes(32).toString('base64url');
		const token = `${RUNNER_PREFIX}${ctx.orgId}.${secretPart}`;
		const [row] = await tx
			.insert(runner)
			.values({
				orgId: ctx.orgId,
				kind: input.kind,
				name: input.name,
				ownerId: ctx.actor.userId,
				projectIds: ids,
				tokenHash: hashOf(token)
			})
			.returning({ id: runner.id });
		await appendOrgEvent(tx, ctx, 'runner.create', {}, { name: input.name, kind: input.kind });
		return { id: row.id, token, name: input.name, kind: input.kind };
	});
}

export async function listRunners(ctx: Ctx) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const rows = await tx
			.select()
			.from(runner)
			.where(eq(runner.orgId, ctx.orgId))
			.orderBy(asc(runner.name));
		const projects = await tx
			.select({ id: project.id, key: project.key })
			.from(project)
			.where(eq(project.orgId, ctx.orgId));
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			kind: r.kind,
			ownerId: r.ownerId,
			projects: r.projectIds.map((id) => projects.find((p) => p.id === id)?.key ?? id),
			lastSeenAt: r.lastSeenAt,
			online: Boolean(
				r.lastSeenAt && Date.now() - r.lastSeenAt.getTime() < RUNNER_ONLINE_SECONDS * 1000
			)
		}));
	});
}

/**
 * Changes which projects a runner serves. A local runner's projects are changed only by its owner, who opts each one in; a
 * hosted runner's by any admin.
 */
export async function setRunnerProjects(ctx: Ctx, runnerId: string, projects: string[]) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const [r] = await tx
			.select()
			.from(runner)
			.where(and(eq(runner.id, runnerId), eq(runner.orgId, ctx.orgId)));
		if (!r) throw new OpError('NOT_FOUND', 'No such runner.');
		if (r.kind === 'local' && r.ownerId !== ctx.actor.userId)
			throw new OpError(
				'FORBIDDEN',
				'Only the owner of a local runner chooses the projects it serves.'
			);
		const ids: string[] = [];
		for (const key of projects) ids.push((await findProject(tx, ctx, key)).id);
		await tx
			.update(runner)
			.set({ projectIds: ids, updatedAt: sql`now()` })
			.where(eq(runner.id, r.id));
		await appendOrgEvent(
			tx,
			ctx,
			'runner.update',
			{ projects: r.projectIds.length },
			{ projects: ids.length }
		);
		return { id: r.id, projects: ids.length };
	});
}

export async function deleteRunner(ctx: Ctx, runnerId: string) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const gone = await tx
			.delete(runner)
			.where(and(eq(runner.id, runnerId), eq(runner.orgId, ctx.orgId)))
			.returning({ id: runner.id, name: runner.name });
		if (!gone.length) throw new OpError('NOT_FOUND', 'No such runner.');
		await appendOrgEvent(tx, ctx, 'runner.delete', { name: gone[0].name }, {});
		return { deleted: true };
	});
}

export type RunnerAuth = {
	runnerId: string;
	orgId: string;
	kind: 'local' | 'hosted';
	ownerId: string | null;
	projectIds: string[];
	name: string;
};

/** Checks a presented runner token. Returns null for anything wrong without saying why. */
export async function authenticateRunner(
	handle: DbHandle,
	presented: string
): Promise<RunnerAuth | null> {
	if (!presented.startsWith(RUNNER_PREFIX)) return null;
	const orgId = presented.slice(RUNNER_PREFIX.length).split('.')[0];
	if (!UUID.test(orgId) || presented.length < 70) return null;
	return withTenant(handle, { orgId }, async (tx) => {
		const [r] = await tx
			.select()
			.from(runner)
			.where(eq(runner.tokenHash, hashOf(presented)));
		if (!r || r.orgId !== orgId) return null;
		await tx
			.update(runner)
			.set({ lastSeenAt: sql`now()` })
			.where(eq(runner.id, r.id));
		return {
			runnerId: r.id,
			orgId,
			kind: r.kind,
			ownerId: r.ownerId,
			projectIds: r.projectIds,
			name: r.name
		};
	});
}

// -- RUN KEYS -- //

export type RunKeyAuth = RunnerAuth & { runKind: 'runs' | 'shots'; runId: string };

const runKeyMac = (
	secretKey: string,
	kind: string,
	orgId: string,
	runId: string,
	runnerId: string
) =>
	createHmac('sha256', `afb-run-key-v1:${secretKey}`)
		.update(`${kind}:${orgId}:${runId}:${runnerId}`)
		.digest('hex');

/**
 * The key handed to a throwaway container for the one run its supervisor took. It is worth nothing for any other run, and
 * nothing for this one once another runner holds it. The container never sees the runner token, which opens every run.
 */
export function makeRunKey(
	secretKey: string,
	kind: 'runs' | 'shots',
	auth: RunnerAuth,
	runId: string
): string {
	return `${RUN_KEY_PREFIX}${kind}.${auth.orgId}.${runId}.${runKeyMac(secretKey, kind, auth.orgId, runId, auth.runnerId)}`;
}

/** Checks a presented run key against the run's current holder. Null for anything wrong, with no reason given. */
export async function authenticateRunKey(
	handle: DbHandle,
	presented: string,
	secretKey: string | undefined
): Promise<RunKeyAuth | null> {
	if (!secretKey || !presented.startsWith(RUN_KEY_PREFIX)) return null;
	const [kind, orgId, runId, mac] = presented.slice(RUN_KEY_PREFIX.length).split('.');
	if ((kind !== 'runs' && kind !== 'shots') || !UUID.test(orgId ?? '') || !UUID.test(runId ?? ''))
		return null;
	if (!/^[0-9a-f]{64}$/.test(mac ?? '')) return null;
	return withTenant(handle, { orgId }, async (tx) => {
		const [row] =
			kind === 'runs'
				? await tx
						.select({ runnerId: checkRun.runnerId, orgId: checkRun.orgId })
						.from(checkRun)
						.where(eq(checkRun.id, runId))
				: await tx
						.select({ runnerId: uiShotRun.runnerId, orgId: uiShotRun.orgId })
						.from(uiShotRun)
						.where(eq(uiShotRun.id, runId));
		if (!row?.runnerId || row.orgId !== orgId) return null;
		const want = Buffer.from(runKeyMac(secretKey, kind, orgId, runId, row.runnerId));
		const got = Buffer.from(mac);
		if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
		const [r] = await tx.select().from(runner).where(eq(runner.id, row.runnerId));
		if (!r || r.orgId !== orgId) return null;
		return {
			runnerId: r.id,
			orgId,
			kind: r.kind,
			ownerId: r.ownerId,
			projectIds: r.projectIds,
			name: r.name,
			runKind: kind,
			runId
		};
	});
}
