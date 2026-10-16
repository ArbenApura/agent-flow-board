// PUBLISHING A PROJECT TO ITS GITHUB REPO: LINK, PREVIEW THE DIFF, PUBLISH NOW OR LATER, CANCEL, RETRY AND PAUSE (SPEC 8)
// A publish is a row (`publish_run`) first and a job second. Cancelling marks the row, and the job claims the row with one
// guarded UPDATE before it writes anything, so a cancelled publish writes nothing on any runtime (ADR-023 Cancel by state).

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { JobContext, JobRunner } from '../adapters/jobs';
import type { Ctx } from '../ops/context';
import type { GithubApi } from './app';
// -- DEP-MODULES -- //
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import { event, githubInstallation, githubLink, publishRun } from '../db/schema';
import { OpError, rateLimit, requireCap, run } from '../ops/context';
import { actorFields } from '../ops/items';
import { findProject } from '../ops/resolve';
import { GithubError, GithubRateLimited } from './app';
import { diffHashes, loadPublishable, privateContentReason, renderExport } from './export';

// -- TYPES -- //

export type Schedule = {
	/** 0 is Sunday. */
	days: number[];
	/** Local times, HH:MM. */
	from: string;
	to: string;
	/** An IANA name such as Europe/Berlin. */
	timezone: string;
};
export type PublishRunRow = typeof publishRun.$inferSelect;

// -- CONSTANTS -- //

export const PUBLISH_JOB = 'publish.run';
/** Tries for one run: a rate limit or a short outage is retried this many times before it counts as a failure. */
export const MAX_ATTEMPTS = 5;
/** Failed runs in a row after which automatic publish pauses until someone publishes by hand. */
export const FAILURES_BEFORE_PAUSE = 3;
export const MIN_DELAY_MINUTES = 1;
export const MAX_DELAY_MINUTES = 24 * 60;
const MAX_LATER_DAYS = 30;

export const linkInput = z.object({
	project: z.string().min(1),
	installationId: z.string().regex(/^[0-9]{1,20}$/, 'The installation id is a number'),
	repo: z
		.string()
		.regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'Write the repository as owner/name'),
	branch: z
		.string()
		.regex(/^[A-Za-z0-9._/-]{1,100}$/)
		.optional(),
	// Never empty and never climbing: an empty folder would make the publish treat the whole repository as its own
	path: z
		.string()
		.regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, 'Use letters, digits and slashes')
		.refine((p) => p.split('/').every((part) => part !== '.' && part !== '..'), 'Use a folder name')
		.max(100)
		.optional()
});

export const scheduleInput = z.object({
	days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
	from: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
	to: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
	timezone: z.string().min(1).max(64)
});

export const settingsInput = z.object({
	project: z.string().min(1),
	autoPublish: z.boolean().optional(),
	delayMinutes: z.number().int().min(MIN_DELAY_MINUTES).max(MAX_DELAY_MINUTES).optional(),
	schedule: scheduleInput.nullable().optional()
});

export const publishInput = z.object({
	project: z.string().min(1),
	/** Publish at this time instead of now. At least a few seconds ahead and at most 30 days. */
	runAt: z.string().datetime().optional()
});

// -- FUNCTIONS -- //

function services(ctx: Ctx): { github: GithubApi } {
	const github = ctx.services?.github;
	if (!github)
		throw new OpError(
			'INVALID',
			'GitHub publishing is not set up on this server. An operator adds the GitHub App settings first.'
		);
	return { github };
}

const systemActor = {
	actorUserId: null,
	actorLabel: 'Publisher',
	tool: 'github'
} as const;

/** The first time at or after `from` that falls inside the schedule, or `from` itself when there is none. */
export function nextAllowed(from: Date, schedule: Schedule | null | undefined): Date {
	if (!schedule) return from;
	const parts = (d: Date) => {
		const f = new Intl.DateTimeFormat('en-GB', {
			timeZone: schedule.timezone,
			weekday: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		}).formatToParts(d);
		const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
		const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
		return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
	};
	const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
	const start = toMin(schedule.from);
	const end = toMin(schedule.to);
	const allowed = (d: Date) => {
		const p = parts(d);
		if (!schedule.days.includes(p.day)) return false;
		return start <= end
			? p.minutes >= start && p.minutes < end
			: p.minutes >= start || p.minutes < end;
	};
	if (allowed(from)) return from;
	// Quarter hour steps for eight days find the next window, then one minute steps back find its exact opening
	for (let i = 1; i <= 8 * 96; i++) {
		const grid = new Date(from.getTime() + i * 15 * 60_000);
		if (!allowed(grid)) continue;
		let opening = grid;
		for (let back = 1; back <= 15; back++) {
			const earlier = new Date(grid.getTime() - back * 60_000);
			if (earlier.getTime() <= from.getTime() || !allowed(earlier)) break;
			opening = earlier;
		}
		return opening;
	}
	return from;
}

