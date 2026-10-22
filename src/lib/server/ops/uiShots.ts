// UI SHOTS AND DESIGN FIT: THE "UI CHANGES" TABLE, THE QUEUE OF SHOTS AND MEASURE RUNS, THE FLAGS AND THE PAGES' DATA (SPEC 10.1, ADR-031)
// A shots run opens each page of an item's table in the runner's browser, reads the real sizes, takes pictures and sends the
// numbers back. The server holds the project's scale and works out the flags itself, so what counts as "to fix" never depends on
// the runner. Pictures are private attachments. Every read is filtered by the item's visibility and the reader's role (L41).

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { DbHandle } from '../db/client';
import type { Ctx } from './context';
import type { RunnerAuth } from './environments';
import type { Target } from './checks';
// -- DEP-MODULES -- //
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import {
	UiChangeError,
	buildScale,
	flagsForPage,
	parseUiChangesTable,
	validateUiChange,
	type MeasuredLevels,
	type ScaleLevels,
	type UiChangeRow
} from '../../shared/uiShots';
import { appendEvent } from '../db/events';
import {
	attachment,
	check,
	designScale,
	environment,
	item,
	project,
	runner,
	secret,
	uiChange,
	uiShotRun
} from '../db/schema';
import type { ShotResult, UiFlag } from '../db/schema/integrations';
import { TARGETS } from '../db/schema/helpers';
import { withTenant } from '../db/tenant';
import { OpError, requireCap, run } from './context';
import {
	RUNNER_ONLINE_SECONDS,
	openProjectAccounts,
	reachesPrivate,
	toolEnvironment
} from './environments';
import { actorFields, canSeeItem } from './items';
import { findItem, findProject } from './resolve';
import { addAttachment } from './attachments';
import { DEFAULT_QUEUE_MINUTES, WAIT_MAX_SECONDS, isPrivateUrl, runnerCtx } from './checks';

// -- CONSTANTS -- //

/** A measure job needs at least this many reference pages to say anything about a scale. */
export const MIN_REFERENCE_PAGES = 3;
export const MAX_REFERENCE_PAGES = 15;
const RUNNING_TIMEOUT_MINUTES = 40;
/** A capture nobody claims for this long while no tool is online says so, instead of looking like it is taking pictures. */
const STALE_QUEUE_SECONDS = 120;
/** The newest captures (runs with pictures) kept for an item. */
export const KEEP_CAPTURES = 3;
const MAX_SHOT_WAITERS = 4;
export const TOOL_OFFLINE_TEXT =
	'The capture tool is not connected. Your agent connects it by itself the next time it captures, so there is nothing to do here.';

export const saveRowsInput = z
	.object({
		item: z.string().min(1),
		markdown: z.string().max(200_000).optional(),
		rows: z
			.array(
				z.object({
					page: z.string().min(1).max(300),
					stateRecipe: z.string().max(500).default(''),
					themes: z.array(z.string().min(1).max(30)).min(1).max(8),
					accounts: z.string().min(1).max(40).default('default'),
					siblings: z.array(z.string().min(1).max(300)).min(1).max(3),
					levels: z.array(z.string().min(1).max(200)).min(1).max(20),
					viewports: z.array(z.number().int()).min(1).max(2)
				})
			)
			.max(200)
			.optional()
	})
	.refine((v) => Boolean(v.markdown) !== Boolean(v.rows), {
		message: 'Send either the Markdown table or the rows, not both.'
	});

export const requestShotsInput = z.object({
	item: z.string().min(1),
	target: z.enum(TARGETS).optional(),
	/** Take fresh pictures even when nothing changed since the last capture. The Capture screens button asks for this; an agent's own request does not. */
	force: z.boolean().optional()
});

const resultIn = z.object({
	row: z.string().uuid().optional(),
	page: z.string().max(300),
	state: z.string().max(500).default(''),
	theme: z.string().max(30),
	viewport: z.number().int(),
	side: z.enum(['before', 'after', 'sibling']),
	of: z.string().max(300).optional(),
	values: z.record(z.string(), z.any()),
	image: z.string().uuid().optional()
});
export const shotsReport = z.object({
	state: z.enum(['done', 'failed']),
	reason: z.string().max(2000).optional(),
	beforeTarget: z.string().max(20).nullish(),
	beforeCommit: z.string().max(80).nullish(),
	afterCommit: z.string().max(80).nullish(),
	diffHash: z.string().max(80).nullish(),
	changedPaths: z.array(z.string().max(300)).max(2000).default([]),
	/** Plain sentences about the capture (a screen that was skipped, no Before, nothing changed). Stored as text, rendered as text. */
	notes: z.array(z.string().max(300)).max(20).default([]),
	/** The earlier capture this one repeats: the tool found the tree unchanged and built nothing. */
	reusedFrom: z.string().uuid().optional(),
	outsideCalls: z.number().int().min(0).default(0),
	abortedWrites: z.number().int().min(0).default(0),
	results: z.array(resultIn).max(2000).default([])
});

// -- FUNCTIONS: THE TABLE -- //

const themesOf = (p: { themes: { key: string }[] }) =>
	p.themes.length ? p.themes.map((t) => t.key) : ['light', 'dark'];

