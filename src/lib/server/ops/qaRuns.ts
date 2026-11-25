// QA RUNS: A RUN IS AN ORDINARY ITEM WITH ONE STEP PER FEATURE; RESULTS ARE RECORDED IN BATCHES AND A BROKEN ONE FILES ONE BUG PER CAUSE (AFB-20261125-0442)
// The agent drives its own browser; AFB never fetches the target. A target that keeps real data never takes writes.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
import type { QaTarget } from '../db/schema';
// IMPORTED DEP-MODULES
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { appendEvent } from '../db/events';
import {
	item,
	project,
	qaBug,
	qaFeature,
	qaPlanFeature,
	qaResult,
	qaRun,
	qaSettings,
	screen,
	screenAnnotation,
	task
} from '../db/schema';
import { qaResultInput, qaRunStartInput } from '../db/zod';
import { OpError, idempotent, rateLimit, requireCap, run, runCall, subRequest } from './context';
import { createTask } from './docs';
import { actorFields, createItem } from './items';
import {
	QA_LOCAL_PREVIEW,
	causeKeyOf,
	liveCaseKeys,
	maskEntered,
	maskObserved,
	requireQaRead,
	statusesOf
} from './qa';
import { findItem, findProject, mayView, visibleItemSql } from './resolve';

// -- CONSTANTS -- //

const STATUS_ORDER: Record<string, number> = {
	broken: 0,
	needs_retest: 1,
	not_tested: 2,
	could_not_test: 3,
	works: 4
};
const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

// -- FUNCTIONS -- //

/** Runs a QA verb inside one call transaction, so the run item, its task and the QA rows are written together or not at all. */
function inCall<T>(ctx: Ctx, fn: (c: Ctx) => Promise<T>): Promise<T> {
	return ctx.tx ? fn(ctx) : runCall(ctx, fn);
}

/** Whether a target may be used, and whether it holds throwaway data a run may write to. */
export function targetFor(origin: string, targets: QaTarget[]): { writes: boolean } | null {
	if (QA_LOCAL_PREVIEW.includes(origin)) return { writes: false };
	const t = targets.find((x) => x.origin === origin);
	return t ? { writes: t.writes } : null;
}

/** The origin of an address, in lowercase, or INVALID. */
export function originOf(address: string): string {
	try {
		return new URL(address).origin.toLowerCase();
	} catch {
		throw new OpError('INVALID', `"${address}" is not a web address.`);
	}
}

/**
 * Starts a QA run: checks the target, numbers the run, creates its item with one step per feature (broken and changed
 * features first) and writes the run row, all in one transaction.
 */