async function linkOf(tx: Tx, projectId: string) {
	const [row] = await tx.select().from(githubLink).where(eq(githubLink.projectId, projectId));
	return row ?? null;
}

/**
 * True when this org made that installation through the install link. Row level security shows an org its own rows only, so
 * another org's installation looks the same as one that does not exist. No call to GitHub is made for one that is not ours.
 */
export async function ownsInstallation(ctx: Ctx, installationId: string): Promise<boolean> {
	if (!/^[0-9]{1,20}$/.test(installationId)) return false;
	return run(ctx, async (tx) => {
		const [mine] = await tx
			.select({ id: githubInstallation.installationId })
			.from(githubInstallation)
			.where(
				and(
					eq(githubInstallation.installationId, installationId),
					eq(githubInstallation.orgId, ctx.orgId)
				)
			);
		return Boolean(mine);
	});
}

/** Connects a project to one repository the GitHub App can reach. Needs the publish capability. */
export async function linkRepo(ctx: Ctx, raw: z.input<typeof linkInput>) {
	const input = linkInput.parse(raw);
	const { github } = services(ctx);
	if (!(await ownsInstallation(ctx, input.installationId)))
		throw new OpError(
			'FORBIDDEN',
			'This organisation has not installed the GitHub App for that installation. Start from "Connect GitHub" on the project.'
		);
	// The repository is checked with GitHub first, so a typo or a repository the App cannot reach is refused plainly
	const info = await github.getRepo(input.installationId, input.repo).catch((e) => {
		if (e instanceof GithubError) throw new OpError('INVALID', e.message);
		throw e;
	});
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'publish', proj.id);
		await rateLimit(tx, ctx, 'write');
		// Two projects publishing into the same folder would delete each other's files on every publish
		const clash = await tx
			.select({ id: githubLink.id, path: githubLink.path })
			.from(githubLink)
			.where(
				and(
					eq(githubLink.orgId, ctx.orgId),
					sql`lower(${githubLink.repo}) = lower(${info.fullName})`,
					eq(githubLink.branch, input.branch ?? info.defaultBranch),
					sql`${githubLink.projectId} <> ${proj.id}`
				)
			);
		// The same folder, or one inside the other, would have a publish delete the other project's files
		const mine = input.path ?? 'board';
		const overlaps = (other: string) =>
			other === mine || other.startsWith(`${mine}/`) || mine.startsWith(`${other}/`);
		if (clash.some((c) => overlaps(c.path)))
			throw new OpError(
				'CONFLICT',
				'Another project of this organisation already publishes into that folder. Choose a different folder.'
			);
		const values = {
			installationId: input.installationId,
			repo: info.fullName,
			branch: input.branch ?? info.defaultBranch,
			path: input.path ?? 'board',
			repoVisibility: info.private ? 'private' : 'public',
			pausedReason: null,
			failures: 0
		};
		const [row] = await tx
			.insert(githubLink)
			.values({ orgId: ctx.orgId, projectId: proj.id, ...values })
			.onConflictDoUpdate({
				target: githubLink.projectId,
				set: { ...values, updatedAt: sql`now()`, version: sql`${githubLink.version} + 1` }
			})
			.returning();
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: proj.id,
			...actorFields(ctx),
			verb: 'github.link',
			targetType: 'project',
			targetId: proj.id,
			after: { repo: row.repo, branch: row.branch, visibility: row.repoVisibility } as never,
			undoable: false
		});
		return row;
	});
}

export async function unlinkRepo(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'publish', proj.id);
		// Pending runs are cancelled with the link, so nothing waits for a repository that is no longer wanted
		await tx
			.update(publishRun)
			.set({
				state: 'cancelled',
				message: 'The repository was disconnected.',
				updatedAt: sql`now()`
			})
			.where(and(eq(publishRun.projectId, proj.id), eq(publishRun.state, 'pending')));
		const gone = await tx.delete(githubLink).where(eq(githubLink.projectId, proj.id)).returning();
		if (gone.length)
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				...actorFields(ctx),
				verb: 'github.unlink',
				targetType: 'project',
				targetId: proj.id,
				before: { repo: gone[0].repo } as never,
				undoable: false
			});
		return { unlinked: gone.length > 0 };
	});
}