/** Replaces the item's "UI changes" table. Every row is checked first, so a bad row changes nothing. */
export async function saveUiChanges(ctx: Ctx, raw: z.input<typeof saveRowsInput>) {
	const input = saveRowsInput.parse(raw);
	let rows: UiChangeRow[];
	try {
		rows = input.markdown ? parseUiChangesTable(input.markdown) : (input.rows as UiChangeRow[]);
	} catch (e) {
		if (e instanceof UiChangeError) throw new OpError('INVALID', e.message);
		throw e;
	}
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, input.item);
		await requireCap(tx, ctx, 'write', it.projectId);
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		if (!p.webApp)
			throw new OpError(
				'INVALID',
				'UI shots are for web app projects. Turn on the web app switch in the project settings.'
			);
		rows.forEach((r, i) => {
			try {
				validateUiChange(r, { themes: themesOf(p) });
			} catch (e) {
				if (e instanceof UiChangeError) throw new OpError('INVALID', `Row ${i + 1}: ${e.message}`);
				throw e;
			}
		});
		await tx.delete(uiChange).where(eq(uiChange.itemId, it.id));
		if (rows.length)
			await tx.insert(uiChange).values(
				rows.map((r, i) => ({
					orgId: ctx.orgId,
					projectId: it.projectId,
					itemId: it.id,
					page: r.page,
					stateRecipe: r.stateRecipe,
					themes: r.themes,
					accounts: r.accounts,
					siblings: r.siblings,
					levels: r.levels,
					viewports: r.viewports,
					position: i
				}))
			);
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: it.projectId,
			itemId: it.id,
			...actorFields(ctx),
			verb: 'ui_change.save',
			targetType: 'ui_change',
			after: { rows: rows.length } as never,
			undoable: false
		});
		return { saved: rows.length };
	});
}

export async function listUiChanges(ctx: Ctx, itemName: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemName);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${itemName}".`);
		return rowsOf(tx, it.id);
	});
}

async function rowsOf(tx: Tx, itemId: string) {
	const rows = await tx
		.select()
		.from(uiChange)
		.where(eq(uiChange.itemId, itemId))
		.orderBy(asc(uiChange.position));
	return rows.map((r) => ({
		id: r.id,
		page: r.page,
		stateRecipe: r.stateRecipe,
		themes: r.themes,
		accounts: r.accounts,
		siblings: r.siblings,
		levels: r.levels,
		viewports: r.viewports
	}));
}

// -- FUNCTIONS: THE QUEUE -- //

type Env = typeof environment.$inferSelect;

/** The environment a shots run uses for a target. Never a production one: a shots run only reads, and production is left alone (L40). */
type ShotEnv = Pick<Env, 'name' | 'url' | 'kind' | 'production' | 'writeAllowed' | 'versionPath'>;
function shotEnv(envs: Env[], target: Target, runners: { kind: string }[]): ShotEnv | null {
	const usable = envs.filter(
		(e) =>
			e.kind === target &&
			!e.production &&
			runners.some((r) => reachesPrivate(r.kind) || !isPrivateUrl(e.url))
	);
	if (usable[0]) return usable[0];
	// The afb-checks tool brings its own preview, so a project needs no environment row for it
	if (target === 'preview' && runners.some((r) => r.kind === 'tool'))
		return toolEnvironment(target);
	return null;
}

async function onlineRunners(tx: Tx, orgId: string, projectId: string) {
	return tx
		.select({ kind: runner.kind })
		.from(runner)
		.where(
			and(
				eq(runner.orgId, orgId),
				sql`${projectId}::uuid = any(${runner.projectIds})`,
				sql`${runner.lastSeenAt} > now() - make_interval(secs => ${RUNNER_ONLINE_SECONDS})`
			)
		);
}

/** Marks shots runs that waited too long or were taken and never finished. */
export async function sweepShotRuns(tx: Tx, orgId: string, minutes: number) {
	// A capture nobody took for two minutes while no capture tool is online serving its project is not "taking pictures"
	await tx
		.update(uiShotRun)
		.set({ state: 'unavailable', finishedAt: sql`now()`, reason: TOOL_OFFLINE_TEXT })
		.where(
			and(
				eq(uiShotRun.orgId, orgId),
				eq(uiShotRun.state, 'queued'),
				eq(uiShotRun.kind, 'shots'),
				sql`${uiShotRun.createdAt} < now() - make_interval(secs => ${STALE_QUEUE_SECONDS})`,
				sql`not exists (select 1 from ${runner} where ${runner.orgId} = ${uiShotRun.orgId} and ${runner.kind} = 'tool' and ${uiShotRun.projectId} = any(${runner.projectIds}) and ${runner.lastSeenAt} > now() - make_interval(secs => ${RUNNER_ONLINE_SECONDS}))`
			)
		);
	await tx
		.update(uiShotRun)
		.set({
			state: 'timeout',
			finishedAt: sql`now()`,
			reason: `No runner took this run within ${minutes} minutes. Check that a runner that serves this project is online, then ask again.`
		})
		.where(
			and(
				eq(uiShotRun.orgId, orgId),
				eq(uiShotRun.state, 'queued'),
				sql`${uiShotRun.createdAt} < now() - make_interval(mins => ${minutes})`
			)
		);
	await tx
		.update(uiShotRun)
		.set({
			state: 'timeout',
			finishedAt: sql`now()`,
			reason: `The runner took this run and did not report back within ${RUNNING_TIMEOUT_MINUTES} minutes.`
		})
		.where(
			and(
				eq(uiShotRun.orgId, orgId),
				eq(uiShotRun.state, 'running'),
				sql`${uiShotRun.startedAt} < now() - make_interval(mins => ${RUNNING_TIMEOUT_MINUTES})`
			)
		);
}

