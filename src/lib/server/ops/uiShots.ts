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
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
	check,
	commitLink,
	designScale,
	environment,
	item,
	project,
	runner,
	secret,
	uiChange,
	uiShotRun,
	userPref
} from '../db/schema';
import type { ShotResult, UiFlag } from '../db/schema/integrations';
import { TARGETS } from '../db/schema/helpers';
import { withTenant } from '../db/tenant';
import { OpError, requireCap, run } from './context';
import { RUNNER_ONLINE_SECONDS, openProjectAccounts } from './environments';
import { actorFields, canSeeItem } from './items';
import { findItem, findProject } from './resolve';
import { addAttachment } from './attachments';
import { DEFAULT_QUEUE_MINUTES, isPrivateUrl, runnerCtx } from './checks';

// -- CONSTANTS -- //

/** A measure job needs at least this many reference pages to say anything about a scale. */
export const MIN_REFERENCE_PAGES = 3;
export const MAX_REFERENCE_PAGES = 15;
const RUNNING_TIMEOUT_MINUTES = 40;

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
	target: z.enum(TARGETS).optional()
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
				'UI changes are for web app projects. Turn on the web app switch in the project settings.'
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
function shotEnv(envs: Env[], target: Target, runners: { kind: string }[]): Env | null {
	const usable = envs.filter(
		(e) =>
			e.kind === target &&
			!e.production &&
			runners.some((r) => r.kind === 'local' || !isPrivateUrl(e.url))
	);
	return usable[0] ?? null;
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
	asked: Target
) {
	const envs = await tx.select().from(environment).where(eq(environment.projectId, p.id));
	const runners = await onlineRunners(tx, ctx.orgId, p.id);
	const env = shotEnv(envs, asked, runners);
	let reason: string | null = null;
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
	const [row] = await tx
		.insert(uiShotRun)
		.values({
			orgId: ctx.orgId,
			projectId: p.id,
			itemId,
			kind,
			state: env ? 'queued' : 'unavailable',
			requestedBy: ctx.actor.userId,
			target: asked,
			reason,
			finishedAt: env ? null : sql`now()`
		})
		.returning();
	return { id: row.id, state: row.state, target: asked, reason };
}

/** Asks for a UI shots run of an item: the table's pages, before on the deployed site (when it can) and after on the target. */
export async function requestShots(ctx: Ctx, raw: z.input<typeof requestShotsInput>) {
	const input = requestShotsInput.parse(raw);
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, input.item);
		const { role } = await requireCap(tx, ctx, 'write', it.projectId);
		if (!canSeeItem(role, it, ctx.actor.userId))
			throw new OpError('NOT_FOUND', `No item named "${input.item}".`);
		const rows = await rowsOf(tx, it.id);
		if (!rows.length)
			throw new OpError('INVALID', `${it.ref} has no UI changes table yet. Save one first.`);
		await sweepShotRuns(tx, ctx.orgId, ctx.services?.runnerQueueMinutes ?? DEFAULT_QUEUE_MINUTES);
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		const [pref] = await tx.select().from(userPref).where(eq(userPref.userId, ctx.actor.userId));
		// The default is the build preview. The dev server is chosen by hand only (ADR-017)
		const asked = (input.target ??
			(pref?.checkTarget === 'deployed'
				? 'deployed'
				: p.defaultTarget === 'dev'
					? 'preview'
					: p.defaultTarget)) as Target;
		const queued = await queueRun(ctx, tx, p, it.id, 'shots', asked);
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
		return { ...queued, unavailable: queued.state === 'unavailable' };
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
	beforeTarget: Target | null;
	beforeUrl: string | null;
	rows: (Omit<UiChangeRow, 'accounts'> & { id: string; accounts: string })[];
	/** theme, then width, then the scale of each level. Empty until a measure job has run. */
	scale: Record<string, Record<string, ScaleLevels>>;
	accounts: string[];
	/** Always true: a shots run aborts every write the page makes. */
	readOnly: true;
	/** The paths an item's own commits and checks cover, so the runner can say which changes belong to other work. */
	ownPaths: string[];
};

