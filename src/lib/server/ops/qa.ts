// QA MAP: THE FEATURE MAP OF A PROJECT'S APP, PERSON EDITS THAT A MERGE NEVER OVERWRITES, PLAN LINKS AND THE CLOSE RULE (AFB-20261125-0442)
// The agent tests the app in its own browser; this file only stores and reads what it found. Every read joins a result to
// its run item and applies the item's visibility, so a private run's results are seen only by those who can see the run.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
import type {
	QaBaseline,
	QaCase,
	QaEntered,
	QaJourney,
	QaMap,
	QaOutcome,
	QaStep,
	QaTarget
} from '../db/schema';
// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { appendEvent } from '../db/events';
import {
	item,
	qaBug,
	qaFeature,
	qaPlanFeature,
	qaResult,
	qaSettings,
	screen,
	step,
	task
} from '../db/schema';
import {
	qaFeatureEditInput,
	qaFeatureMergeInput,
	qaFeatureSplitInput,
	qaMapMergeInput,
	qaPlanLinkInput,
	qaRedactInput,
	qaTargetsInput
} from '../db/zod';
import { atLeast } from '../orgs/roles';
import { OpError, idempotent, rateLimit, requireCap, run, subRequest } from './context';
import { actorFields } from './items';
import { findItem, findProject, visibleItemSql } from './resolve';
import { removeScreen, screenImagePath } from './screens';

// -- TYPES -- //

export type QaStatus = 'works' | 'broken' | 'could_not_test' | 'not_tested' | 'needs_retest';
/** One result as the status rules read it. */
export type QaResultLite = {
	id: string;
	featureId: string;
	caseKey: string;
	outcome: QaOutcome;
	width: number;
	mode: string;
	targetHost: string;
	commit: string;
	createdAt: Date;
	runItemId: string;
	/** The role the case ran as, empty when it does not matter. */
	role: string;
	/** The try number within the run. */
	attempt?: number;
};
export type QaDerived = {
	status: QaStatus;
	/** Some case gave both works and broken on the same tuple within one run. */
	flaky: boolean;
	/** The latest broken tuples that are not flaky. */
	brokenCases: string[];
	lastTestedAt: Date | null;
	lastCommit: string;
	counts: { works: number; broken: number; could_not_test: number };
	/** How many cases pass: the cases with a latest works and no latest broken or could-not-test, whatever their widths and modes. */
	casesWorking: number;
};
export type QaMergeDiff = { added: string[]; changed: string[]; removed: string[]; kept: string[] };

// -- CONSTANTS -- //