async function queueRun(
	ctx: Ctx,
	tx: Tx,
	p: Omit<typeof project.$inferSelect, 'logo'>,
	itemId: string | null,
	kind: 'shots' | 'measure',
	asked: Target,
	force = false
) {
	const runners = await onlineRunners(tx, ctx.orgId, p.id);
	let ready: boolean;
	let reason: string | null = null;
	if (kind === 'shots') {
		// A capture is made by the afb-checks tool alone: it finds the screens, builds both versions and takes the pictures. It brings its own preview, so no environment is needed
		ready = runners.some((r) => r.kind === 'tool');
		if (!ready) reason = TOOL_OFFLINE_TEXT;
	} else {
		const envs = await tx.select().from(environment).where(eq(environment.projectId, p.id));
		const env = shotEnv(envs, asked, runners);
		ready = Boolean(env);
		if (!env) {
			const anyEnv = envs.find((e) => e.kind === asked);
			reason = !anyEnv
				? `This project has no ${asked} environment yet.`
				: anyEnv.production
					? `The ${asked} environment is production, and a UI shots run never opens production.`
					: !runners.length
						? 'No runner that serves this project is online.'
						: 'Only a hosted runner is online, and this environment is on a private address. Start a local runner.';
			const offer = TARGETS.filter((t) => t !== asked && shotEnv(envs, t, runners));
			if (offer.length) reason += ` You can run it on ${offer.join(' or ')} instead.`;
		}
	}
	const [row] = await tx
		.insert(uiShotRun)
		.values({
			orgId: ctx.orgId,
			projectId: p.id,
			itemId,
			kind,
			state: ready ? 'queued' : 'unavailable',
			requestedBy: ctx.actor.userId,
			target: asked,
			force,
			reason,
			finishedAt: ready ? null : sql`now()`
		})
		.returning();
	return { id: row.id, state: row.state, target: asked, reason };
}

/**
 * Asks for a capture of an item's screens. No pages are named: the tool works them out from the changed files. A capture that is already waiting or running for the item is
 * returned instead of a second one, so an agent that asks again never builds twice. Without `force` an unchanged tree is not built again (the tool says which capture it repeats).
 */
export async function requestShots(ctx: Ctx, raw: z.input<typeof requestShotsInput>) {
	const input = requestShotsInput.parse(raw);
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, input.item);
		const { role } = await requireCap(tx, ctx, 'write', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${input.item}".`);
		await sweepShotRuns(tx, ctx.orgId, ctx.services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES);
		const [open] = await tx
			.select()
			.from(uiShotRun)
			.where(
				and(
					eq(uiShotRun.itemId, it.id),
					eq(uiShotRun.kind, 'shots'),
					inArray(uiShotRun.state, ['queued', 'running'])
				)
			)
			.orderBy(desc(uiShotRun.createdAt))
			.limit(1);
		if (open) {
			// Fresh pictures asked for while a plain capture is still waiting: the waiting one is upgraded, so the button keeps its promise
			if (input.force && !open.force && open.state === 'queued')
				await tx.update(uiShotRun).set({ force: true }).where(eq(uiShotRun.id, open.id));
			return {
				id: open.id,
				state: open.state,
				target: (open.target ?? 'preview') as Target,
				reason: null as string | null,
				unavailable: false,
				existing: true
			};
		}
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		// The build preview is the only target (ADR-017): a saved personal target is not read here
		const asked = (input.target ?? 'preview') as Target;
		const queued = await queueRun(ctx, tx, p, it.id, 'shots', asked, input.force ?? false);
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: it.projectId,
			itemId: it.id,
			...actorFields(ctx),
			verb: 'ui_shots.request',
			targetType: 'ui_shot_run',
			targetId: queued.id,
			after: { target: asked, state: queued.state } as never,
			undoable: false
		});
		return { ...queued, unavailable: queued.state === 'unavailable', existing: false };
	});
}

/** Asks for a measure of the project's design scale from its reference pages. */
export async function requestMeasure(ctx: Ctx, projectKey: string, targetIn?: Target) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'manage', p.id);
		if (!p.webApp) throw new OpError('INVALID', 'The design scale is for web app projects.');
		if (p.referencePages.length < MIN_REFERENCE_PAGES)
			throw new OpError(
				'INVALID',
				`Name at least ${MIN_REFERENCE_PAGES} reference pages in the project settings first (up to ${MAX_REFERENCE_PAGES}). Now there ${p.referencePages.length === 1 ? 'is 1' : `are ${p.referencePages.length}`}.`
			);
		if (p.referencePages.length > MAX_REFERENCE_PAGES)
			throw new OpError('INVALID', `Use at most ${MAX_REFERENCE_PAGES} reference pages.`);
		await sweepShotRuns(tx, ctx.orgId, ctx.services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES);
		const queued = await queueRun(ctx, tx, p, null, 'measure', targetIn ?? 'preview');
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actorFields(ctx),
			verb: 'ui_shots.request',
			targetType: 'ui_shot_run',
			targetId: queued.id,
			after: { kind: 'measure', state: queued.state } as never,
			undoable: false
		});
		return { ...queued, unavailable: queued.state === 'unavailable' };
	});
}