/** The switch, the delay and the schedule of automatic publish. Turning it on again clears a pause. */
export async function setPublishSettings(ctx: Ctx, raw: z.input<typeof settingsInput>) {
	const input = settingsInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'publish', proj.id);
		await rateLimit(tx, ctx, 'write');
		const link = await linkOf(tx, proj.id);
		if (!link)
			throw new OpError('INVALID', 'Connect a repository before changing publish settings.');
		const set: Record<string, unknown> = {};
		if (input.autoPublish !== undefined) {
			set.autoPublish = input.autoPublish;
			if (input.autoPublish) {
				set.pausedReason = null;
				set.failures = 0;
			}
		}
		if (input.delayMinutes !== undefined) set.delayMinutes = input.delayMinutes;
		if (input.schedule !== undefined) set.schedule = input.schedule;
		if (!Object.keys(set).length) return link;
		const [row] = await tx
			.update(githubLink)
			.set({ ...set, updatedAt: sql`now()`, version: sql`${githubLink.version} + 1` })
			.where(eq(githubLink.id, link.id))
			.returning();
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: proj.id,
			...actorFields(ctx),
			verb: 'github.settings',
			targetType: 'project',
			targetId: proj.id,
			before: Object.fromEntries(Object.keys(set).map((k) => [k, (link as never)[k]])) as never,
			after: set as never,
			undoable: false
		});
		return row;
	});
}

/** The connection, the last runs and the waiting run of a project, for its publish page. */
export async function publishState(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		const { caps } = await requireCap(tx, ctx, 'read', proj.id);
		const link = await linkOf(tx, proj.id);
		const runs = await tx
			.select()
			.from(publishRun)
			.where(eq(publishRun.projectId, proj.id))
			.orderBy(desc(publishRun.createdAt))
			.limit(20);
		return {
			configured: Boolean(ctx.services?.github),
			canPublish: caps.includes('publish'),
			link: link && {
				repo: link.repo,
				branch: link.branch,
				path: link.path,
				repoVisibility: link.repoVisibility,
				autoPublish: link.autoPublish,
				delayMinutes: link.delayMinutes,
				schedule: link.schedule as Schedule | null,
				pausedReason: link.pausedReason,
				failures: link.failures,
				installationId: link.installationId
			},
			runs,
			pending: runs.find((r) => r.state === 'pending') ?? null
		};
	});
}

/** What a publish would write now: the items that changed since the last publish, and whether the repository would accept it. */
export async function previewPublish(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireCap(tx, ctx, 'publish', proj.id);
		const link = await linkOf(tx, proj.id);
		const data = await loadPublishable(tx, proj.id);
		const exported = renderExport(data);
		const [last] = await tx
			.select()
			.from(publishRun)
			.where(and(eq(publishRun.projectId, proj.id), eq(publishRun.state, 'done')))
			.orderBy(desc(publishRun.createdAt))
			.limit(1);
		const diff = diffHashes(last?.hashes ?? {}, exported.hashes);
		const refusal = link?.repoVisibility === 'public' ? privateContentReason(data) : null;
		return {
			linked: Boolean(link),
			repo: link?.repo ?? null,
			repoVisibility: link?.repoVisibility ?? null,
			refusal,
			itemCount: exported.itemCount,
			privateItems: data.privateItems,
			privateFiles: data.privateFiles,
			fileCount: Object.keys(exported.files).length,
			diff,
			lastPublishedAt: last?.updatedAt ?? null
		};
	});
}

/**
 * Starts a publish. Without `runAt` it runs now, inside this call, and returns the finished run. With a time it queues a
 * cancellable run and returns it pending.
 */