/** The build preview of the person's own machine. It uses their real local database, so a run there never writes. */
export const QA_LOCAL_PREVIEW = ['http://localhost:7174', 'http://127.0.0.1:7174'];
/** Field names whose typed values are never stored. */
const SECRET_FIELD = /pass|token|secret|key|otp|code|card|ssn|cvv|pin\b/i;
/** Long runs of letters and digits, or JWT-like strings, look like keys and tokens. */
const SECRET_VALUE =
	/\b(?:[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const MASK = '[hidden]';

// -- PURE RULES (tested without a database) -- //

/** The tuple a result is latest for: the same case, width, colour mode and target. */
// The role is part of it: an admin who may see a page and a guest who must not are two checks, never one flaky one
const tupleOf = (r: Pick<QaResultLite, 'caseKey' | 'width' | 'mode' | 'targetHost' | 'role'>) =>
	`${r.caseKey}|${r.width}|${r.mode}|${r.targetHost}|${r.role}`;

// Rows of one batch share the transaction's time, so the try number orders them before the id does
const newer = (a: QaResultLite, b: QaResultLite) =>
	a.createdAt.getTime() !== b.createdAt.getTime()
		? a.createdAt.getTime() > b.createdAt.getTime()
		: (a.attempt ?? 0) !== (b.attempt ?? 0)
			? (a.attempt ?? 0) > (b.attempt ?? 0)
			: a.id > b.id;

/**
 * The status of one feature from its results. The latest decisive result (works or broken) of each tuple counts; a later
 * Couldn't test never hides an earlier break. A tuple is flaky only when one run gave both works and broken for it (the
 * retries of one run disagree): a plan builds on an uncommitted tree, so a commit cannot tell two runs apart, and a works in
 * one run followed by a broken in a later run is always a regression. A flaky break shows as Broken with the flaky flag but
 * does not count in brokenCases, the list the close rule reads. A plan that finished after the latest result means Needs retest.
 */
export function deriveStatus(results: QaResultLite[], finishedAt: (Date | null)[] = []): QaDerived {
	const decisive = new Map<string, QaResultLite>();
	const untested = new Map<string, QaResultLite>();
	const seen = new Map<string, Set<QaOutcome>>();
	let last: QaResultLite | null = null;
	for (const r of results) {
		const t = tupleOf(r);
		const into = r.outcome === 'could_not_test' ? untested : decisive;
		const cur = into.get(t);
		if (!cur || newer(r, cur)) into.set(t, r);
		const k = `${t}|${r.runItemId}`;
		const s = seen.get(k) ?? new Set<QaOutcome>();
		s.add(r.outcome);
		seen.set(k, s);
		if (!last || newer(r, last)) last = r;
	}
	const latest = new Map(decisive);
	for (const [t, r] of untested) if (!latest.has(t)) latest.set(t, r);
	const counts = { works: 0, broken: 0, could_not_test: 0 };
	const brokenCases: string[] = [];
	let flaky = false;
	let flakyBroken = false;
	for (const [t, r] of latest) {
		counts[r.outcome] += 1;
		const both = seen.get(`${t}|${r.runItemId}`);
		const isFlaky = !!both && both.has('works') && both.has('broken');
		if (isFlaky) flaky = true;
		if (r.outcome === 'broken' && isFlaky) flakyBroken = true;
		if (r.outcome === 'broken' && !isFlaky) brokenCases.push(r.caseKey);
	}
	// A case passes when every tuple it was last tested on works, so one case at three widths counts once
	const passing = new Set<string>();
	const failing = new Set<string>();
	for (const r of latest.values()) (r.outcome === 'works' ? passing : failing).add(r.caseKey);
	const casesWorking = [...passing].filter((k) => !failing.has(k)).length;
	const lastAt = last ? last.createdAt : null;
	let status: QaStatus;
	if (latest.size === 0) status = 'not_tested';
	else if (brokenCases.length > 0 || flakyBroken) status = 'broken';
	else if (finishedAt.some((f) => f && lastAt && f.getTime() > lastAt.getTime()))
		status = 'needs_retest';
	else if (counts.works === 0 && counts.could_not_test > 0) status = 'could_not_test';
	else status = 'works';
	return {
		status,
		flaky,
		brokenCases: [...new Set(brokenCases)],
		lastTestedAt: lastAt,
		lastCommit: last?.commit ?? '',
		counts,
		casesWorking
	};
}

/**
 * The outcome a baseline stores for a derived status. Only a break the close rule counts makes the baseline broken: a feature
 * that only flickered before the plan keeps a works baseline, so a real break the plan makes later still blocks it.
 */
export function baselineOf(d: QaDerived): QaBaseline {
	if (d.brokenCases.length > 0) return 'broken';
	if (d.status === 'broken') return 'works';
	if (d.status === 'not_tested') return 'unknown';
	if (d.status === 'could_not_test') return 'could_not_test';
	return 'works';
}

/** A file glob as a regular expression: `**` crosses folders, `*` and `?` stay inside one. */
export function globToRegExp(glob: string): RegExp {
	let out = '';
	const g = glob.replaceAll('\\', '/').replace(/^\.\//, '');
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*' && g[i + 1] === '*') {
			out += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += g[i + 2] === '/' ? 2 : 1;
		} else if (c === '*') out += '[^/]*';
		else if (c === '?') out += '[^/]';
		else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`);
}

export function matchesAny(file: string, globs: string[]): boolean {
	const f = file.replaceAll('\\', '/').replace(/^\.\//, '');
	return globs.some((g) => globToRegExp(g).test(f));
}

/** Typed values of secret-looking fields are never stored, and key-like strings in any value are hidden. */
export function maskEntered(rows: QaEntered[] | undefined): QaEntered[] {
	return (rows ?? []).map((r) => ({
		field: r.field,
		value: SECRET_FIELD.test(r.field) ? MASK : r.value.replace(SECRET_VALUE, MASK)
	}));
}

export function maskObserved(text: string | undefined): string {
	return (text ?? '').replace(SECRET_VALUE, MASK);
}

/** One cause, one bug: the feature, the page and the shape of what went wrong (numbers and spacing do not count). */
export function causeKeyOf(featureKey: string, page: string, observed: string): string {
	const shape = observed
		.toLowerCase()
		.replace(/\d+/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
	return createHash('sha256')
		.update(`${featureKey}|${page.trim().toLowerCase()}|${shape}`)
		.digest('hex')
		.slice(0, 40);
}

const caseFields = ['input', 'technique', 'expected', 'regression'] as const;
const stepFields = ['page', 'action', 'control'] as const;
const expectedFields = ['screen', 'saved', 'sent', 'logged'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merges what the agent found into the stored map. New journeys, steps and cases are added, ones the agent no longer finds
 * are flagged removed (never deleted), and a path the person edited keeps the person's value: a different agent value is
 * written down as a conflict note instead.
 */
export function mergeFeatureMap(
	stored: QaMap,
	incoming: QaMap,
	editedPaths: string[]
): { map: QaMap; diff: QaMergeDiff; conflicts: string[] } {
	const edited = new Set(editedPaths);
	const diff: QaMergeDiff = { added: [], changed: [], removed: [], kept: [] };
	const conflicts: string[] = [];
	const now = new Date().toISOString();
	const take = <T>(path: string, mine: T, theirs: T): T => {
		if (same(mine, theirs)) return mine;
		if (edited.has(path)) {
			conflicts.push(`${path}: kept the person's value; the agent found ${JSON.stringify(theirs)}`);
			diff.kept.push(path);
			return mine;
		}
		diff.changed.push(path);
		return theirs;
	};
	const byKey = <T extends { key: string }>(list: T[]) => new Map(list.map((x) => [x.key, x]));
	const inJ = byKey(incoming.journeys);
	const journeys: QaJourney[] = stored.journeys.map((j) => {
		const nj = inJ.get(j.key);
		if (!nj) {
			if (!j.removedAt) diff.removed.push(j.key);
			return j.removedAt ? j : { ...j, removedAt: now };
		}
		const inS = byKey(nj.steps);
		const steps: QaStep[] = j.steps.map((s) => {
			const p = `${j.key}/${s.key}`;
			const ns = inS.get(s.key);
			if (!ns) {
				if (!s.removedAt) diff.removed.push(p);
				return s.removedAt ? s : { ...s, removedAt: now };
			}
			const out: QaStep = { ...s, removedAt: undefined, expected: { ...s.expected } };
			for (const f of stepFields) out[f] = take(`${p}.${f}`, s[f], ns[f]) as string;
			for (const f of expectedFields)
				out.expected[f] = take(`${p}.expected.${f}`, s.expected[f], ns.expected[f]);
			const inC = byKey(ns.cases);
			const cases: QaCase[] = s.cases.map((c) => {
				const cp = `${p}/${c.key}`;
				const nc = inC.get(c.key);
				if (!nc) {
					if (!c.removedAt) diff.removed.push(cp);
					return c.removedAt ? c : { ...c, removedAt: now };
				}
				const oc: QaCase = { ...c, removedAt: undefined };
				for (const f of caseFields)
					(oc as Record<string, unknown>)[f] = take(`${cp}.${f}`, c[f], nc[f]);
				return oc;
			});
			const known = new Set(s.cases.map((c) => c.key));
			for (const nc of ns.cases)
				if (!known.has(nc.key)) {
					cases.push(nc);
					diff.added.push(`${p}/${nc.key}`);
				}
			out.cases = cases;
			return out;
		});
		const knownS = new Set(j.steps.map((s) => s.key));
		for (const ns of nj.steps)
			if (!knownS.has(ns.key)) {
				steps.push(ns);
				diff.added.push(`${j.key}/${ns.key}`);
			}
		return {
			...j,
			removedAt: undefined,
			name: take(`${j.key}.name`, j.name, nj.name),
			parent: take(`${j.key}.parent`, j.parent, nj.parent),
			steps
		};
	});
	const knownJ = new Set(stored.journeys.map((j) => j.key));
	for (const nj of incoming.journeys)
		if (!knownJ.has(nj.key)) {
			journeys.push(nj);
			diff.added.push(nj.key);
		}
	return { map: { journeys: clean(journeys) }, diff, conflicts };
}

/**
 * A person's edited map carries no removed flags (the editor never shows removed parts), so the stored flags are put back by
 * key: an edit never brings a removed journey, step or case, and its old results, back to life.
 */