/** The project's measured scale: for each theme and width, the levels and on how many pages each was seen. */
export async function getScale(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'read', p.id);
		const rows = await tx.select().from(designScale).where(eq(designScale.projectId, p.id));
		return {
			themes: themesOf(p),
			referencePages: p.referencePages,
			scales: rows.map((r) => ({
				theme: r.theme,
				viewport: r.viewport,
				levels: r.levels,
				seenOn: r.seenOn,
				runId: r.runId,
				updatedAt: r.updatedAt
			}))
		};
	});
}

// -- FUNCTIONS: THE RUNNER SIDE -- //

export type ShotsJob = {
	kind: 'shots' | 'measure';
	id: string;
	project: { id: string; key: string; themes: string[]; referencePages: string[] };
	item: { id: string; ref: string } | null;
	afterTarget: Target;
	afterUrl: string;
	/** Always null: the old version is the last commit, built by the tool itself. Kept for runners that still read it. */
	beforeTarget: null;
	beforeUrl: null;
	/** `auto` for a capture: the tool finds the screens itself, and `rows` holds only the pages someone pinned. A tool older than protocol 2 ignores it. */
	mode: 'auto';
	/** The last capture of the item with pictures, when the tool may skip an unchanged tree. Null when fresh pictures were asked for. */
	last: { hash: string; runId: string } | null;
	rows: (Omit<UiChangeRow, 'accounts'> & { id: string; accounts: string })[];
	/** theme, then width, then the scale of each level. Empty until a measure job has run. */
	scale: Record<string, Record<string, ScaleLevels>>;
	accounts: string[];
	/** Always true: a shots run aborts every write the page makes. */
	readOnly: true;
	/** The paths an item's own commits and checks cover, so the runner can say which changes belong to other work. */
	ownPaths: string[];
};

/** The newest capture of an item that has pictures and a hash, so the tool can tell an unchanged tree from a changed one. */
async function lastCapture(tx: Tx, itemId: string) {
	const [last] = await tx
		.select({ id: uiShotRun.id, hash: uiShotRun.diffHash })
		.from(uiShotRun)
		.where(
			and(
				eq(uiShotRun.itemId, itemId),
				eq(uiShotRun.kind, 'shots'),
				eq(uiShotRun.state, 'done'),
				sql`jsonb_array_length(${uiShotRun.imageAttachmentIds}) > 0`,
				sql`${uiShotRun.diffHash} is not null`,
				// A capture whose old version could not be built is not repeated: the next ask tries the Before again
				sql`${uiShotRun.beforeCommit} is not null`
			)
		)
		.orderBy(desc(uiShotRun.createdAt))
		.limit(1);
	return last?.hash ? { hash: last.hash, runId: last.id } : null;
}

/** Hands the oldest queued shots or measure run to a runner that serves its project. A capture goes to the afb-checks tool only. */
export async function claimShotsJob(
	handle: DbHandle,
	auth: RunnerAuth,
	services?: Ctx['services']
): Promise<ShotsJob | null> {
	if (!auth.projectIds.length) return null;
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		await sweepShotRuns(tx, auth.orgId, services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES);
		const waiting = await tx
			.select({ id: uiShotRun.id })
			.from(uiShotRun)
			.where(
				and(
					eq(uiShotRun.orgId, auth.orgId),
					eq(uiShotRun.state, 'queued'),
					inArray(uiShotRun.projectId, auth.projectIds)
				)
			)
			.orderBy(asc(uiShotRun.createdAt))
			.limit(25)
			.for('update', { skipLocked: true });
		for (const w of waiting) {
			const [r] = await tx.select().from(uiShotRun).where(eq(uiShotRun.id, w.id));
			// A capture finds its screens from the changed files and builds two versions: only the tool does that
			if (r.kind === 'shots' && auth.kind !== 'tool') continue;
			const envs = await tx
				.select()
				.from(environment)
				.where(eq(environment.projectId, r.projectId));
			const me = [{ kind: auth.kind }];
			const after =
				r.kind === 'shots'
					? toolEnvironment('preview')
					: shotEnv(envs, (r.target ?? 'preview') as Target, me);
			if (!after) continue;
			const [p] = await tx.select().from(project).where(eq(project.id, r.projectId));
			await tx
				.update(uiShotRun)
				.set({
					state: 'running',
					runnerId: auth.runnerId,
					startedAt: sql`now()`
				})
				.where(eq(uiShotRun.id, r.id));
			const rows = r.itemId ? await rowsOf(tx, r.itemId) : [];
			const scales = await tx
				.select()
				.from(designScale)
				.where(eq(designScale.projectId, r.projectId));
			const scale: ShotsJob['scale'] = {};
			for (const s of scales) (scale[s.theme] ??= {})[String(s.viewport)] = s.levels as ScaleLevels;
			const [it] = r.itemId ? await tx.select().from(item).where(eq(item.id, r.itemId)) : [];
			let ownPaths: string[] = [];
			if (r.itemId) {
				const checks = await tx
					.select({ paths: check.coveredPaths })
					.from(check)
					.where(eq(check.itemId, r.itemId));
				ownPaths = [...new Set(checks.flatMap((c) => c.paths))];
			}
			const accounts = await openAccountNames(tx, r.projectId);
			const last =
				r.kind === 'shots' && r.itemId && !r.force ? await lastCapture(tx, r.itemId) : null;
			return {
				kind: r.kind as 'shots' | 'measure',
				id: r.id,
				project: { id: p.id, key: p.key, themes: themesOf(p), referencePages: p.referencePages },
				item: it ? { id: it.id, ref: it.ref } : null,
				afterTarget: after.kind as Target,
				afterUrl: after.url,
				beforeTarget: null,
				beforeUrl: null,
				mode: 'auto' as const,
				last,
				rows,
				scale,
				accounts,
				readOnly: true as const,
				ownPaths
			};
		}
		return null;
	});
}