export async function startRun(ctx: Ctx, raw: z.input<typeof qaRunStartInput>) {
	const input = qaRunStartInput.parse(raw);
	return inCall(ctx, (c) =>
		run(c, async (tx) =>
			idempotent(c, tx, async () => {
				const proj = await findProject(tx, c, input.project);
				await requireCap(tx, c, 'write', proj.id);
				await rateLimit(tx, c, 'write');
				const origin = originOf(input.target);
				const [settings] = await tx
					.select()
					.from(qaSettings)
					.where(eq(qaSettings.projectId, proj.id));
				const target = targetFor(origin, (settings?.targets ?? []) as QaTarget[]);
				if (!target)
					throw new OpError(
						'INVALID',
						`${origin} is not one of this project's test addresses. An owner or an admin adds it on the Testing page; until then use the build preview at ${QA_LOCAL_PREVIEW[0]}.`,
						{ origin }
					);
				const rows = await tx
					.select()
					.from(qaFeature)
					.where(
						and(
							eq(qaFeature.projectId, proj.id),
							isNull(qaFeature.removedAt),
							input.features?.length ? inArray(qaFeature.key, input.features) : undefined
						)
					);
				// A run item holds at most 200 steps, one per feature
				if (rows.length > 200)
					throw new OpError(
						'INVALID',
						`This run would test ${rows.length} features; a run holds 200 at most. Name the features or an area to test.`
					);
				if (rows.length === 0)
					throw new OpError(
						'INVALID',
						input.features?.length
							? 'None of those features is on the map.'
							: 'There is no feature on the map yet. Run /flow-qa discover first.'
					);
				const statuses = await statusesOf(tx, proj.id, rows, { viewer: c.actor.userId });
				const ordered = [...rows].sort(
					(a, b) =>
						STATUS_ORDER[statuses.get(a.id)!.status] - STATUS_ORDER[statuses.get(b.id)!.status] ||
						PRIORITY_ORDER[a.priority ?? 'normal'] - PRIORITY_ORDER[b.priority ?? 'normal'] ||
						a.area.localeCompare(b.area) ||
						a.name.localeCompare(b.name)
				);
				// The run number comes from the project's own counter row, locked by the upsert
				const [counter] = await tx
					.insert(qaSettings)
					.values({ orgId: c.orgId, projectId: proj.id, nextRun: 2 })
					.onConflictDoUpdate({
						target: qaSettings.projectId,
						set: { nextRun: sql`${qaSettings.nextRun} + 1`, updatedAt: sql`now()` }
					})
					.returning({ next: qaSettings.nextRun });
				const runNo = counter.next - 1;
				const scope =
					input.scope?.trim() || (input.features?.length ? input.features.join(', ') : 'whole app');
				const made = await createItem(subRequest(c, 'qa:run-item', proj.id, runNo), {
					project: proj.key,
					title: `QA run ${runNo}: ${scope}`.slice(0, 200),
					tabName: 'QA_RUN',
					phases: [
						{
							key: '1',
							title: 'Features',
							steps: ordered.map((f) => ({ text: `Test ${f.name} (${f.key})`.slice(0, 500) }))
						}
					]
				} as never);
				const [runRow] = await tx
					.insert(qaRun)
					.values({
						orgId: c.orgId,
						projectId: proj.id,
						runNo,
						itemId: made.id,
						scope,
						targetHost: origin,
						writes: target.writes,
						commit: input.commit ?? '',
						sizes: input.sizes ?? [],
						createdBy: c.actor.userId
					})
					.returning();
				await appendEvent(tx, {
					orgId: c.orgId,
					projectId: proj.id,
					itemId: made.id,
					...actorFields(c),
					verb: 'qa.run.start',
					targetType: 'qa_run',
					targetId: runRow.id,
					after: {
						runNo,
						target: origin,
						writes: target.writes,
						features: ordered.length
					} as never,
					undoable: false
				});
				return {
					run: made.ref,
					runNo,
					target: origin,
					writes: target.writes,
					note: target.writes
						? 'This address holds throwaway data: write cases may submit forms.'
						: 'This address keeps real data: run read-only cases only, and record write cases as could_not_test.',
					features: ordered.map((f, i) => ({
						key: f.key,
						name: f.name,
						step: `1.${i + 1}`,
						status: statuses.get(f.id)!.status,
						sizes: f.sizes
					}))
				};
			})
		)
	);
}