export function keepRemoved(stored: QaMap, edited: QaMap): QaMap {
	const out = clean(edited);
	for (const j of out.journeys) {
		const sj = stored.journeys.find((x) => x.key === j.key);
		if (!sj) continue;
		if (sj.removedAt) j.removedAt = sj.removedAt;
		for (const s of j.steps) {
			const ss = sj.steps.find((x) => x.key === s.key);
			if (!ss) continue;
			if (ss.removedAt) s.removedAt = ss.removedAt;
			for (const c of s.cases) {
				const sc = ss.cases.find((x) => x.key === c.key);
				if (sc?.removedAt) c.removedAt = sc.removedAt;
			}
		}
	}
	// The editor never deletes: a journey, step or case it left out is kept as it was, so an edit cannot hide a break
	for (const sj of stored.journeys) {
		const j = out.journeys.find((x) => x.key === sj.key);
		if (!j) {
			out.journeys.push(sj);
			continue;
		}
		for (const ss of sj.steps) {
			const s = j.steps.find((x) => x.key === ss.key);
			if (!s) {
				j.steps.push(ss);
				continue;
			}
			for (const sc of ss.cases) if (!s.cases.some((c) => c.key === sc.key)) s.cases.push(sc);
		}
	}
	return out;
}

/** The keys (journey/step/case) of the cases a map holds now, leaving out what is flagged removed. */
export function liveCaseKeys(map: QaMap): Set<string> {
	const out = new Set<string>();
	for (const j of map.journeys) {
		if (j.removedAt) continue;
		for (const s of j.steps) {
			if (s.removedAt) continue;
			for (const c of s.cases) if (!c.removedAt) out.add(`${j.key}/${s.key}/${c.key}`);
		}
	}
	return out;
}

/** Drops undefined fields, so a stored map never carries `removedAt: undefined` noise. */
function clean<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

/** Every path whose value differs between two maps, as the person's editor saved them. */
export function changedPaths(before: QaMap, after: QaMap): string[] {
	const flat = (m: QaMap) => {
		const out = new Map<string, unknown>();
		for (const j of m.journeys) {
			out.set(`${j.key}.name`, j.name);
			out.set(`${j.key}.parent`, j.parent);
			for (const s of j.steps) {
				const p = `${j.key}/${s.key}`;
				for (const f of stepFields) out.set(`${p}.${f}`, s[f]);
				for (const f of expectedFields) out.set(`${p}.expected.${f}`, s.expected?.[f]);
				for (const c of s.cases) for (const f of caseFields) out.set(`${p}/${c.key}.${f}`, c[f]);
			}
		}
		return out;
	};
	const a = flat(before);
	const b = flat(after);
	const paths = new Set<string>();
	for (const [k, v] of b) if (!same(a.get(k), v)) paths.add(k);
	for (const k of a.keys()) if (!b.has(k)) paths.add(k);
	return [...paths];
}

// -- READS -- //

/**
 * Testing is not shared with guests, like Notes (AFB-20261125-0442): every read verb checks it here, so the page, /api/v1 and
 * MCP all refuse the same way.
 */
export async function requireQaRead(tx: Tx, ctx: Ctx, projectId: string) {
	const r = await requireCap(tx, ctx, 'read', projectId);
	if (r.role === 'guest')
		throw new OpError('FORBIDDEN', 'Testing is not shared with guests.', {
			needed: 'read',
			role: 'guest'
		});
	return r;
}

type FeatureRow = typeof qaFeature.$inferSelect;

/** The results of some features, of runs that are not trashed or removed; only those the viewer can see when one is named. */
export async function loadResults(
	tx: Tx,
	projectId: string,
	featureIds: string[],
	options: { viewer?: string; before?: Date } = {}
): Promise<QaResultLite[]> {
	if (featureIds.length === 0) return [];
	return tx
		.select({
			id: qaResult.id,
			featureId: qaResult.featureId,
			caseKey: qaResult.caseKey,
			outcome: qaResult.outcome,
			width: qaResult.width,
			mode: qaResult.mode,
			targetHost: qaResult.targetHost,
			commit: qaResult.commit,
			createdAt: qaResult.createdAt,
			runItemId: qaResult.runItemId,
			role: qaResult.role,
			attempt: qaResult.attempt
		})
		.from(qaResult)
		.innerJoin(item, eq(item.id, qaResult.runItemId))
		.where(
			and(
				eq(qaResult.projectId, projectId),
				inArray(qaResult.featureId, featureIds),
				isNull(item.deletedAt),
				sql`${item.status} <> 'REMOVED'`,
				options.viewer ? visibleItemSql(options.viewer) : undefined,
				options.before ? lt(qaResult.createdAt, options.before) : undefined
			)
		)
		.orderBy(asc(qaResult.createdAt), asc(qaResult.id));
}

/** A feature's results include those of features merged into it, so history survives a merge. */
async function groupsOf(tx: Tx, projectId: string, features: Pick<FeatureRow, 'id'>[]) {
	const ids = features.map((f) => f.id);
	const merged =
		ids.length === 0
			? []
			: await tx
					.select({ id: qaFeature.id, into: qaFeature.mergedInto })
					.from(qaFeature)
					.where(and(eq(qaFeature.projectId, projectId), inArray(qaFeature.mergedInto, ids)));
	const group = new Map<string, string[]>(ids.map((id) => [id, [id]]));
	for (const m of merged) if (m.into) group.get(m.into)?.push(m.id);
	return group;
}

/** The derived status of each feature, for one viewer (or over every run when no viewer is named). */
export async function statusesOf(
	tx: Tx,
	projectId: string,
	features: FeatureRow[],
	options: { viewer?: string; before?: Date; withLinks?: boolean } = {}
): Promise<Map<string, QaDerived>> {
	const group = await groupsOf(tx, projectId, features);
	const all = [...group.values()].flat();
	const results = await loadResults(tx, projectId, all, options);
	const owner = new Map<string, string>();
	for (const [fid, members] of group) for (const m of members) owner.set(m, fid);
	// A case the map flags removed (or that was renamed away) no longer counts, so an old break of it cannot block a plan for good
	const live = new Map(features.map((f) => [f.id, liveCaseKeys(f.map)]));
	const byFeature = new Map<string, QaResultLite[]>();
	for (const r of results) {
		const fid = owner.get(r.featureId) ?? r.featureId;
		if (!live.get(fid)?.has(r.caseKey)) continue;
		const list = byFeature.get(fid) ?? [];
		list.push(r);
		byFeature.set(fid, list);
	}
	const finished = new Map<string, (Date | null)[]>();
	if (options.withLinks !== false && features.length > 0) {
		const links = await tx
			.select({ featureId: qaPlanFeature.featureId, finishedAt: qaPlanFeature.finishedAt })
			.from(qaPlanFeature)
			.where(
				and(
					eq(qaPlanFeature.projectId, projectId),
					inArray(
						qaPlanFeature.featureId,
						features.map((f) => f.id)
					)
				)
			);
		for (const l of links)
			finished.set(l.featureId, [...(finished.get(l.featureId) ?? []), l.finishedAt]);
	}
	const out = new Map<string, QaDerived>();
	for (const f of features)
		out.set(f.id, deriveStatus(byFeature.get(f.id) ?? [], finished.get(f.id) ?? []));
	return out;
}