async function openAccountNames(tx: Tx, projectId: string) {
	const rows = await tx
		.select({ name: secret.name })
		.from(secret)
		.where(eq(secret.projectId, projectId));
	return rows.map((r) => r.name);
}

async function heldShots(tx: Tx, auth: RunnerAuth, runId: string) {
	const [r] = await tx
		.select()
		.from(uiShotRun)
		.where(and(eq(uiShotRun.id, runId), eq(uiShotRun.orgId, auth.orgId)));
	if (!r) throw new OpError('NOT_FOUND', 'No such run.');
	if (r.runnerId !== auth.runnerId)
		throw new OpError('FORBIDDEN', 'This run is held by another runner.');
	if (!auth.projectIds.includes(r.projectId))
		throw new OpError('FORBIDDEN', 'This runner no longer serves that project.');
	return r;
}

/** The test accounts for a shots run the runner holds. */
export async function shotsAccounts(
	handle: DbHandle,
	auth: RunnerAuth,
	runId: string,
	services?: Ctx['services']
) {
	const held = await withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const r = await heldShots(tx, auth, runId);
		if (r.state !== 'running') throw new OpError('CONFLICT', 'The run is not running.');
		return r;
	});
	const ctx = runnerCtx(handle, auth, held.requestedBy ?? auth.ownerId ?? '', services);
	return openProjectAccounts(ctx, held.projectId);
}

/** Stores one picture of a shots run as a private attachment of the item. */
export async function storeShotImage(
	handle: DbHandle,
	auth: RunnerAuth,
	runId: string,
	file: { filename: string; caption: string; bytes: Uint8Array },
	services?: Ctx['services']
) {
	const held = await withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const r = await heldShots(tx, auth, runId);
		if (r.state !== 'running') throw new OpError('CONFLICT', 'The run is not running.');
		if (!r.itemId) throw new OpError('INVALID', 'A measure run takes no pictures.');
		return r;
	});
	if (!/\.(jpe?g)$/i.test(file.filename))
		throw new OpError('INVALID', 'UI shots are stored as JPEG pictures.');
	const ctx = runnerCtx(handle, auth, held.requestedBy ?? auth.ownerId ?? '', services);
	const { attachment } = await addAttachment(
		ctx,
		{
			item: held.itemId!,
			filename: file.filename,
			caption: file.caption,
			kind: 'ui-shot',
			refs: [runId],
			visibility: 'private'
		},
		file.bytes
	);
	return { attachmentId: attachment.id };
}

/**
 * Keeps the newest KEEP_CAPTURES captures of an item (runs that are done and have pictures) and drops the rest. Runs that are not captures (failed, stuck, unavailable, a repeat of an
 * unchanged tree) never push a capture out; they are kept only as the single newest one after the newest capture, so the tab can say what happened last. A picture is
 * deleted only when it is this item's own ui-shot attachment whose runs are all dropped: the ids a tool reported are never used for this.
 */
async function pruneCaptures(tx: Tx, itemId: string) {
	const runs = await tx
		.select({
			id: uiShotRun.id,
			state: uiShotRun.state,
			images: uiShotRun.imageAttachmentIds,
			createdAt: uiShotRun.createdAt
		})
		.from(uiShotRun)
		.where(and(eq(uiShotRun.itemId, itemId), eq(uiShotRun.kind, 'shots')))
		.orderBy(desc(uiShotRun.createdAt));
	const isCapture = (x: (typeof runs)[number]) => x.state === 'done' && x.images.length > 0;
	const captures = runs.filter(isCapture);
	const others = runs.filter((x) => !isCapture(x) && x.state !== 'queued' && x.state !== 'running');
	const newest = captures[0];
	const keepOther = newest ? others.find((x) => x.createdAt > newest.createdAt) : others[0];
	const gone = new Set([
		...captures.slice(KEEP_CAPTURES).map((x) => x.id),
		...others.filter((x) => x !== keepOther).map((x) => x.id)
	]);
	if (!gone.size) return;
	const pictures = await tx
		.select({ id: attachment.id, refs: attachment.refs })
		.from(attachment)
		.where(
			and(
				eq(attachment.itemId, itemId),
				eq(attachment.kind, 'ui-shot'),
				isNull(attachment.deletedAt)
			)
		);
	const dead = pictures.filter((a) => a.refs.length > 0 && a.refs.every((ref) => gone.has(ref)));
	if (dead.length)
		await tx
			.update(attachment)
			.set({ deletedAt: sql`now()` })
			.where(
				inArray(
					attachment.id,
					dead.map((a) => a.id)
				)
			);
	await tx.delete(uiShotRun).where(inArray(uiShotRun.id, [...gone]));
}