export async function requestPublish(
	ctx: Ctx,
	raw: z.input<typeof publishInput>,
	options: { trigger?: 'manual' | 'auto' | 'schedule' } = {}
) {
	const input = publishInput.parse(raw);
	const { github } = services(ctx);
	const at = input.runAt ? new Date(input.runAt) : null;
	if (at) {
		const ahead = at.getTime() - Date.now();
		if (ahead < 5_000) throw new OpError('INVALID', 'Pick a time at least a few seconds from now.');
		if (ahead > MAX_LATER_DAYS * 86_400_000)
			throw new OpError('INVALID', `Pick a time within the next ${MAX_LATER_DAYS} days.`);
	}
	const created = await run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'publish', proj.id);
		await rateLimit(tx, ctx, 'write');
		const link = await linkOf(tx, proj.id);
		if (!link) throw new OpError('INVALID', 'Connect a repository before publishing.');
		const [row] = await tx
			.insert(publishRun)
			.values({
				orgId: ctx.orgId,
				projectId: proj.id,
				state: 'pending',
				runAt: at ?? new Date(),
				trigger: options.trigger ?? 'manual',
				requestedBy: ctx.actor.userId,
				repo: link.repo
			})
			.returning();
		return { run: row, projectId: proj.id };
	});
	if (at) {
		await enqueueRun(ctx, created.projectId, created.run.id, at);
		return { run: created.run, done: false };
	}
	// Publish now runs in this call, so the page can show the result at once
	await executeRun(
		{
			payload: { orgId: ctx.orgId, projectId: created.projectId, runId: created.run.id },
			tenant: (fn) => run(ctx, fn, created.projectId)
		},
		github,
		ctx.services?.jobs
	);
	const [finished] = await run(ctx, (tx) =>
		tx.select().from(publishRun).where(eq(publishRun.id, created.run.id))
	);
	return { run: finished, done: true };
}

async function enqueueRun(
	ctx: Pick<Ctx, 'orgId' | 'services'>,
	projectId: string,
	runId: string,
	at: Date
) {
	const jobs = ctx.services?.jobs;
	if (!jobs)
		throw new OpError('INVALID', 'Delayed publishing needs the job runner, which is not running.');
	await jobs.enqueue(PUBLISH_JOB, { orgId: ctx.orgId, projectId, runId }, { runAt: at });
}

/** Cancels a waiting publish. A run that already started cannot be cancelled. Repeating it is harmless. */
export async function cancelPublish(ctx: Ctx, runId: string) {
	return run(ctx, async (tx) => {
		const [row] = await tx.select().from(publishRun).where(eq(publishRun.id, runId));
		if (!row) throw new OpError('NOT_FOUND', 'No such publish.');
		await requireCap(tx, ctx, 'publish', row.projectId);
		const [cancelled] = await tx
			.update(publishRun)
			.set({ state: 'cancelled', message: 'Cancelled before it ran.', updatedAt: sql`now()` })
			.where(and(eq(publishRun.id, runId), eq(publishRun.state, 'pending')))
			.returning();
		if (cancelled)
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: row.projectId,
				...actorFields(ctx),
				verb: 'publish.cancel',
				targetType: 'project',
				targetId: row.projectId,
				undoable: false
			});
		return { cancelled: Boolean(cancelled), state: (cancelled ?? row).state };
	});
}

/** A running publish untouched for this long, or a pending one this long past its time, is treated as lost. */
const STALE_RUN_MINUTES = 20;

const delaySeconds = (attempt: number, retryAfter?: number) =>
	Math.min(retryAfter !== undefined ? retryAfter + 1 : 30 * 2 ** Math.max(0, attempt - 1), 30 * 60);

/**
 * The job. It claims its row with one guarded UPDATE (pending to running), so a cancelled or repeated job returns without
 * touching the repository. Everything it reads and writes goes through the job's own tenant.
 */