/** Open bug tasks per feature. */
async function openBugs(tx: Tx, projectId: string, featureIds: string[]) {
	if (featureIds.length === 0)
		return new Map<string, { ref: string; title: string; id: string }[]>();
	const rows = await tx
		.select({ featureId: qaBug.featureId, id: task.id, number: task.number, title: task.title })
		.from(qaBug)
		.innerJoin(task, eq(task.id, qaBug.taskId))
		.where(
			and(
				eq(qaBug.projectId, projectId),
				inArray(qaBug.featureId, featureIds),
				isNull(task.deletedAt),
				sql`${task.status} not in ('DONE', 'DROPPED')`
			)
		);
	const out = new Map<string, { ref: string; title: string; id: string }[]>();
	for (const r of rows)
		out.set(r.featureId, [
			...(out.get(r.featureId) ?? []),
			{ ref: `T-${r.number}`, title: r.title, id: r.id }
		]);
	return out;
}

export const qaMapGetInput = z.object({
	project: z.string().min(1),
	feature: z.string().min(1).max(60).optional(),
	includeRemoved: z.boolean().optional()
});

/** The map of a project with each feature's derived status, as the caller may see it. */
export async function getMap(ctx: Ctx, raw: z.input<typeof qaMapGetInput>) {
	const input = qaMapGetInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		await requireQaRead(tx, ctx, proj.id);
		const rows = await tx
			.select()
			.from(qaFeature)
			.where(
				and(
					eq(qaFeature.projectId, proj.id),
					input.feature ? eq(qaFeature.key, input.feature) : undefined,
					input.includeRemoved || input.feature ? undefined : isNull(qaFeature.removedAt)
				)
			)
			.orderBy(asc(qaFeature.area), asc(qaFeature.name));
		if (input.feature && rows.length === 0)
			throw new OpError('NOT_FOUND', `No feature named "${input.feature}" on this project's map.`);
		const statuses = await statusesOf(tx, proj.id, rows, { viewer: ctx.actor.userId });
		const bugs = await openBugs(
			tx,
			proj.id,
			rows.map((r) => r.id)
		);
		const into = new Map(
			rows.filter((r) => r.mergedInto).map((r) => [r.id, r.mergedInto as string])
		);
		const intoKeys =
			into.size === 0
				? new Map<string, string>()
				: new Map(
						(
							await tx
								.select({ id: qaFeature.id, key: qaFeature.key, name: qaFeature.name })
								.from(qaFeature)
								.where(inArray(qaFeature.id, [...into.values()]))
						).map((r) => [r.id, r.key])
					);
		return {
			project: proj.key,
			features: rows.map((f) => {
				const d = statuses.get(f.id)!;
				return {
					id: f.id,
					key: f.key,
					area: f.area,
					name: f.name,
					description: f.description,
					priority: f.priority,
					codeGlobs: f.codeGlobs,
					sizes: f.sizes,
					map: f.map,
					editedPaths: f.editedPaths,
					conflicts: f.conflicts,
					untrusted: f.untrusted,
					removedAt: f.removedAt,
					mergedInto: f.mergedInto ? (intoKeys.get(f.mergedInto) ?? null) : null,
					version: f.version,
					status: d.status,
					flaky: d.flaky,
					brokenCases: d.brokenCases,
					lastTestedAt: d.lastTestedAt,
					lastCommit: d.lastCommit,
					counts: d.counts,
					casesWorking: d.casesWorking,
					bugs: bugs.get(f.id) ?? []
				};
			})
		};
	});
}

// -- WRITES -- //

async function featureEvent(
	tx: Tx,
	ctx: Ctx,
	projectId: string,
	verb: string,
	featureId: string,
	after: Record<string, unknown>
) {
	await appendEvent(tx, {
		orgId: ctx.orgId,
		projectId,
		...actorFields(ctx),
		verb,
		targetType: 'qa_feature',
		targetId: featureId,
		after: after as never,
		undoable: false
	});
}

/**
 * The agent's discovery, merged into the map. A new feature is added; an existing one needs the version the agent read
 * (STALE_VERSION otherwise, so a person's edit in between is never lost), and keeps every path the person edited.
 */
export async function mergeMap(ctx: Ctx, raw: z.input<typeof qaMapMergeInput>) {
	const input = qaMapMergeInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const out: {
				key: string;
				created: boolean;
				version: number;
				diff: QaMergeDiff;
				conflicts: string[];
			}[] = [];
			for (const f of input.features) {
				const [cur] = await tx
					.select()
					.from(qaFeature)
					.where(and(eq(qaFeature.projectId, proj.id), eq(qaFeature.key, f.key)))
					.for('update');
				if (!cur) {
					const [row] = await tx
						.insert(qaFeature)
						.values({
							orgId: ctx.orgId,
							projectId: proj.id,
							key: f.key,
							area: f.area ?? '',
							name: f.name,
							description: f.description ?? '',
							codeGlobs: f.codeGlobs ?? [],
							sizes: f.sizes ?? [],
							map: clean(f.map)
						})
						.returning();
					await featureEvent(tx, ctx, proj.id, 'qa.feature.add', row.id, { key: f.key });
					out.push({
						key: f.key,
						created: true,
						version: row.version,
						diff: { added: f.map.journeys.map((j) => j.key), changed: [], removed: [], kept: [] },
						conflicts: []
					});
					continue;
				}
				if (cur.mergedInto)
					throw new OpError(
						'INVALID',
						`Feature "${f.key}" was merged into another feature. Send its journeys to that feature instead.`
					);
				if (f.expectVersion === undefined)
					throw new OpError(
						'INVALID',
						`Feature "${f.key}" is already on the map. Read it with qa_map_get and send its version as expectVersion.`
					);
				if (f.expectVersion !== cur.version)
					throw new OpError(
						'STALE_VERSION',
						`Feature "${f.key}" changed since you read it (version ${cur.version}). Read it again and merge once more.`,
						{ version: cur.version }
					);
				const merged = mergeFeatureMap(cur.map, f.map, cur.editedPaths);
				const edited = new Set(cur.editedPaths);
				const top = (path: string, mine: string, theirs: string | undefined) => {
					if (theirs === undefined || mine === theirs) return mine;
					if (edited.has(path)) {
						merged.conflicts.push(
							`${path}: kept the person's value; the agent found ${JSON.stringify(theirs)}`
						);
						merged.diff.kept.push(path);
						return mine;
					}
					merged.diff.changed.push(path);
					return theirs;
				};
				const name = top('name', cur.name, f.name);
				const area = top('area', cur.area, f.area);
				const description = top('description', cur.description, f.description);
				const sizes =
					f.sizes && !edited.has('sizes') && !same(f.sizes, cur.sizes) ? f.sizes : cur.sizes;
				const [row] = await tx
					.update(qaFeature)
					.set({
						name,
						area,
						description,
						sizes,
						codeGlobs: f.codeGlobs ?? cur.codeGlobs,
						map: merged.map,
						conflicts: [...cur.conflicts, ...merged.conflicts].slice(-50),
						removedAt: null,
						version: sql`${qaFeature.version} + 1`,
						updatedAt: sql`now()`
					})
					.where(eq(qaFeature.id, cur.id))
					.returning({ version: qaFeature.version });
				await featureEvent(tx, ctx, proj.id, 'qa.feature.merge', cur.id, {
					key: f.key,
					added: merged.diff.added.length,
					changed: merged.diff.changed.length,
					removed: merged.diff.removed.length,
					kept: merged.diff.kept.length
				});
				out.push({ key: f.key, created: false, version: row.version, ...merged });
			}
			const flagged: string[] = [];
			for (const key of input.missing ?? []) {
				const [row] = await tx
					.update(qaFeature)
					.set({
						removedAt: sql`now()`,
						version: sql`${qaFeature.version} + 1`,
						updatedAt: sql`now()`
					})
					.where(
						and(
							eq(qaFeature.projectId, proj.id),
							eq(qaFeature.key, key),
							isNull(qaFeature.removedAt)
						)
					)
					.returning({ id: qaFeature.id });
				if (row) {
					flagged.push(key);
					await featureEvent(tx, ctx, proj.id, 'qa.feature.remove', row.id, { key });
				}
			}
			return { features: out, removed: flagged };
		})
	);
}