const underPath = (changed: string, own: string) =>
	changed === own ||
	changed.startsWith(own.endsWith('/') ? own : `${own}/`) ||
	own.startsWith(`${changed}/`);

/** Records a finished shots or measure run, works out the flags from the project's scale, and stores the measured scale. */
export async function finishShotsRun(
	handle: DbHandle,
	auth: RunnerAuth,
	runId: string,
	raw: z.input<typeof shotsReport>
) {
	const report = shotsReport.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const r = await heldShots(tx, auth, runId);
		if (r.state !== 'running')
			throw new OpError('CONFLICT', `The run already finished (${r.state}).`);
		if (report.state === 'failed') {
			await tx
				.update(uiShotRun)
				.set({
					state: 'failed',
					reason: report.reason ?? 'The run failed.',
					finishedAt: sql`now()`,
					outsideCalls: report.outsideCalls,
					abortedWrites: report.abortedWrites
				})
				.where(eq(uiShotRun.id, runId));
			// Only the newest failure is kept, so a run of failures never crowds the tab
			if (r.kind === 'shots' && r.itemId) await pruneCaptures(tx, r.itemId);
			return { id: runId, state: 'failed' as const, flags: [] as UiFlag[], scaleSaved: false };
		}
		const noteText = report.notes.join('\n');
		// A report the board will not believe fails the run with the reason, so the person is told and can ask again, instead of a run that stays "running" for 40 minutes
		const reject = async (message: string) => {
			await tx
				.update(uiShotRun)
				.set({ state: 'failed', reason: message, finishedAt: sql`now()` })
				.where(eq(uiShotRun.id, runId));
			if (r.itemId) await pruneCaptures(tx, r.itemId);
			return { id: runId, state: 'failed' as const, flags: [] as UiFlag[], scaleSaved: false };
		};
		if (r.kind === 'shots') {
			// A capture that reports nothing at all comes from a tool that does not know how to capture: it is told to update, never shown as a green empty run
			if (!report.results.length && !report.notes.length && !report.reusedFrom)
				return reject(
					'The capture tool sent an empty report. Ask your agent to update the tool (the /flow-check skill has the steps).'
				);
			if (report.reusedFrom) {
				// A repeat is believed only when the capture it names is this item's own and has the very hash the tool reports
				const [src] = r.itemId
					? await tx
							.select()
							.from(uiShotRun)
							.where(
								and(
									eq(uiShotRun.id, report.reusedFrom),
									eq(uiShotRun.itemId, r.itemId),
									eq(uiShotRun.state, 'done')
								)
							)
					: [];
				// Fresh pictures that were asked for are never a repeat
				if (
					r.force ||
					!src ||
					!src.imageAttachmentIds.length ||
					!src.diffHash ||
					src.diffHash !== report.diffHash
				)
					return reject(
						'The tool said nothing changed, but the capture it named is not a capture of this tree. Ask for a fresh capture.'
					);
				// The repeat holds no pictures of its own, so nothing is shared between two runs and pruning one never breaks the other
				await tx
					.update(uiShotRun)
					.set({
						state: 'done',
						reason: noteText || 'Nothing changed since the last capture.',
						beforeTarget: src.beforeTarget,
						beforeCommit: src.beforeCommit,
						afterCommit: report.afterCommit ?? src.afterCommit,
						diffHash: report.diffHash ?? null,
						changedPaths: src.changedPaths,
						results: [],
						flags: [],
						imageAttachmentIds: [],
						finishedAt: sql`now()`
					})
					.where(eq(uiShotRun.id, runId));
				await pruneCaptures(tx, r.itemId!);
				return { id: runId, state: 'done' as const, flags: [] as UiFlag[], scaleSaved: false };
			}
		}
		// A picture counts only when it is this run's own upload to this item: an id the tool names that is anything else is dropped, never trusted
		const named = [
			...new Set(report.results.map((x) => x.image).filter((x): x is string => Boolean(x)))
		];
		const ownPictures = new Set<string>();
		if (named.length && r.itemId) {
			const found = await tx
				.select({ id: attachment.id, refs: attachment.refs })
				.from(attachment)
				.where(
					and(
						inArray(attachment.id, named),
						eq(attachment.kind, 'ui-shot'),
						eq(attachment.itemId, r.itemId),
						isNull(attachment.deletedAt)
					)
				);
			for (const a of found) if (a.refs.includes(runId)) ownPictures.add(a.id);
		}
		const results = report.results.map((x) =>
			x.image && !ownPictures.has(x.image) ? { ...x, image: undefined } : x
		) as ShotResult[];
		const flags: UiFlag[] = [];
		let scaleSaved = false;
		if (r.kind === 'measure') {
			const byKey = new Map<
				string,
				{ theme: string; viewport: number; samples: { page: string; measured: MeasuredLevels }[] }
			>();
			for (const x of results) {
				const k = `${x.theme}|${x.viewport}`;
				const slot = byKey.get(k) ?? { theme: x.theme, viewport: x.viewport, samples: [] };
				slot.samples.push({ page: x.page, measured: x.values as unknown as MeasuredLevels });
				byKey.set(k, slot);
			}
			for (const slot of byKey.values()) {
				const built = buildScale(slot.samples);
				await tx
					.insert(designScale)
					.values({
						orgId: auth.orgId,
						projectId: r.projectId,
						theme: slot.theme,
						viewport: slot.viewport,
						levels: built.levels,
						seenOn: built.seenOn,
						runId
					})
					.onConflictDoUpdate({
						target: [designScale.projectId, designScale.theme, designScale.viewport],
						set: { levels: built.levels, seenOn: built.seenOn, runId, updatedAt: sql`now()` }
					});
				for (const level of built.unused)
					flags.push({
						level,
						kind: 'unused',
						text: `${level} was seen on ${built.seenOn[level]} page${built.seenOn[level] === 1 ? '' : 's'}, fewer than 3, so the scale does not use it`,
						theme: slot.theme,
						viewport: slot.viewport
					});
				scaleSaved = true;
			}
		} else {
			const rows = r.itemId
				? await tx.select().from(uiChange).where(eq(uiChange.itemId, r.itemId))
				: [];
			const scales = await tx
				.select()
				.from(designScale)
				.where(eq(designScale.projectId, r.projectId));
			for (const x of results.filter((y) => y.side === 'after')) {
				const row = rows.find((q) => q.id === x.row);
				if (!row) continue;
				const siblings = results
					.filter(
						(y) =>
							y.side === 'sibling' &&
							y.row === x.row &&
							y.theme === x.theme &&
							y.viewport === x.viewport
					)
					.map((y) => y.values as unknown as MeasuredLevels);
				const scale = scales.find((s) => s.theme === x.theme && s.viewport === x.viewport)
					?.levels as ScaleLevels | undefined;
				for (const f of flagsForPage(
					row.levels,
					x.values as unknown as MeasuredLevels,
					siblings,
					scale
				))
					flags.push({ ...f, page: x.page, theme: x.theme, viewport: x.viewport });
			}
		}
		// Changes that belong to other work: not under any path this item's checks cover
		let own: string[] = [];
		if (r.itemId) {
			const checks = await tx
				.select({ paths: check.coveredPaths })
				.from(check)
				.where(eq(check.itemId, r.itemId));
			own = checks.flatMap((c) => c.paths);
		}
		const foreignPaths = own.length
			? report.changedPaths.filter((c) => !own.some((o) => underPath(c, o)))
			: [];
		const images = results.map((x) => x.image).filter((x): x is string => Boolean(x));
		await tx
			.update(uiShotRun)
			.set({
				state: 'done',
				// A finished capture keeps its notes where a failed run keeps its reason
				reason: noteText || (report.reason ?? null),
				beforeTarget: report.beforeTarget ?? r.beforeTarget,
				beforeCommit: report.beforeCommit ?? null,
				afterCommit: report.afterCommit ?? null,
				diffHash: report.diffHash ?? null,
				changedPaths: report.changedPaths,
				foreignPaths,
				results,
				flags,
				imageAttachmentIds: images,
				outsideCalls: report.outsideCalls,
				abortedWrites: report.abortedWrites,
				finishedAt: sql`now()`
			})
			.where(eq(uiShotRun.id, runId));
		if (r.kind === 'shots' && r.itemId) await pruneCaptures(tx, r.itemId);
		await appendEvent(tx, {
			orgId: auth.orgId,
			projectId: r.projectId,
			itemId: r.itemId,
			actorUserId: r.requestedBy,
			actorLabel: `Runner ${auth.name}`,
			tool: 'browser-check',
			verb: r.kind === 'measure' ? 'ui_scale.measure' : 'ui_shots.finish',
			targetType: 'ui_shot_run',
			targetId: runId,
			after: { flags: flags.length, pages: results.length } as never,
			undoable: false
		});
		return { id: runId, state: 'done' as const, flags, scaleSaved };
	});
}