/** The first line of a text, shortened for a title. */
const firstLine = (s: string, max: number) => {
	const line = s.split('\n')[0].trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Finds or files the one open bug of a cause. A DONE, DROPPED or trashed bug of the same cause gets a new task. */
async function bugFor(
	c: Ctx,
	tx: Tx,
	args: {
		projectId: string;
		projectKey: string;
		causeKey: string;
		feature: typeof qaFeature.$inferSelect;
		title: string;
		body: string;
		links: string[];
	}
): Promise<{ id: string; ref: string; created: boolean }> {
	// One bug per cause even when two sessions record the same break at once
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtext(${`qa-bug:${args.projectId}:${args.causeKey}`}))`
	);
	const [old] = await tx
		.select({ bug: qaBug, task })
		.from(qaBug)
		.innerJoin(task, eq(task.id, qaBug.taskId))
		.where(and(eq(qaBug.projectId, args.projectId), eq(qaBug.causeKey, args.causeKey)));
	if (old && !old.task.deletedAt && old.task.status !== 'DONE' && old.task.status !== 'DROPPED')
		return { id: old.task.id, ref: `T-${old.task.number}`, created: false };
	const made = await createTask(subRequest(c, `qa:bug:${args.causeKey}`), {
		project: args.projectKey,
		title: args.title,
		body: args.body,
		status: 'TODO',
		groupName: 'QA',
		linkedItems: args.links
	});
	if (old)
		await tx
			.update(qaBug)
			.set({ taskId: made.task.id, updatedAt: sql`now()` })
			.where(eq(qaBug.id, old.bug.id));
	else
		await tx.insert(qaBug).values({
			orgId: c.orgId,
			projectId: args.projectId,
			causeKey: args.causeKey,
			taskId: made.task.id,
			featureId: args.feature.id
		});
	return { id: made.task.id, ref: made.ref, created: true };
}

/**
 * Records a batch of results. Works needs a proof line; secrets are masked before anything is written; the server numbers
 * each try; a broken result joins or files the one bug of its cause. A retry with the same request id writes nothing twice.
 */
export async function recordResults(ctx: Ctx, raw: z.input<typeof qaResultInput>) {
	const input = qaResultInput.parse(raw);
	if (!ctx.requestId)
		throw new OpError(
			'INVALID',
			'Send a requestId with every batch, so a retry never records it twice.'
		);
	const missingProof = input.results.filter((r) => r.outcome === 'works' && !r.observed?.trim());
	if (missingProof.length > 0)
		throw new OpError(
			'INVALID',
			`A Works result needs what you saw as proof (the text on screen, the record found or the address reached): ${missingProof
				.map((r) => r.caseKey)
				.join(', ')}.`
		);
	// A Broken result says what went wrong, so two different breaks never fold into one bug of an empty cause
	const missingWhat = input.results.filter((r) => r.outcome === 'broken' && !r.observed?.trim());
	if (missingWhat.length > 0)
		throw new OpError(
			'INVALID',
			`A Broken result needs what went wrong in observed: ${missingWhat.map((r) => r.caseKey).join(', ')}.`
		);
	return inCall(ctx, (c) =>
		run(c, async (tx) =>
			idempotent(c, tx, async () => {
				// The run item is locked, so two sessions recording into one run number their tries one after the other
				const runItem = await findItem(tx, c, input.run, { lock: true });
				const [runRow] = await tx.select().from(qaRun).where(eq(qaRun.itemId, runItem.id));
				if (!runRow) throw new OpError('INVALID', `${runItem.ref} is not a QA run.`);
				if (runItem.status === 'COMPLETED' || runItem.status === 'REMOVED')
					throw new OpError(
						'INVALID',
						`${runItem.ref} is closed. Start a new run to record more results.`
					);
				await requireCap(tx, c, 'write', runItem.projectId);
				await rateLimit(tx, c, 'write');
				const [proj] = await tx
					.select({ key: project.key })
					.from(project)
					.where(eq(project.id, runItem.projectId));
				const keys = [...new Set(input.results.map((r) => r.feature))];
				const features = await tx
					.select()
					.from(qaFeature)
					.where(and(eq(qaFeature.projectId, runItem.projectId), inArray(qaFeature.key, keys)));
				const byKey = new Map(features.map((f) => [f.key, f]));
				const unknown = keys.filter((k) => !byKey.has(k));
				if (unknown.length > 0)
					throw new OpError(
						'INVALID',
						`Not on the map: ${unknown.join(', ')}. Merge them with qa_map_merge first.`
					);
				// A case key must be a case the feature's map holds now, so a typo never leaves a result no later run replaces
				const strays = input.results.filter(
					(r) => !liveCaseKeys(byKey.get(r.feature)!.map).has(r.caseKey)
				);
				if (strays.length > 0)
					throw new OpError(
						'INVALID',
						`No such case on the map: ${strays.map((r) => `${r.feature} ${r.caseKey}`).join(', ')}. Use journey/step/case keys from qa_map_get, or merge the case first.`
					);
				// Open plans that touch a feature are linked from its bug, when the caller can see them
				const planLinks = await tx
					.select({ featureId: qaPlanFeature.featureId, plan: item })
					.from(qaPlanFeature)
					.innerJoin(item, eq(item.id, qaPlanFeature.planItemId))
					.where(
						and(
							inArray(
								qaPlanFeature.featureId,
								features.map((f) => f.id)
							),
							isNull(item.deletedAt),
							sql`${item.status} not in ('COMPLETED', 'REMOVED')`
						)
					);
				const plansOf = new Map<string, string[]>();
				for (const l of planLinks)
					if (await mayView(tx, c, l.plan))
						plansOf.set(l.featureId, [...(plansOf.get(l.featureId) ?? []), l.plan.ref]);
				const runPublic = runItem.visibility === 'public';
				const bugs: { ref: string; created: boolean; feature: string }[] = [];
				let recorded = 0;
				for (const r of input.results) {
					const feature = byKey.get(r.feature)!;
					const observed = maskObserved(r.observed);
					const dataEntered = maskEntered(r.dataEntered);
					// A picture or a note on it must belong to this run, so a result never points at another plan's screenshot
					if (r.screen || r.annotation) {
						const [own] = await tx
							.select({ id: screen.id })
							.from(screen)
							.leftJoin(screenAnnotation, eq(screenAnnotation.screenId, screen.id))
							.where(
								and(
									eq(screen.itemId, runItem.id),
									r.screen ? eq(screen.id, r.screen) : undefined,
									r.annotation ? eq(screenAnnotation.id, r.annotation) : undefined
								)
							)
							.limit(1);
						if (!own)
							throw new OpError(
								'INVALID',
								`The screenshot of ${r.caseKey} is not on ${runItem.ref}. Push it to the run first.`
							);
					}
					const [{ next }] = await tx
						.select({ next: sql<number>`coalesce(max(${qaResult.attempt}), 0)::int + 1` })
						.from(qaResult)
						.where(
							and(
								eq(qaResult.runId, runRow.id),
								eq(qaResult.caseKey, r.caseKey),
								eq(qaResult.width, r.width),
								eq(qaResult.mode, r.mode)
							)
						);
					let taskId: string | null = null;
					if (r.outcome === 'broken') {
						// An address can carry a reset or sign in token in its query, so only its path is kept and it is masked too
						const page = maskObserved((r.page ?? '').split(/[?#]/)[0]);
						const where = `${r.width} px, ${r.mode} mode${r.role ? `, as ${maskObserved(r.role)}` : ''}`;
						const title = runPublic
							? `QA: ${feature.name}: ${firstLine(observed || r.caseKey, 120)}`
							: `QA: an issue in ${feature.area || 'the app'} (private run)`;
						const body = runPublic
							? [
									`**Feature:** ${feature.name} (${feature.key})`,
									`**Case:** ${r.caseKey}`,
									page ? `**Page:** ${page}` : '',
									`**Where:** ${where}, ${runRow.targetHost}${runRow.commit ? ` at ${runRow.commit}` : ''}`,
									r.severity ? `**Severity:** ${r.severity}` : '',
									'',
									`**What happened:** ${observed || 'not written down'}`,
									dataEntered.length
										? `**Data entered:** ${dataEntered.map((d) => `${d.field} = ${d.value}`).join('; ')}`
										: '',
									'',
									`Found in ${runItem.ref}.`
								]
									.filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
									.join('\n')
							: `Found in the private QA run ${runItem.ref}. The details are on the run.`;
						const bug = await bugFor(c, tx, {
							projectId: runItem.projectId,
							projectKey: proj.key,
							causeKey: causeKeyOf(feature.key, page, observed),
							feature,
							title: title.slice(0, 200),
							body,
							links: [runItem.ref, ...(plansOf.get(feature.id) ?? [])].slice(0, 20)
						});
						taskId = bug.id;
						bugs.push({ ref: bug.ref, created: bug.created, feature: feature.key });
					}
					await tx.insert(qaResult).values({
						orgId: c.orgId,
						projectId: runItem.projectId,
						runId: runRow.id,
						runItemId: runItem.id,
						featureId: feature.id,
						caseKey: r.caseKey,
						attempt: next,
						outcome: r.outcome,
						severity: r.severity ?? null,
						width: r.width,
						mode: r.mode,
						role: r.role ?? '',
						targetHost: runRow.targetHost,
						observed,
						dataEntered,
						commit: runRow.commit,
						screenId: r.screen ?? null,
						annotationId: r.annotation ?? null,
						taskId,
						sessionId: c.actor.sessionId ?? null
					});
					recorded += 1;
				}
				// The run's report counts follow every batch
				const [counts] = await tx
					.select({
						works: sql<number>`(count(*) filter (where ${qaResult.outcome} = 'works'))::int`,
						broken: sql<number>`(count(*) filter (where ${qaResult.outcome} = 'broken'))::int`,
						couldNotTest: sql<number>`(count(*) filter (where ${qaResult.outcome} = 'could_not_test'))::int`
					})
					.from(qaResult)
					.where(eq(qaResult.runId, runRow.id));
				await tx
					.update(qaRun)
					.set({
						report: {
							...runRow.report,
							counts: {
								works: counts.works,
								broken: counts.broken,
								could_not_test: counts.couldNotTest
							},
							goNoGo: counts.broken > 0 ? 'no-go' : 'go'
						},
						updatedAt: sql`now()`
					})
					.where(eq(qaRun.id, runRow.id));
				await appendEvent(tx, {
					orgId: c.orgId,
					projectId: runItem.projectId,
					itemId: runItem.id,
					...actorFields(c),
					verb: 'qa.result.record',
					targetType: 'qa_run',
					targetId: runRow.id,
					after: {
						recorded,
						broken: input.results.filter((r) => r.outcome === 'broken').length,
						bugs: bugs.filter((b) => b.created).map((b) => b.ref)
					} as never,
					undoable: false
				});
				return { run: runItem.ref, recorded, bugs };
			})
		)
	);
}

export const qaRunReportInput = z.object({
	run: z.string().min(1),
	summary: z.string().max(2000).optional(),
	confidence: z.string().max(300).optional()
});

/** The run's closing words: the summary and the confidence line the report shows. */
export async function setRunReport(ctx: Ctx, raw: z.input<typeof qaRunReportInput>) {
	const input = qaRunReportInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const runItem = await findItem(tx, ctx, input.run, { lock: true });
			await requireCap(tx, ctx, 'write', runItem.projectId);
			const [runRow] = await tx.select().from(qaRun).where(eq(qaRun.itemId, runItem.id));
			if (!runRow) throw new OpError('INVALID', `${runItem.ref} is not a QA run.`);
			const report = {
				...runRow.report,
				...(input.summary !== undefined ? { summary: input.summary } : {}),
				...(input.confidence !== undefined ? { confidence: input.confidence } : {})
			};
			await tx
				.update(qaRun)
				.set({ report, updatedAt: sql`now()` })
				.where(eq(qaRun.id, runRow.id));
			return { run: runItem.ref, report };
		})
	);
}

export const qaRunListInput = z.object({
	project: z.string().min(1),
	limit: z.number().int().min(1).max(100).default(30)
});

/** The runs of a project the caller can see, newest first, for the Runs tab. */
export async function listRuns(ctx: Ctx, raw: z.input<typeof qaRunListInput>) {
	const input = qaRunListInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireQaRead(tx, ctx, proj.id);
		const rows = await tx
			.select({ run: qaRun, ref: item.ref, status: item.status })
			.from(qaRun)
			.innerJoin(item, eq(item.id, qaRun.itemId))
			.where(
				and(eq(qaRun.projectId, proj.id), isNull(item.deletedAt), visibleItemSql(ctx.actor.userId))
			)
			.orderBy(sql`${qaRun.runNo} desc`)
			.limit(input.limit);
		return rows.map(({ run: r, ref, status }) => ({
			ref,
			status,
			runNo: r.runNo,
			scope: r.scope,
			target: r.targetHost,
			writes: r.writes,
			commit: r.commit,
			report: r.report,
			createdAt: r.createdAt
		}));
	});
}

export const qaBugListInput = z.object({ project: z.string().min(1) });

/** The QA bugs of a project, open first, for the Bugs tab. */
export async function listBugs(ctx: Ctx, raw: z.input<typeof qaBugListInput>) {
	const input = qaBugListInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireQaRead(tx, ctx, proj.id);
		const rows = await tx
			.select({
				id: task.id,
				number: task.number,
				title: task.title,
				status: task.status,
				featureKey: qaFeature.key,
				featureName: qaFeature.name,
				updatedAt: task.updatedAt,
				severity: sql<
					string | null
				>`(select r.severity from qa_result r join item ri on ri.id = r.run_item_id where r.task_id = ${task.id} and (ri.visibility = 'public' or ri.created_by = ${ctx.actor.userId}) order by r.created_at desc limit 1)`,
				width: sql<
					number | null
				>`(select r.width from qa_result r join item ri on ri.id = r.run_item_id where r.task_id = ${task.id} and (ri.visibility = 'public' or ri.created_by = ${ctx.actor.userId}) order by r.created_at desc limit 1)`
			})
			.from(qaBug)
			.innerJoin(task, eq(task.id, qaBug.taskId))
			.innerJoin(qaFeature, eq(qaFeature.id, qaBug.featureId))
			.where(and(eq(qaBug.projectId, proj.id), isNull(task.deletedAt)))
			.orderBy(
				sql`case when ${task.status} in ('DONE', 'DROPPED') then 1 else 0 end`,
				sql`${task.updatedAt} desc`
			)
			.limit(200);
		return rows.map((r) => ({ ...r, ref: `T-${r.number}` }));
	});
}