/** A person's edit from the feature page. Every changed path becomes sticky, so the next merge keeps it. */
export async function editFeature(ctx: Ctx, raw: z.input<typeof qaFeatureEditInput>) {
	const input = qaFeatureEditInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			const { role } = await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const [cur] = await tx
				.select()
				.from(qaFeature)
				.where(and(eq(qaFeature.projectId, proj.id), eq(qaFeature.key, input.feature)))
				.for('update');
			if (!cur)
				throw new OpError(
					'NOT_FOUND',
					`No feature named "${input.feature}" on this project's map.`
				);
			if (cur.version !== input.expectVersion)
				throw new OpError('STALE_VERSION', 'Someone changed this feature since you opened it.', {
					version: cur.version
				});
			const paths: string[] = [];
			const set: Partial<typeof qaFeature.$inferInsert> = {};
			if (input.name !== undefined && input.name !== cur.name) {
				set.name = input.name;
				paths.push('name');
			}
			if (input.area !== undefined && input.area !== cur.area) {
				set.area = input.area;
				paths.push('area');
			}
			if (input.description !== undefined && input.description !== cur.description) {
				set.description = input.description;
				paths.push('description');
			}
			if (input.priority !== undefined && input.priority !== cur.priority)
				set.priority = input.priority;
			if (input.sizes !== undefined && !same(input.sizes, cur.sizes)) {
				set.sizes = input.sizes;
				paths.push('sizes');
			}
			if (input.map !== undefined) {
				const next = keepRemoved(cur.map, clean(input.map) as QaMap);
				paths.push(...changedPaths(cur.map, next));
				set.map = next;
			}
			if (Object.keys(set).length === 0) return { key: cur.key, version: cur.version, edited: [] };
			const [row] = await tx
				.update(qaFeature)
				.set({
					...set,
					editedPaths: [...new Set([...cur.editedPaths, ...paths])],
					untrusted: cur.untrusted || role === 'guest' || role === 'viewer',
					version: sql`${qaFeature.version} + 1`,
					updatedAt: sql`now()`
				})
				.where(eq(qaFeature.id, cur.id))
				.returning({ version: qaFeature.version });
			await featureEvent(tx, ctx, proj.id, 'qa.feature.edit', cur.id, { key: cur.key, paths });
			return { key: cur.key, version: row.version, edited: paths };
		})
	);
}

/** Merges one feature into another. The merged one is kept, flagged removed and pointing at the other, so its history stays. */
export async function mergeFeatures(ctx: Ctx, raw: z.input<typeof qaFeatureMergeInput>) {
	const input = qaFeatureMergeInput.parse(raw);
	if (input.from === input.into) throw new OpError('INVALID', 'Choose two different features.');
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const rows = await tx
				.select()
				.from(qaFeature)
				.where(
					and(eq(qaFeature.projectId, proj.id), inArray(qaFeature.key, [input.from, input.into]))
				)
				.for('update');
			const from = rows.find((r) => r.key === input.from);
			const into = rows.find((r) => r.key === input.into);
			if (!from || !into)
				throw new OpError('NOT_FOUND', "Both features must be on this project's map.");
			if (from.mergedInto || into.mergedInto)
				throw new OpError('INVALID', 'One of these features was already merged into another.');
			const taken = new Set(into.map.journeys.map((j) => j.key));
			const clash = from.map.journeys.find((j) => taken.has(j.key));
			if (clash)
				throw new OpError(
					'INVALID',
					`Both features have a journey named "${clash.key}". Rename one first.`
				);
			const map: QaMap = { journeys: [...into.map.journeys, ...from.map.journeys] };
			await tx
				.update(qaFeature)
				.set({
					map,
					codeGlobs: [...new Set([...into.codeGlobs, ...from.codeGlobs])],
					editedPaths: [...new Set([...into.editedPaths, ...from.editedPaths])],
					untrusted: into.untrusted || from.untrusted,
					version: sql`${qaFeature.version} + 1`,
					updatedAt: sql`now()`
				})
				.where(eq(qaFeature.id, into.id));
			// Features merged into the old one now point at the new one, so a group is always one level deep
			await tx
				.update(qaFeature)
				.set({ mergedInto: into.id, updatedAt: sql`now()` })
				.where(and(eq(qaFeature.projectId, proj.id), eq(qaFeature.mergedInto, from.id)));
			await tx
				.update(qaFeature)
				.set({
					mergedInto: into.id,
					removedAt: sql`now()`,
					version: sql`${qaFeature.version} + 1`,
					updatedAt: sql`now()`
				})
				.where(eq(qaFeature.id, from.id));
			// Plans linked to the old feature now watch the new one, keeping their baseline; a plan linked to both keeps one link
			await tx.execute(sql`
				delete from qa_plan_feature a using qa_plan_feature b
				where a.feature_id = ${from.id} and b.feature_id = ${into.id} and a.plan_item_id = b.plan_item_id`);
			await tx
				.update(qaPlanFeature)
				.set({ featureId: into.id })
				.where(eq(qaPlanFeature.featureId, from.id));
			// The bugs of the old feature are the new one's now, so its open bugs and the close refusal list them
			await tx
				.update(qaBug)
				.set({ featureId: into.id, updatedAt: sql`now()` })
				.where(eq(qaBug.featureId, from.id));
			await featureEvent(tx, ctx, proj.id, 'qa.feature.merge-into', from.id, {
				from: from.key,
				into: into.key
			});
			return { merged: from.key, into: into.key };
		})
	);
}