// -- FUNCTIONS: WHAT THE PAGES SHOW -- //

type RunRow = typeof uiShotRun.$inferSelect;

const runView = (r: RunRow) => ({
	id: r.id,
	kind: r.kind,
	state: r.state,
	target: r.target,
	beforeTarget: r.beforeTarget,
	beforeCommit: r.beforeCommit,
	afterCommit: r.afterCommit,
	diffHash: r.diffHash,
	changedPaths: r.changedPaths,
	foreignPaths: r.foreignPaths,
	results: r.results,
	flags: r.flags,
	// The screens that were shot (after pictures), counted before anything is stripped for a reader who may not see them
	screens: new Set(r.results.filter((x) => x.side === 'after').map((x) => `${x.page}|${x.state}`))
		.size,
	// A finished capture keeps its notes in the same column a failed run keeps its reason
	notes: r.state === 'done' ? (r.reason ?? '').split('\n').filter(Boolean) : [],
	reason: r.state === 'done' ? null : r.reason,
	outsideCalls: r.outsideCalls,
	abortedWrites: r.abortedWrites,
	createdAt: r.createdAt,
	finishedAt: r.finishedAt
});

/** Private pictures are for members, admins and owners. A viewer sees a summary only: how many screens, when, and in what state. */
const mayPictures = (role: string | null) =>
	role === 'owner' || role === 'admin' || role === 'member';