export async function executeRun(
	job: Pick<JobContext, 'payload' | 'tenant'>,
	github: GithubApi,
	jobs?: Pick<JobRunner, 'enqueue'>
): Promise<{ paused: string | null }> {
	const runId = String(job.payload.runId ?? '');
	const projectId = job.payload.projectId as string;
	const orgId = job.payload.orgId;
	// 1. Claim the row. Cancelled, finished and already running rows are left alone.
	const claimed = await job.tenant(async (tx) => {
		const [row] = await tx
			.update(publishRun)
			.set({
				state: 'running',
				attempt: sql`${publishRun.attempt} + 1`,
				error: null,
				updatedAt: sql`now()`
			})
			.where(and(eq(publishRun.id, runId), eq(publishRun.state, 'pending')))
			.returning();
		if (!row) return null;
		const link = await linkOf(tx, projectId);
		return { row, link };
	});
	if (!claimed) return { paused: null };
	const { row, link } = claimed;
	let paused: string | null = null;
	const finish = (
		state: 'done' | 'failed' | 'cancelled' | 'pending',
		set: Partial<typeof publishRun.$inferInsert> = {}
	) =>
		job.tenant(async (tx) =>
			tx
				.update(publishRun)
				.set({ ...set, state, updatedAt: sql`now()` })
				.where(eq(publishRun.id, runId))
		);
	if (!link) {
		await finish('failed', { error: 'The project has no connected repository.' });
		return { paused: null };
	}
	if (row.trigger !== 'manual' && link.pausedReason) {
		await finish('cancelled', { message: 'Automatic publish is paused.' });
		return { paused: null };
	}
	if (row.trigger !== 'manual' && !link.autoPublish) {
		await finish('cancelled', { message: 'Automatic publish was switched off.' });
		return { paused: null };
	}
	try {
		// 2. The repository's visibility is checked fresh every time, never trusted from the last run
		const info = await github.getRepo(link.installationId, link.repo);
		const visibility = info.private ? 'private' : 'public';
		const data = await job.tenant(async (tx) => {
			if (visibility !== link.repoVisibility)
				await tx
					.update(githubLink)
					.set({ repoVisibility: visibility, updatedAt: sql`now()` })
					.where(eq(githubLink.id, link.id));
			return loadPublishable(tx, projectId);
		});
		const refusal = visibility === 'public' ? privateContentReason(data) : null;
		if (refusal) {
			await job.tenant(async (tx) => {
				await tx
					.update(publishRun)
					.set({ state: 'failed', error: refusal, updatedAt: sql`now()` })
					.where(eq(publishRun.id, runId));
				// Retrying cannot fix this, so automatic publish pauses with the reason shown
				if (row.trigger !== 'manual') {
					paused = refusal;
					await tx
						.update(githubLink)
						.set({ pausedReason: refusal, updatedAt: sql`now()` })
						.where(eq(githubLink.id, link.id));
				}
				await appendEvent(tx, {
					orgId,
					projectId,
					...systemActor,
					verb: 'publish.refused',
					targetType: 'project',
					targetId: projectId,
					after: { reason: refusal } as never,
					undoable: false
				});
			});
			return { paused };
		}
		const exported = renderExport(data);
		// 3. One more look at the row right before writing: the cancel guard of ADR-023
		const stillWanted = await job.tenant(async (tx) => {
			const [r] = await tx
				.select({ state: publishRun.state })
				.from(publishRun)
				.where(eq(publishRun.id, runId));
			return r?.state === 'running';
		});
		if (!stillWanted) return { paused: null };
		const [last] = await job.tenant((tx) =>
			tx
				.select()
				.from(publishRun)
				.where(
					and(
						eq(publishRun.projectId, projectId),
						eq(publishRun.state, 'done'),
						sql`${publishRun.id} <> ${runId}`
					)
				)
				.orderBy(desc(publishRun.createdAt))
				.limit(1)
		);
		const diff = diffHashes(last?.hashes ?? {}, exported.hashes);
		const result = await github.commitFiles(
			link.installationId,
			link.repo,
			link.branch,
			exported.files,
			{
				prefix: link.path,
				message:
					`Publish ${data.project.key}: ${exported.itemCount} item${exported.itemCount === 1 ? '' : 's'}` +
					(diff.total ? `, ${diff.total} changed` : '')
			}
		);
		await job.tenant(async (tx) => {
			await tx
				.update(publishRun)
				.set({
					state: 'done',
					commitSha: result.sha,
					changedItems: [...diff.added, ...diff.changed, ...diff.removed],
					hashes: exported.hashes,
					fileCount: Object.keys(exported.files).length,
					lastEventId: data.lastEventId,
					message: result.sha
						? `Wrote ${result.changed.length} file${result.changed.length === 1 ? '' : 's'}` +
							(result.deleted.length ? ` and removed ${result.deleted.length}` : '')
						: 'Nothing had changed, so nothing was written.',
					updatedAt: sql`now()`
				})
				.where(eq(publishRun.id, runId));
			await tx
				.update(githubLink)
				.set({ failures: 0, updatedAt: sql`now()` })
				.where(eq(githubLink.id, link.id));
			if (result.sha)
				await appendEvent(tx, {
					orgId,
					projectId,
					...systemActor,
					verb: 'publish.done',
					targetType: 'project',
					targetId: projectId,
					after: { repo: link.repo, commit: result.sha, files: result.changed.length } as never,
					undoable: false
				});
		});
	} catch (e) {
		const retryable = e instanceof GithubError && e.retryable && row.attempt < MAX_ATTEMPTS;
		const message = e instanceof Error ? e.message : String(e);
		if (retryable && jobs) {
			// A rate limit or a short outage: back off and put the same run back, still cancellable
			const wait = delaySeconds(
				row.attempt,
				e instanceof GithubRateLimited ? e.retryAfterSeconds : undefined
			);
			const at = new Date(Date.now() + wait * 1000);
			await finish('pending', { error: message, runAt: at });
			await jobs.enqueue(PUBLISH_JOB, { orgId, projectId, runId }, { runAt: at });
			return { paused: null };
		}
		await job.tenant(async (tx) => {
			await tx
				.update(publishRun)
				.set({ state: 'failed', error: message, updatedAt: sql`now()` })
				.where(eq(publishRun.id, runId));
			const [updated] = await tx
				.update(githubLink)
				.set({ failures: sql`${githubLink.failures} + 1`, updatedAt: sql`now()` })
				.where(eq(githubLink.id, link.id))
				.returning();
			// Three failures in a row pause automatic publish and say why, until a person publishes by hand
			if (updated && updated.failures >= FAILURES_BEFORE_PAUSE && updated.autoPublish) {
				paused = `Publishing failed ${updated.failures} times in a row. The last error was: ${message}`;
				await tx.update(githubLink).set({ pausedReason: paused }).where(eq(githubLink.id, link.id));
			}
			await appendEvent(tx, {
				orgId,
				projectId,
				...systemActor,
				verb: 'publish.failed',
				targetType: 'project',
				targetId: projectId,
				after: { error: message } as never,
				undoable: false
			});
		});
	}
	return { paused };
}