/** Moves some journeys of a feature into a new feature. Past results stay with the old feature's history. */
export async function splitFeature(ctx: Ctx, raw: z.input<typeof qaFeatureSplitInput>) {
	const input = qaFeatureSplitInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const [cur] = await tx
				.select()
				.from(qaFeature)
				.where(and(eq(qaFeature.projectId, proj.id), eq(qaFeature.key, input.feature)))
				.for('update');
			if (!cur)
				throw new OpError(
					'NOT_FOUND',
					`No feature named "${input.feature}" on this project's map.`
				);
			const moving = new Set(input.journeys);
			const keep = cur.map.journeys.filter((j) => !moving.has(j.key));
			const move = cur.map.journeys.filter((j) => moving.has(j.key));
			if (move.length !== moving.size)
				throw new OpError('INVALID', 'Some of those journeys are not on this feature.');
			const [exists] = await tx
				.select({ id: qaFeature.id })
				.from(qaFeature)
				.where(and(eq(qaFeature.projectId, proj.id), eq(qaFeature.key, input.key)));
			if (exists)
				throw new OpError('CONFLICT', `A feature named "${input.key}" is already on the map.`);
			const [made] = await tx
				.insert(qaFeature)
				.values({
					orgId: ctx.orgId,
					projectId: proj.id,
					key: input.key,
					area: cur.area,
					name: input.name,
					codeGlobs: cur.codeGlobs,
					sizes: cur.sizes,
					map: { journeys: move },
					// The person's edits of the moved journeys move with them, so the next merge still keeps them
					// A journey key may hold dots, so a path belongs to a journey when it starts with the key and a separator
					editedPaths: [
						'name',
						...cur.editedPaths.filter((p) =>
							[...moving].some((k) => p.startsWith(`${k}/`) || p.startsWith(`${k}.`))
						)
					],
					untrusted: cur.untrusted
				})
				.returning();
			await tx
				.update(qaFeature)
				.set({
					map: { journeys: keep },
					version: sql`${qaFeature.version} + 1`,
					updatedAt: sql`now()`
				})
				.where(eq(qaFeature.id, cur.id));
			// The results of the moved journeys go with them, and every plan that watched the old feature watches the new one
			// with the same baseline, so a split can never hide a break from a plan's close check
			const journeyKeys = [...moving];
			await tx
				.update(qaResult)
				.set({ featureId: made.id })
				.where(
					and(
						eq(qaResult.featureId, cur.id),
						sql`split_part(${qaResult.caseKey}, '/', 1) in (${sql.join(
							journeyKeys.map((k) => sql`${k}`),
							sql`, `
						)})`
					)
				);
			await tx.execute(sql`
				insert into qa_plan_feature (org_id, project_id, plan_item_id, feature_id, baseline_outcome, baseline_at, finished_at)
				select org_id, project_id, plan_item_id, ${made.id}, baseline_outcome, baseline_at, finished_at
				from qa_plan_feature where feature_id = ${cur.id}
				on conflict do nothing`);
			await featureEvent(tx, ctx, proj.id, 'qa.feature.split', cur.id, {
				from: cur.key,
				to: input.key,
				journeys: input.journeys
			});
			return { feature: cur.key, created: made.key };
		})
	);
}

// -- PLAN LINKS -- //

/** The time a plan first recorded a done step, from the event log (a reopen clears step.doneAt, the event stays). */
async function firstDoneAt(tx: Tx, planItemId: string): Promise<Date | null> {
	const res = await tx.execute(sql`
		select min(created_at) as at from event
		where item_id = ${planItemId} and verb = 'step.update' and after->>'state' = 'done'`);
	const at = (res as unknown as { rows: { at: Date | string | null }[] }).rows[0]?.at;
	return at ? new Date(at) : null;
}

/**
 * Links a plan to the features whose code it touches. The baseline is taken once, on the server over every run, from
 * the results before the plan's first done step, and never changes after: a later link cannot hide a break the plan made.
 */
export async function linkPlanFeatures(ctx: Ctx, raw: z.input<typeof qaPlanLinkInput>) {
	const input = qaPlanLinkInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const plan = await findItem(tx, ctx, input.item);
			await requireCap(tx, ctx, 'write', plan.projectId);
			await rateLimit(tx, ctx, 'write');
			let files = input.files;
			if (!files) {
				const rows = await tx
					.select({ files: step.files })
					.from(step)
					.where(eq(step.itemId, plan.id));
				files = [...new Set(rows.flatMap((r) => r.files ?? []))];
			}
			const features = await tx
				.select()
				.from(qaFeature)
				.where(and(eq(qaFeature.projectId, plan.projectId), isNull(qaFeature.removedAt)));
			const touched = features.filter(
				(f) => f.codeGlobs.length > 0 && files!.some((file) => matchesAny(file, f.codeGlobs))
			);
			const cutoff = (await firstDoneAt(tx, plan.id)) ?? new Date();
			const before = await statusesOf(tx, plan.projectId, touched, {
				before: cutoff,
				withLinks: false
			});
			const linked: { key: string; name: string; baseline: QaBaseline; new: boolean }[] = [];
			for (const f of touched) {
				const baseline = baselineOf(before.get(f.id)!);
				const made = await tx
					.insert(qaPlanFeature)
					.values({
						orgId: ctx.orgId,
						projectId: plan.projectId,
						planItemId: plan.id,
						featureId: f.id,
						baselineOutcome: baseline,
						baselineAt: cutoff
					})
					.onConflictDoNothing()
					.returning({ baseline: qaPlanFeature.baselineOutcome });
				if (made.length > 0) linked.push({ key: f.key, name: f.name, baseline, new: true });
				else {
					const [old] = await tx
						.select({ baseline: qaPlanFeature.baselineOutcome })
						.from(qaPlanFeature)
						.where(and(eq(qaPlanFeature.planItemId, plan.id), eq(qaPlanFeature.featureId, f.id)));
					linked.push({ key: f.key, name: f.name, baseline: old.baseline, new: false });
				}
			}
			if (linked.some((l) => l.new))
				await appendEvent(tx, {
					orgId: ctx.orgId,
					projectId: plan.projectId,
					itemId: plan.id,
					...actorFields(ctx),
					verb: 'qa.plan.link',
					targetType: 'item',
					targetId: plan.id,
					after: { features: linked.filter((l) => l.new).map((l) => l.key) } as never,
					undoable: false
				});
			return { item: plan.ref, features: linked, files: files.length };
		})
	);
}