/** What a reader who may not see pictures gets of a run: the counts and nothing that names a page, a path, a note or a call. */
const summaryOnly = (v: ReturnType<typeof runView>) => ({
	...v,
	results: [] as ShotResult[],
	flags: [] as UiFlag[],
	notes: [] as string[],
	changedPaths: [] as string[],
	foreignPaths: [] as string[],
	outsideCalls: 0,
	abortedWrites: 0,
	// No commit, hash or tool text for a reader who may not see the pictures
	beforeCommit: null,
	afterCommit: null,
	diffHash: null,
	reason: null
});

/** The item's UI shots tab: its newest captures (with the one run that came after them, if it was not a capture) and whether a capture can be asked for now. */
export async function itemShots(ctx: Ctx, itemName: string) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemName);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${itemName}".`);
		await sweepShotRuns(tx, ctx.orgId, ctx.services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES);
		const pictures = mayPictures(role);
		const runs = await tx
			.select()
			.from(uiShotRun)
			.where(and(eq(uiShotRun.itemId, it.id), eq(uiShotRun.kind, 'shots')))
			.orderBy(desc(uiShotRun.createdAt))
			.limit(KEEP_CAPTURES + 3);
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		const toolOnline = (await onlineRunners(tx, ctx.orgId, it.projectId)).some(
			(r) => r.kind === 'tool'
		);
		// A checksum for each picture, so the tab can tell a screen that looks the same before and after from one that changed
		const shown = pictures
			? [...new Set(runs.flatMap((r) => r.imageAttachmentIds))]
			: ([] as string[]);
		const sums: Record<string, string> = {};
		if (shown.length)
			for (const a of await tx
				.select({ id: attachment.id, checksum: attachment.checksum })
				.from(attachment)
				.where(inArray(attachment.id, shown)))
				sums[a.id] = a.checksum;
		return {
			item: { id: it.id, ref: it.ref },
			webApp: p.webApp,
			themes: themesOf(p),
			toolOnline,
			// A capture can be asked for when the role may write and a tool that serves the project is online
			canRun: role !== 'viewer' && role !== 'guest' && toolOnline,
			canSeePictures: pictures,
			sums,
			// Pages someone pinned by hand (optional: captures find their own screens)
			rows: pictures ? await rowsOf(tx, it.id) : [],
			runs: runs.map((r) => {
				const v = runView(r);
				return pictures ? v : summaryOnly(v);
			})
		};
	});
}

const SHOT_OPEN = new Set(['queued', 'running']);
const shotWaiters = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One capture run of an item the reader may see, as the page and the agent read it. */
export async function getShotsRun(ctx: Ctx, runId: string) {
	return run(ctx, async (tx) => {
		const [r] = await tx.select().from(uiShotRun).where(eq(uiShotRun.id, runId));
		if (!r || !r.itemId) throw new OpError('NOT_FOUND', 'No such capture.');
		const it = await findItem(tx, ctx, r.itemId);
		const { role } = await requireCap(tx, ctx, 'read', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId)) throw new OpError('NOT_FOUND', 'No such capture.');
		const v = runView(r);
		return { ...(mayPictures(role) ? v : summaryOnly(v)), item: it.ref };
	});
}

/**
 * Waits for a capture to finish: each look is its own short transaction with a sleep between, and at most a few waiters per organisation run at once. Returns the run and whether
 * it finished; unfinished means look again with ui_shots_get.
 */
export async function waitForShotsRun(
	ctx: Ctx,
	input: { run: string; seconds: number },
	opts: { pollMs?: number } = {}
) {
	let view = await getShotsRun(ctx, input.run);
	if (!SHOT_OPEN.has(view.state) || input.seconds <= 0)
		return { run: view, finished: !SHOT_OPEN.has(view.state) };
	const now = shotWaiters.get(ctx.orgId) ?? 0;
	if (now >= MAX_SHOT_WAITERS)
		throw new OpError(
			'RATE_LIMITED',
			'Too many captures are being waited for at once. Try again in a moment.',
			{
				limit: MAX_SHOT_WAITERS
			}
		);
	shotWaiters.set(ctx.orgId, now + 1);
	try {
		const until = Date.now() + Math.min(input.seconds, WAIT_MAX_SECONDS) * 1000;
		const poll = opts.pollMs ?? 1500;
		while (SHOT_OPEN.has(view.state) && Date.now() < until) {
			await sleep(Math.min(poll, Math.max(0, until - Date.now())));
			view = await getShotsRun(ctx, input.run);
		}
	} finally {
		const left = (shotWaiters.get(ctx.orgId) ?? 1) - 1;
		if (left <= 0) shotWaiters.delete(ctx.orgId);
		else shotWaiters.set(ctx.orgId, left);
	}
	return { run: view, finished: !SHOT_OPEN.has(view.state) };
}