/**
 * Called when something changed in a project. If automatic publish is on and not paused, and the project changed since
 * the last publish, it queues one cancellable run after the delay (and inside the schedule). One waiting run at most.
 */
export async function scheduleAutoPublish(
	job: Pick<JobContext, 'payload' | 'tenant'>,
	jobs: Pick<JobRunner, 'enqueue'>,
	now = new Date()
): Promise<{ scheduled: boolean }> {
	const projectId = job.payload.projectId as string;
	const orgId = job.payload.orgId;
	const made = await job.tenant(async (tx) => {
		// Several processes may look at the same project at once, so one at a time decides whether a run is due
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
		const link = await linkOf(tx, projectId);
		if (!link || !link.autoPublish || link.pausedReason) return null;
		// A run that was claimed and never finished (a restart, a crash) or one whose job was lost must not stop publishing for good
		const staleBefore = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);
		await tx
			.update(publishRun)
			.set({
				state: 'failed',
				error: 'This publish did not finish. A later change will publish again.',
				updatedAt: sql`now()`
			})
			.where(
				and(
					eq(publishRun.projectId, projectId),
					or(
						and(eq(publishRun.state, 'running'), lt(publishRun.updatedAt, staleBefore)),
						and(eq(publishRun.state, 'pending'), lt(publishRun.runAt, staleBefore))
					)
				)
			);
		// One waiting run is enough: a second change joins the first
		const [waiting] = await tx
			.select({ id: publishRun.id })
			.from(publishRun)
			.where(
				and(eq(publishRun.projectId, projectId), inArray(publishRun.state, ['pending', 'running']))
			)
			.limit(1);
		if (waiting) return null;
		const [seen] = await tx
			.select({ id: sql<number>`coalesce(max(${event.id}), 0)::int` })
			.from(event)
			.where(
				and(
					eq(event.projectId, projectId),
					sql`${event.verb} not like 'publish.%'`,
					sql`${event.verb} not like 'github.%'`
				)
			);
		const [last] = await tx
			.select({ lastEventId: publishRun.lastEventId })
			.from(publishRun)
			.where(and(eq(publishRun.projectId, projectId), eq(publishRun.state, 'done')))
			.orderBy(desc(publishRun.createdAt))
			.limit(1);
		if ((seen?.id ?? 0) <= (last?.lastEventId ?? 0)) return null;
		const at = nextAllowed(
			new Date(now.getTime() + link.delayMinutes * 60_000),
			link.schedule as Schedule | null
		);
		const [row] = await tx
			.insert(publishRun)
			.values({
				orgId,
				projectId,
				state: 'pending',
				runAt: at,
				trigger: link.schedule ? 'schedule' : 'auto',
				repo: link.repo
			})
			.returning();
		return { id: row.id, at };
	});
	if (!made) return { scheduled: false };
	await jobs.enqueue(PUBLISH_JOB, { orgId, projectId, runId: made.id }, { runAt: made.at });
	return { scheduled: true };
}