/** The features a plan touches, with their baseline and their status now, for the plan's QA tab. */
export async function planFeatures(ctx: Ctx, itemRef: string) {
	return run(ctx, async (tx) => {
		const plan = await findItem(tx, ctx, itemRef);
		await requireQaRead(tx, ctx, plan.projectId);
		const links = await tx
			.select({ link: qaPlanFeature, feature: qaFeature })
			.from(qaPlanFeature)
			.innerJoin(qaFeature, eq(qaFeature.id, qaPlanFeature.featureId))
			.where(eq(qaPlanFeature.planItemId, plan.id))
			.orderBy(asc(qaFeature.area), asc(qaFeature.name));
		const features = links.map((l) => l.feature);
		const now = await statusesOf(tx, plan.projectId, features, { viewer: ctx.actor.userId });
		const bugs = await openBugs(
			tx,
			plan.projectId,
			features.map((f) => f.id)
		);
		return links.map(({ link, feature }) => ({
			key: feature.key,
			name: feature.name,
			area: feature.area,
			baseline: link.baselineOutcome,
			status: now.get(feature.id)!.status,
			flaky: now.get(feature.id)!.flaky,
			bugs: bugs.get(feature.id) ?? []
		}));
	});
}

/** How many features a plan touches, read on every item page for the tab count. */
export async function countPlanFeatures(tx: Tx, planItemId: string): Promise<number> {
	const [row] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(qaPlanFeature)
		.where(eq(qaPlanFeature.planItemId, planItemId));
	return row?.n ?? 0;
}

/** Called when a plan first moves to IN REVIEW: a result older than this means Needs retest. Touches nothing without links. */
export async function markPlanFinished(tx: Tx, planItemId: string) {
	await tx
		.update(qaPlanFeature)
		.set({ finishedAt: sql`now()` })
		.where(and(eq(qaPlanFeature.planItemId, planItemId), isNull(qaPlanFeature.finishedAt)));
}

export type QaCloseBlock = {
	features: { key: string; name: string }[];
	bugs: string[];
	hidden: number;
};

/**
 * Whether a plan may close: a feature it touched that is broken now (over every run, not flaky) and was not broken at the
 * baseline blocks. What the caller cannot see is counted, never named.
 */
export async function closeBlock(
	tx: Tx,
	ctx: Ctx,
	planItemId: string,
	projectId: string
): Promise<QaCloseBlock | null> {
	const links = await tx
		.select({ link: qaPlanFeature, feature: qaFeature })
		.from(qaPlanFeature)
		.innerJoin(qaFeature, eq(qaFeature.id, qaPlanFeature.featureId))
		// A feature the agent no longer finds in the app does not block (merged ones were repointed to their survivor)
		.where(and(eq(qaPlanFeature.planItemId, planItemId), isNull(qaFeature.removedAt)));
	if (links.length === 0) return null;
	const features = links.map((l) => l.feature);
	const all = await statusesOf(tx, projectId, features, { withLinks: false });
	const seen = await statusesOf(tx, projectId, features, {
		viewer: ctx.actor.userId,
		withLinks: false
	});
	const blocking = links.filter(
		({ link, feature }) =>
			// A flaky break only warns: the close rule reads the breaks that are not flaky
			all.get(feature.id)!.brokenCases.length > 0 && link.baselineOutcome !== 'broken'
	);
	if (blocking.length === 0) return null;
	const visible = blocking.filter(({ feature }) => seen.get(feature.id)!.brokenCases.length > 0);
	const bugs = await openBugs(
		tx,
		projectId,
		visible.map((b) => b.feature.id)
	);
	return {
		features: visible.map(({ feature }) => ({ key: feature.key, name: feature.name })),
		bugs: [...bugs.values()].flat().map((b) => b.ref),
		hidden: blocking.length - visible.length
	};
}

// -- SETTINGS AND REDACTION -- //

export const qaSettingsGetInput = z.object({ project: z.string().min(1) });

export async function getSettings(ctx: Ctx, raw: z.input<typeof qaSettingsGetInput>) {
	const input = qaSettingsGetInput.parse(raw);
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		const { role } = await requireQaRead(tx, ctx, proj.id);
		const [row] = await tx.select().from(qaSettings).where(eq(qaSettings.projectId, proj.id));
		return {
			targets: (row?.targets ?? []) as QaTarget[],
			localPreview: QA_LOCAL_PREVIEW[0],
			canEdit: atLeast(role, 'admin'),
			version: row?.version ?? 0
		};
	});
}

/** The places a run may target. Only an owner or an admin sets them, and only they mark one as throwaway data. */
export async function setTargets(ctx: Ctx, raw: z.input<typeof qaTargetsInput>) {
	const input = qaTargetsInput.parse(raw);
	return run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			const { role } = await requireCap(tx, ctx, 'write', proj.id);
			if (!atLeast(role, 'admin'))
				throw new OpError('FORBIDDEN', 'Only an owner or an admin can change the test addresses.');
			await rateLimit(tx, ctx, 'write');
			// The origin as a browser writes it (a default port like :443 dropped), so it matches the address a run names
			const byOrigin = new Map(
				input.targets.map((t) => {
					const origin = new URL(t.origin).origin.toLowerCase();
					return [origin, { ...t, origin }];
				})
			);
			const targets = [...byOrigin.values()].filter((t) => !QA_LOCAL_PREVIEW.includes(t.origin));
			await tx
				.insert(qaSettings)
				.values({ orgId: ctx.orgId, projectId: proj.id, targets })
				.onConflictDoUpdate({
					target: qaSettings.projectId,
					set: { targets, version: sql`${qaSettings.version} + 1`, updatedAt: sql`now()` }
				});
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				...actorFields(ctx),
				verb: 'qa.settings.targets',
				targetType: 'project',
				targetId: proj.id,
				after: {
					targets: targets.map((t) => `${t.origin}${t.writes ? ' (writes)' : ''}`)
				} as never,
				undoable: false
			});
			return { targets };
		})
	);
}