/** Hands the oldest queued shots or measure run to a runner that serves its project and can reach its address. */
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
			const envs = await tx
				.select()
				.from(environment)
				.where(eq(environment.projectId, r.projectId));
			const me = [{ kind: auth.kind }];
			const after = shotEnv(envs, (r.target ?? 'preview') as Target, me);
			if (!after) continue;
			// Before: the deployed site, when it is not production and not the same environment as after
			const before = after.kind === 'deployed' ? null : shotEnv(envs, 'deployed', me);
			const [p] = await tx.select().from(project).where(eq(project.id, r.projectId));
			await tx
				.update(uiShotRun)
				.set({
					state: 'running',
					runnerId: auth.runnerId,
					startedAt: sql`now()`,
					beforeTarget: before ? 'deployed' : null
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
				const commits = await tx
					.select({ files: commitLink.files })
					.from(commitLink)
					.where(eq(commitLink.itemId, r.itemId));
				const checks = await tx
					.select({ paths: check.coveredPaths })
					.from(check)
					.where(eq(check.itemId, r.itemId));
				ownPaths = [
					...new Set([...commits.flatMap((c) => c.files), ...checks.flatMap((c) => c.paths)])
				];
			}
			const accounts = await openAccountNames(tx, r.projectId);
			return {
				kind: r.kind as 'shots' | 'measure',
				id: r.id,
				project: { id: p.id, key: p.key, themes: themesOf(p), referencePages: p.referencePages },
				item: it ? { id: it.id, ref: it.ref } : null,
				afterTarget: after.kind as Target,
				afterUrl: after.url,
				beforeTarget: before ? 'deployed' : null,
				beforeUrl: before?.url ?? null,
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
			return { id: runId, state: 'failed' as const, flags: [] as UiFlag[], scaleSaved: false };
		}
		const results = report.results as ShotResult[];
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
		// Changes that belong to other work: not under any path this item's commits or checks touch
		let own: string[] = [];
		if (r.itemId) {
			const commits = await tx
				.select({ files: commitLink.files })
				.from(commitLink)
				.where(eq(commitLink.itemId, r.itemId));
			const checks = await tx
				.select({ paths: check.coveredPaths })
				.from(check)
				.where(eq(check.itemId, r.itemId));
			own = [...commits.flatMap((c) => c.files), ...checks.flatMap((c) => c.paths)];
		}
		const foreignPaths = own.length
			? report.changedPaths.filter((c) => !own.some((o) => underPath(c, o)))
			: [];
		const images = results.map((x) => x.image).filter((x): x is string => Boolean(x));
		await tx
			.update(uiShotRun)
			.set({
				state: 'done',
				reason: report.reason ?? null,
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
	reason: r.reason,
	outsideCalls: r.outsideCalls,
	abortedWrites: r.abortedWrites,
	createdAt: r.createdAt,
	finishedAt: r.finishedAt
});

/** Private pictures are for members, admins and owners. A viewer sees the measurements only. */
const mayPictures = (role: string | null) =>
	role === 'owner' || role === 'admin' || role === 'member';

/** The item's UI CHANGES tab: its table and its newest runs. */
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
			.where(eq(uiShotRun.itemId, it.id))
			.orderBy(desc(uiShotRun.createdAt))
			.limit(6);
		const [p] = await tx.select().from(project).where(eq(project.id, it.projectId));
		return {
			item: { id: it.id, ref: it.ref },
			webApp: p.webApp,
			themes: themesOf(p),
			canRun: role !== 'viewer' && role !== 'guest',
			canSeePictures: pictures,
			rows: await rowsOf(tx, it.id),
			runs: runs.map((r) => {
				const v = runView(r);
				return pictures ? v : { ...v, results: v.results.map((x) => ({ ...x, image: undefined })) };
			})
		};
	});
}