/** Removes what a result recorded, and its screenshot, when something private was caught in it. The owner's call. */
export async function redactResult(ctx: Ctx, raw: z.input<typeof qaRedactInput>) {
	const input = qaRedactInput.parse(raw);
	const done = await run(ctx, async (tx) =>
		idempotent(ctx, tx, async () => {
			const [row] = await tx
				.select()
				.from(qaResult)
				.where(eq(qaResult.id, input.result))
				.for('update');
			if (!row) throw new OpError('NOT_FOUND', 'No result with that id.');
			const runItem = await findItem(tx, ctx, row.runItemId);
			const { role } = await requireCap(tx, ctx, 'write', runItem.projectId);
			if (role !== 'owner') throw new OpError('FORBIDDEN', 'Only an owner can redact a QA result.');
			await rateLimit(tx, ctx, 'write');
			await tx
				.update(qaResult)
				.set({ observed: '[redacted]', dataEntered: [], redactedAt: sql`now()` })
				.where(eq(qaResult.id, row.id));
			// The bug filed from this result carried the same text in its title and body, so it is redacted too
			if (row.taskId)
				await tx
					.update(task)
					.set({
						title: 'QA: a redacted issue',
						body: 'The details were redacted by the owner.',
						updatedAt: sql`now()`,
						version: sql`${task.version} + 1`
					})
					.where(eq(task.id, row.taskId));
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: runItem.projectId,
				itemId: runItem.id,
				...actorFields(ctx),
				verb: 'qa.result.redact',
				targetType: 'qa_result',
				targetId: row.id,
				undoable: false
			});
			return { result: row.id, screenId: row.screenId };
		})
	);
	let screenRemoved = false;
	if (done.screenId) {
		try {
			await removeScreen(subRequest(ctx, 'qa:redact:screen', done.screenId), done.screenId);
			screenRemoved = true;
		} catch (e) {
			// A retry of the redaction finds the picture already gone; any other error is real
			if (!(e instanceof OpError && e.code === 'NOT_FOUND')) throw e;
		}
	}
	return { result: done.result, screenRemoved };
}

// -- FEATURE PAGE -- //

export const qaFeatureDetailInput = z.object({
	project: z.string().min(1),
	feature: z.string().min(1).max(60),
	runsOffset: z.number().int().min(0).default(0),
	runsLimit: z.number().int().min(1).max(50).default(10)
});

/**
 * One feature for its page: the map, the latest result of each case with its picture and notes, the runs that tested it
 * (paged) and its open bugs, all as the caller may see them.
 */
export async function featureDetail(ctx: Ctx, raw: z.input<typeof qaFeatureDetailInput>) {
	const input = qaFeatureDetailInput.parse(raw);
	const map = await getMap(ctx, { project: input.project, feature: input.feature });
	const f = map.features[0];
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, input.project);
		const viewer = ctx.actor.userId;
		const ids = (await groupsOf(tx, proj.id, [f])).get(f.id) ?? [f.id];
		const rows = await tx
			.select({
				caseKey: qaResult.caseKey,
				outcome: qaResult.outcome,
				severity: qaResult.severity,
				observed: qaResult.observed,
				width: qaResult.width,
				mode: qaResult.mode,
				role: qaResult.role,
				createdAt: qaResult.createdAt,
				id: qaResult.id,
				screenId: qaResult.screenId,
				runItemId: qaResult.runItemId
			})
			.from(qaResult)
			.innerJoin(item, eq(item.id, qaResult.runItemId))
			.where(
				and(
					eq(qaResult.projectId, proj.id),
					inArray(qaResult.featureId, ids),
					isNull(item.deletedAt),
					sql`${item.status} <> 'REMOVED'`,
					visibleItemSql(viewer)
				)
			)
			.orderBy(asc(qaResult.createdAt), asc(qaResult.id));
		// The newest result of each case, whatever its size or mode, is what the page shows next to the case
		const latest = new Map<string, (typeof rows)[number]>();
		for (const r of rows) latest.set(r.caseKey, r);
		const screenIds = [...latest.values()].map((r) => r.screenId).filter((x): x is string => !!x);
		const shots = screenIds.length
			? await tx
					.select({ id: screen.id, checksum: screen.checksum, screenKey: screen.screenKey })
					.from(screen)
					.where(inArray(screen.id, screenIds))
			: [];
		const shotOf = new Map(shots.map((s) => [s.id, s]));
		const cases: Record<
			string,
			{
				outcome: string;
				severity: string | null;
				observed: string;
				width: number;
				mode: string;
				role: string;
				at: Date;
				screen: { image: string } | null;
			}
		> = {};
		for (const [k, r] of latest) {
			const shot = r.screenId ? shotOf.get(r.screenId) : undefined;
			cases[k] = {
				outcome: r.outcome,
				severity: r.severity,
				observed: r.observed,
				width: r.width,
				mode: r.mode,
				role: r.role,
				at: r.createdAt,
				screen: shot
					? { image: `${screenImagePath(shot.id)}?v=${shot.checksum.slice(0, 12)}` }
					: null
			};
		}
		// The last result at each screen width: the newest result of every case, width and colour mode still on the map, and the
		// worst of them for the width (broken, then couldn't test, then works)
		const liveKeys = liveCaseKeys(f.map);
		const lastOfTuple = new Map<string, (typeof rows)[number]>();
		for (const r of rows)
			if (liveKeys.has(r.caseKey)) lastOfTuple.set(`${r.caseKey}|${r.width}|${r.mode}`, r);
		const weight: Record<string, number> = { works: 0, could_not_test: 1, broken: 2 };
		const widths: Record<number, string> = {};
		for (const r of lastOfTuple.values())
			if (!(r.width in widths) || (weight[r.outcome] ?? 0) > (weight[widths[r.width]] ?? 0))
				widths[r.width] = r.outcome;
		// The runs that tested this feature, newest first, a page at a time
		const runRows = await tx.execute(sql`
			select i.ref as ref, qr.run_no as "runNo", max(r.created_at) as at,
				count(*) filter (where r.outcome = 'works')::int as works,
				count(*) filter (where r.outcome = 'broken')::int as broken,
				count(*) filter (where r.outcome = 'could_not_test')::int as "couldNotTest"
			from qa_result r
			join qa_run qr on qr.id = r.run_id
			join item i on i.id = r.run_item_id
			where r.project_id = ${proj.id} and r.feature_id in (${sql.join(
				ids.map((x) => sql`${x}::uuid`),
				sql`, `
			)})
				and i.deleted_at is null and i.status <> 'REMOVED'
				and (i.visibility = 'public' or i.created_by = ${viewer})
			group by i.ref, qr.run_no
			order by qr.run_no desc
			limit ${input.runsLimit + 1} offset ${input.runsOffset}`);
		const runs = (
			runRows as unknown as {
				rows: {
					ref: string;
					runNo: number;
					at: Date;
					works: number;
					broken: number;
					couldNotTest: number;
				}[];
			}
		).rows;
		return {
			feature: f,
			cases,
			widths,
			runs: runs.slice(0, input.runsLimit),
			moreRuns: runs.length > input.runsLimit,
			runsOffset: input.runsOffset
		};
	});
}

/**
 * The tab count of a plan's Testing tab: how many QA features it touches, with the plan's own visibility rule. A guest gets 0,
 * so the tab never shows for them and their item page still loads.
 */
export async function planFeatureCount(ctx: Ctx, itemRef: string): Promise<number> {
	return run(ctx, async (tx) => {
		const plan = await findItem(tx, ctx, itemRef);
		const { role } = await requireCap(tx, ctx, 'read', plan.projectId);
		if (role === 'guest') return 0;
		return countPlanFeatures(tx, plan.id);
	});
}
