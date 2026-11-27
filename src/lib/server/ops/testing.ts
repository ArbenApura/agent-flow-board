// TESTING VERBS: TEST CASES, THE PLANS THAT ADOPT THEM, RUNS, RESULTS WITH THEIR PROOF, DEFECTS AND THE READS OF THE SHEET (AFB-20261127-0438)
// One verb set behind the Testing page, the plan's Testing tab, /api/v1, MCP and the bridge. Agents write; people read.
// Item privacy is not row level security: every read of a run, a result, a proof or a plan link joins the run's plan and applies
// the same visibility rule as the plan itself, and a guest reads nothing. Every free-text field an agent sends goes through one
// redactor before it is stored. Proof files are written after every check passed, removed again when the rows do not save, and
// never put in the backup archive.

// IMPORTED TYPES
import type { z } from 'zod';
import type { DbHandle, Tx } from '../db/client';
import type { Storage } from '../adapters/storage';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
// IMPORTED CONSTANTS
import {
	TEST_PROOF_KEY_PREFIX,
	type TestDevice,
	type TestDeviceSpec,
	type TestStatus
} from '../db/schema/testing';
// IMPORTED MODULES
import { appendEvent } from '../db/events';
import {
	item,
	project,
	section,
	task,
	testCase,
	testCaseVersion,
	testCounter,
	testPlanCase,
	testProof,
	testResult,
	testRun,
	testSurface
} from '../db/schema';
import {
	TEST_PROOF_CALL_MAX_CHARS,
	TEST_PROOF_MAX_BYTES,
	testCaseRetireInput,
	testCaseSaveInput,
	testPlanCasesInput,
	testResultInput,
	testRunFinishInput,
	testRunStartInput,
	testSurfacesInput
} from '../db/zod';
import { listMyOrgs } from '../orgs/orgs';
import { pickRerun, planTier } from '../../shared/testTier';
import { OpError, idempotent, rateLimit, requireCap, run, runCall, subRequest } from './context';
import { createTask, updateTask } from './docs';
import { SCREEN_EXTENSIONS, imageWidth, type ScreenMime } from './imageType';
import { actorFields } from './items';
import { findItem, findProject } from './resolve';
import { checkScreenPicture } from './screens';

// -- CONSTANTS -- //

/** An open run with no result for this long reads as abandoned and stops showing as live. */
export const RUN_QUIET_MINUTES = 30;
/** The results per case and device whose proof files are kept; older ones keep their rows and lose the file. */
export const PROOF_KEEP_RESULTS = 10;
/** The board's own device sizes (SCREEN_WIDTH and the viewer heights of src/lib/board/mockups.ts). */
export const DEVICE_SIZES: Record<
	Exclude<TestDevice, 'custom'>,
	{ width: number; height: number }
> = {
	wide: { width: 1600, height: 900 },
	laptop: { width: 1280, height: 800 },
	tablet: { width: 820, height: 1100 },
	phone: { width: 408, height: 840 }
};
/** The order a status is worse in: the worst one of a case's devices is the case's status. */
const WORST: TestStatus[] = ['fail', 'blocked', 'not_run', 'pass'];
/** The fixed reasons a tests waiver may name. */
export const TESTS_WAIVER_REASONS = [
	'docs only',
	'skill text only',
	'no behaviour change',
	'config or deploy only'
] as const;
const LINE_MAX = 500;

// -- REDACTION -- //

const SECRET_PATTERNS: [RegExp, string][] = [
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
	[/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]'],
	[
		/\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|session)\s*[=:]\s*[^\s&,;]+/gi,
		'$1=[redacted]'
	],
	[/\bafb_[A-Za-z0-9_-]{8,}/g, 'afb_[redacted]'],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
	[/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, '[redacted key]']
];

/**
 * The one redactor for every free-text field an agent sends: control characters out, secret shapes masked, each line cut at
 * 500 characters. Applied on write, so nothing a test saw is ever stored, returned, exported or backed up in the clear.
 */
export function redact(text: string | null | undefined): string {
	if (!text) return '';
	// eslint-disable-next-line no-control-regex
	let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
	for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
	return out
		.split('\n')
		.map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l))
		.join('\n')
		.trim();
}

// -- ACCESS -- //

function storage(ctx: Ctx) {
	if (!ctx.services?.storage)
		throw new OpError('INVALID', 'File storage is not configured on this server.');
	return ctx.services.storage;
}

/** A reader of the Testing data: any member with the read right except a guest (like Notes). Returns the role. */
async function requireTestingRead(tx: Tx, ctx: Ctx, projectId: string) {
	const { role } = await requireCap(tx, ctx, 'read', projectId);
	if (role === 'guest')
		throw new OpError('FORBIDDEN', 'Testing is not shared with guests.', { needed: 'viewer' });
	return role;
}

/** A run the viewer may see: one on no plan, or one whose plan is live and visible to them. */
const runVisibleSql = (userId: string) => sql`(
	${testRun.planItemId} is null or exists (
		select 1 from ${item} vi where vi.id = ${testRun.planItemId} and vi.deleted_at is null
		and (vi.visibility = 'public' or vi.created_by = ${userId})
	)
)`;

/** The reference of a run's plan, null for a sweep. A subquery, not a left join: the join of item on a nullable column typed the whole row as never. */
const planRefSql = sql<
	string | null
>`(select pi.ref from ${item} pi where pi.id = ${testRun.planItemId})`;

/** The state a run reads as: an open run quiet for 30 minutes is abandoned. */
export function runStateOf(
	r: Pick<typeof testRun.$inferSelect, 'state' | 'lastActivityAt'>,
	now = new Date()
) {
	if (r.state !== 'open') return r.state;
	return now.getTime() - new Date(r.lastActivityAt).getTime() > RUN_QUIET_MINUTES * 60_000
		? 'abandoned'
		: 'open';
}

/** The worst status of a set (no status at all reads as not run). */
export function worstOf(statuses: TestStatus[]): TestStatus {
	for (const s of WORST) if (statuses.includes(s)) return s;
	return 'not_run';
}

/** The code in a case key, from the last level of its area (apps/centers/queue gives QUEUE). */
export function codeOf(area: string): string {
	const last = area.split('/').pop() ?? area;
	const code = last
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.slice(0, 12);
	return code || 'CASE';
}

/** The size of a device of a case: its own numbers for custom, else the board's. */
function sizeOf(spec: TestDeviceSpec | undefined, device: TestDevice) {
	if (spec) return { width: spec.width, height: spec.height };
	if (device === 'custom')
		throw new OpError('INVALID', 'A custom device needs its width and height.');
	return DEVICE_SIZES[device];
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// -- COUNTERS -- //

/** The next number of a code in a project, taken under a row lock so two agents never get the same key. */
async function nextNumber(tx: Tx, ctx: Ctx, projectId: string, code: string): Promise<number> {
	await tx
		.insert(testCounter)
		.values({ orgId: ctx.orgId, projectId, code, next: 1 })
		.onConflictDoNothing();
	const [row] = await tx
		.select()
		.from(testCounter)
		.where(and(eq(testCounter.projectId, projectId), eq(testCounter.code, code)))
		.for('update');
	await tx
		.update(testCounter)
		.set({ next: row.next + 1 })
		.where(eq(testCounter.id, row.id));
	return row.next;
}

// -- CASES -- //

/** The latest status of a case: the worst of the newest result of each device across the runs the caller may see. */
async function latestStatus(tx: Tx, ctx: Ctx, caseId: string): Promise<TestStatus | 'none'> {
	const rows = await tx.execute(sql`
		select distinct on (r.device, r.width, r.height) r.status
		from ${testResult} r join ${testRun} on ${testRun.id} = r.run_id
		where r.case_id = ${caseId} and ${runVisibleSql(ctx.actor.userId)}
		order by r.device, r.width, r.height, r.updated_at desc`);
	const list = (rows as unknown as { rows: { status: TestStatus }[] }).rows.map((r) => r.status);
	return list.length ? worstOf(list) : 'none';
}

/** Adopts a case into a plan in a role; the baseline is taken once, when the link is made, and never changes. */
async function adopt(
	tx: Tx,
	ctx: Ctx,
	planId: string,
	projectId: string,
	caseId: string,
	role: 'reuse' | 'update' | 'new' | 'retire'
) {
	const baseline = role === 'new' ? 'none' : await latestStatus(tx, ctx, caseId);
	await tx
		.insert(testPlanCase)
		.values({ orgId: ctx.orgId, projectId, planItemId: planId, caseId, role, baseline })
		.onConflictDoUpdate({
			target: [testPlanCase.planItemId, testPlanCase.caseId],
			// The role may move on (re-run, then updated, then retired); the baseline stays what it was
			set: {
				role: sql`case when excluded.role = 'reuse' then ${testPlanCase.role} else excluded.role end`
			}
		});
}

/**
 * Writes a case. With no key it is a new case: the key comes from the area code counter. With a key it is a new version of
 * that case. A plan named with it adopts the case as New or Update.
 */
export async function saveCase(ctx: Ctx, raw: z.input<typeof testCaseSaveInput>) {
	const input = testCaseSaveInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const plan = input.plan ? await findItem(tx, ctx, input.plan) : null;
			if (plan && plan.projectId !== proj.id)
				throw new OpError('INVALID', 'The plan belongs to another project.');
			const version = {
				// Steps often quote what a tester typed, so they pass the redactor like every other free text
				steps: input.steps.map((s) => ({ ...s, action: redact(s.action) })),
				inputData: redact(input.inputData),
				checks: input.checks.map((c) => ({ kind: c.kind, expect: redact(c.expect) })),
				unitRef: input.unitRef ? redact(input.unitRef) : null,
				devices: input.devices,
				mode: input.mode ?? 'light',
				surfaces: (input.surfaces ?? []).map((s) => redact(s)),
				planItemId: plan?.id ?? null,
				createdBy: ctx.actor.userId
			};
			let row: typeof testCase.$inferSelect;
			let number = 1;
			if (!input.key) {
				const code = input.code ?? codeOf(input.area);
				const n = await nextNumber(tx, ctx, proj.id, code);
				[row] = await tx
					.insert(testCase)
					.values({
						orgId: ctx.orgId,
						projectId: proj.id,
						key: `TC-${code}-${String(n).padStart(2, '0')}`,
						area: input.area,
						kind: input.kind,
						title: redact(input.title),
						priority: input.priority ?? 'normal'
					})
					.returning();
			} else {
				const [found] = await tx
					.select()
					.from(testCase)
					.where(and(eq(testCase.projectId, proj.id), eq(testCase.key, input.key)))
					.for('update');
				if (!found) throw new OpError('NOT_FOUND', `No test case ${input.key} in ${proj.key}.`);
				if (found.retiredAt) throw new OpError('CONFLICT', `${found.key} is retired.`);
				if (found.kind !== input.kind)
					throw new OpError(
						'INVALID',
						`${found.key} is a ${found.kind} case; its kind does not change.`
					);
				number = found.currentVersion + 1;
				[row] = await tx
					.update(testCase)
					.set({
						area: input.area,
						title: redact(input.title),
						priority: input.priority ?? found.priority,
						currentVersion: number,
						updatedAt: sql`now()`,
						version: sql`${testCase.version} + 1`
					})
					.where(eq(testCase.id, found.id))
					.returning();
			}
			await tx.insert(testCaseVersion).values({
				orgId: ctx.orgId,
				projectId: proj.id,
				caseId: row.id,
				number,
				...version
			});
			if (plan) await adopt(tx, ctx, plan.id, proj.id, row.id, input.key ? 'update' : 'new');
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				itemId: plan?.id ?? null,
				...actorFields(ctx),
				verb: input.key ? 'test.case.update' : 'test.case.add',
				targetType: 'test_case',
				targetId: row.id,
				after: { key: row.key, version: number } as never,
				undoable: false
			});
			return {
				case: { key: row.key, version: number, area: row.area, kind: row.kind, title: row.title }
			};
		})
	);
}

/** Retires a case: it leaves the suite and keeps its history. A plan named with it records the retirement. */
export async function retireCase(ctx: Ctx, raw: z.input<typeof testCaseRetireInput>) {
	const input = testCaseRetireInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const plan = input.plan ? await findItem(tx, ctx, input.plan) : null;
			if (plan && plan.projectId !== proj.id)
				throw new OpError('INVALID', 'The plan belongs to another project.');
			const [found] = await tx
				.select()
				.from(testCase)
				.where(and(eq(testCase.projectId, proj.id), eq(testCase.key, input.key)))
				.for('update');
			if (!found) throw new OpError('NOT_FOUND', `No test case ${input.key} in ${proj.key}.`);
			if (plan) await adopt(tx, ctx, plan.id, proj.id, found.id, 'retire');
			if (!found.retiredAt)
				await tx
					.update(testCase)
					.set({ retiredAt: sql`now()`, retiredBy: plan?.id ?? null, updatedAt: sql`now()` })
					.where(eq(testCase.id, found.id));
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				itemId: plan?.id ?? null,
				...actorFields(ctx),
				verb: 'test.case.retire',
				targetType: 'test_case',
				targetId: found.id,
				after: { key: found.key } as never,
				undoable: false
			});
			return { case: found.key, retired: true as const };
		})
	);
}

/** A plan adopts existing cases to re-run, update or retire; each keeps the baseline it had when it was adopted. */
export async function adoptCases(ctx: Ctx, raw: z.input<typeof testPlanCasesInput>) {
	const input = testPlanCasesInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const plan = await findItem(tx, ctx, input.item);
			await requireCap(tx, ctx, 'write', plan.projectId);
			await rateLimit(tx, ctx, 'write');
			const keys = input.cases.map((c) => c.key);
			const rows = keys.length
				? await tx
						.select()
						.from(testCase)
						.where(and(eq(testCase.projectId, plan.projectId), inArray(testCase.key, keys)))
				: [];
			const byKey = new Map(rows.map((r) => [r.key, r]));
			const missing = keys.filter((k) => !byKey.has(k));
			if (missing.length) throw new OpError('NOT_FOUND', `No test case ${missing.join(', ')}.`);
			for (const c of input.cases) {
				const row = byKey.get(c.key)!;
				await adopt(tx, ctx, plan.id, plan.projectId, row.id, c.role);
				if (c.role === 'retire' && !row.retiredAt)
					await tx
						.update(testCase)
						.set({ retiredAt: sql`now()`, retiredBy: plan.id, updatedAt: sql`now()` })
						.where(eq(testCase.id, row.id));
			}
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: plan.projectId,
				itemId: plan.id,
				...actorFields(ctx),
				verb: 'test.plan.adopt',
				targetType: 'item',
				targetId: plan.id,
				after: { cases: input.cases } as never,
				undoable: false
			});
			return { item: plan.ref, adopted: input.cases.length };
		})
	);
}

// -- RUNS -- //

/** Starts a run. A new run on a plan supersedes the plan's open one, which reads as abandoned from then on. */
export async function startRun(ctx: Ctx, raw: z.input<typeof testRunStartInput>) {
	const input = testRunStartInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const plan = input.item ? await findItem(tx, ctx, input.item) : null;
			if (plan && plan.projectId !== proj.id)
				throw new OpError('INVALID', 'The plan belongs to another project.');
			if (plan)
				await tx
					.update(testRun)
					.set({ state: 'abandoned', finishedAt: sql`now()` })
					.where(and(eq(testRun.planItemId, plan.id), eq(testRun.state, 'open')));
			const runNo = await nextNumber(tx, ctx, proj.id, '#RUN');
			const [row] = await tx
				.insert(testRun)
				.values({
					orgId: ctx.orgId,
					projectId: proj.id,
					planItemId: plan?.id ?? null,
					runNo,
					objective: redact(input.objective),
					commit: (input.commit ?? '').trim(),
					harness: redact(input.harness),
					browser: redact(input.browser),
					reviewer: redact(input.reviewer),
					tier: (input.tier ?? '').trim(),
					createdBy: ctx.actor.userId
				})
				.returning();
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				itemId: plan?.id ?? null,
				...actorFields(ctx),
				verb: 'test.run.start',
				targetType: 'test_run',
				targetId: row.id,
				after: { run: runNo } as never,
				undoable: false
			});
			return { run: row.id, runNo, item: plan?.ref ?? null };
		})
	);
}

/** Finishes a run. */
export async function finishRun(ctx: Ctx, raw: z.input<typeof testRunFinishInput>) {
	const input = testRunFinishInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const r = await loadRun(tx, ctx, input.run, true);
			await requireCap(tx, ctx, 'write', r.projectId);
			await rateLimit(tx, ctx, 'write');
			if (r.state === 'open')
				await tx
					.update(testRun)
					.set({ state: 'finished', finishedAt: sql`now()` })
					.where(eq(testRun.id, r.id));
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: r.projectId,
				itemId: r.planItemId,
				...actorFields(ctx),
				verb: 'test.run.finish',
				targetType: 'test_run',
				targetId: r.id,
				after: { run: r.runNo } as never,
				undoable: false
			});
			return { run: r.id, state: 'finished' as const };
		})
	);
}

/** The run the caller may see, or NOT_FOUND (the same answer for a hidden one). */
async function loadRun(tx: Tx, ctx: Ctx, id: string, lock: boolean) {
	const base = tx
		.select()
		.from(testRun)
		.where(and(eq(testRun.id, id), eq(testRun.orgId, ctx.orgId), runVisibleSql(ctx.actor.userId)));
	const [row] = lock ? await base.for('update') : await base;
	if (!row) throw new OpError('NOT_FOUND', 'No such run.');
	return row;
}

// -- RESULTS -- //

type ProofIn = { step: number | null; bytes: Uint8Array; mime: ScreenMime; width: number };

/** Every proof picture checked from its bytes before anything is written. */
function checkProofs(rows: z.output<typeof testResultInput>['results']): Map<number, ProofIn[]> {
	const out = new Map<number, ProofIn[]>();
	rows.forEach((r, i) => {
		const list: ProofIn[] = [];
		for (const p of r.proofs ?? []) {
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(Buffer.from(p.data, 'base64'));
			} catch {
				throw new OpError('INVALID', `The proof of ${r.case} is not base64.`);
			}
			const mime = checkScreenPicture(bytes, TEST_PROOF_MAX_BYTES);
			const width = imageWidth(bytes, mime);
			if (width === null)
				throw new OpError('INVALID', `The proof of ${r.case} has no readable picture header.`);
			list.push({ step: p.step ?? null, bytes, mime, width });
		}
		out.set(i, list);
	});
	return out;
}

/**
 * Records results of a run, one per case and device, as an upsert (a retry or a second try replaces the first). A pass or
 * fail of a UI case is refused without a screenshot, and of any other case without its check output. A fail files one defect
 * task for the case and the plan; a pass on every device of the plan closes it. The defect task is written by the task verbs
 * in this same transaction, so a refused result leaves no task behind.
 */
export async function recordResults(ctx: Ctx, raw: z.input<typeof testResultInput>) {
	const input = testResultInput.parse(raw);
	const chars = input.results.reduce(
		(n, r) => n + (r.proofs ?? []).reduce((m, p) => m + p.data.length, 0),
		0
	);
	if (chars > TEST_PROOF_CALL_MAX_CHARS)
		throw new OpError(
			'INVALID',
			'The pictures of one call are too large together: send one result per call.'
		);
	const proofs = checkProofs(input.results);
	const store = input.results.some((r) => (r.proofs ?? []).length > 0) ? storage(ctx) : null;
	const written: string[] = [];
	const go = (c: Ctx) =>
		run(c, (tx) =>
			idempotent(c, tx, async () => {
				const r = await loadRun(tx, c, input.run, true);
				await requireCap(tx, c, 'write', r.projectId);
				await rateLimit(tx, c, 'write');
				// Only a run that was finished or superseded refuses; a run that was only quiet for a while (a slow case) takes results again
				if (r.state !== 'open')
					throw new OpError('CONFLICT', `Run ${r.runNo} is ${r.state}. Start a new run.`);
				const keys = [...new Set(input.results.map((x) => x.case))];
				const cases = await tx
					.select()
					.from(testCase)
					.where(and(eq(testCase.projectId, r.projectId), inArray(testCase.key, keys)));
				const byKey = new Map(cases.map((x) => [x.key, x]));
				const missing = keys.filter((k) => !byKey.has(k));
				if (missing.length) throw new OpError('NOT_FOUND', `No test case ${missing.join(', ')}.`);
				const retired = cases.filter((x) => x.retiredAt).map((x) => x.key);
				if (retired.length)
					throw new OpError(
						'CONFLICT',
						`${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} retired.`
					);
				const versions = await tx
					.select()
					.from(testCaseVersion)
					.where(
						inArray(
							testCaseVersion.caseId,
							cases.map((x) => x.id)
						)
					);
				const current = new Map(
					cases.map((x) => [
						x.id,
						versions.find((v) => v.caseId === x.id && v.number === x.currentVersion)
					])
				);
				const replaced: string[] = [];
				const saved: { case: string; device: TestDevice; status: TestStatus; id: string }[] = [];
				for (const [i, row] of input.results.entries()) {
					const tc = byKey.get(row.case)!;
					const ver = current.get(tc.id);
					const decided = row.status === 'pass' || row.status === 'fail';
					const pics = proofs.get(i) ?? [];
					// Proof is strict (the owner, 2026-11-27): a decided UI result shows what was seen, any other kind says what ran
					if (decided && tc.kind === 'ui' && pics.length === 0)
						throw new OpError(
							'PROOF_REQUIRED',
							`${tc.key} on ${row.device}: a ${row.status} of a UI case needs a screenshot of the end state${row.status === 'fail' ? ' or of the failing step' : ''}.`
						);
					if (decided && tc.kind !== 'ui' && !(row.output ?? '').trim())
						throw new OpError(
							'PROOF_REQUIRED',
							`${tc.key}: a ${row.status} of a ${tc.kind} case needs its check output.`
						);
					const spec = ver?.devices.find((d) => d.device === row.device);
					// A named device always takes the case's size, so a retry at a slightly different viewport replaces the first
					// result instead of leaving it behind in a slot of its own; only a custom device keeps the size it ran at
					const size =
						row.device === 'custom' && row.width && row.height
							? { width: row.width, height: row.height }
							: tc.kind === 'ui'
								? sizeOf(spec, row.device)
								: DEVICE_SIZES.laptop;
					const values = {
						orgId: c.orgId,
						projectId: r.projectId,
						runId: r.id,
						caseId: tc.id,
						caseVersion: tc.currentVersion,
						device: row.device,
						width: size.width,
						height: size.height,
						mode: row.mode,
						status: row.status,
						reason: redact(row.reason),
						failedStep: row.failedStep ?? null,
						actual: redact(row.actual),
						output: redact(row.output),
						consoleLines: (row.consoleLines ?? []).map(redact).filter(Boolean),
						browser: redact(row.browser),
						severity: row.status === 'fail' ? (row.severity ?? 'major') : null,
						bugPriority: row.status === 'fail' ? (row.bugPriority ?? tc.priority) : null,
						createdBy: c.actor.userId
					};
					const [res] = await tx
						.insert(testResult)
						.values(values)
						.onConflictDoUpdate({
							target: [
								testResult.runId,
								testResult.caseId,
								testResult.device,
								testResult.width,
								testResult.height
							],
							set: { ...values, updatedAt: sql`now()` }
						})
						.returning();
					// A second try of the same slot replaces its proof
					const old = await tx.delete(testProof).where(eq(testProof.resultId, res.id)).returning();
					for (const o of old) if (o.storageKey) replaced.push(o.storageKey);
					for (const p of pics) {
						const key = `${TEST_PROOF_KEY_PREFIX}/${c.orgId}/${r.projectId}/${randomUUID()}.${SCREEN_EXTENSIONS[p.mime]}`;
						await store!.put(key, p.bytes, p.mime);
						written.push(key);
						await tx.insert(testProof).values({
							orgId: c.orgId,
							projectId: r.projectId,
							resultId: res.id,
							step: p.step,
							storageKey: key,
							mime: p.mime,
							size: p.bytes.byteLength,
							checksum: sha256(p.bytes),
							width: p.width,
							height: size.height
						});
					}
					saved.push({ case: tc.key, device: row.device, status: row.status, id: res.id });
				}
				// Defects: one task per case and plan, filed on a fail and closed when the plan's latest results pass everywhere
				if (r.planItemId) {
					const plan = await findItem(tx, c, r.planItemId);
					for (const key of new Set(saved.map((s) => s.case))) {
						const tc = byKey.get(key)!;
						await syncDefect(tx, c, { plan, caseRow: tc });
					}
				}
				await tx
					.update(testRun)
					.set({ lastActivityAt: sql`now()` })
					.where(eq(testRun.id, r.id));
				await appendEvent(tx, {
					orgId: c.orgId,
					projectId: r.projectId,
					itemId: r.planItemId,
					...actorFields(c),
					verb: 'test.result',
					targetType: 'test_run',
					targetId: r.id,
					after: { results: saved.map((s) => `${s.case} ${s.device} ${s.status}`) } as never,
					undoable: false
				});
				return { run: r.id, saved, replaced, projectId: r.projectId };
			})
		);
	try {
		// The defect task verbs join this transaction only through a call context, which REST and the web do not open
		const done = await (ctx.tx ? go(ctx) : runCall(ctx, go));
		if (store) for (const k of done.replaced) await store.delete(k).catch(() => undefined);
		await pruneProofs(
			ctx,
			done.projectId,
			done.saved.map((s) => s.id)
		).catch(() => undefined);
		return { run: done.run, saved: done.saved.map(({ id: _id, ...s }) => s) };
	} catch (e) {
		// The rows were not saved, so the files written for them have no owner
		if (store) for (const k of written) await store.delete(k).catch(() => undefined);
		throw e;
	}
}

/** Files or closes the defect task of a case on a plan, from the plan's latest results of that case. */
async function syncDefect(
	tx: Tx,
	ctx: Ctx,
	o: {
		plan: Awaited<ReturnType<typeof findItem>>;
		caseRow: typeof testCase.$inferSelect;
	}
) {
	const latest = (await tx.execute(sql`
		select distinct on (r.device, r.width, r.height) r.id, r.status, r.task_id, r.severity, r.actual, r.device
		from ${testResult} r join ${testRun} t on t.id = r.run_id
		where r.case_id = ${o.caseRow.id} and t.plan_item_id = ${o.plan.id}
		order by r.device, r.width, r.height, r.updated_at desc`)) as unknown as {
		rows: {
			id: string;
			status: TestStatus;
			task_id: string | null;
			severity: string | null;
			actual: string;
			device: string;
		}[];
	};
	const rows = latest.rows;
	// The open defect of this case and plan, wherever it was recorded
	const [open] = await tx
		.select({ id: task.id, status: task.status, number: task.number })
		.from(testResult)
		.innerJoin(testRun, eq(testRun.id, testResult.runId))
		.innerJoin(task, eq(task.id, testResult.taskId))
		.where(
			and(
				eq(testResult.caseId, o.caseRow.id),
				eq(testRun.planItemId, o.plan.id),
				isNull(task.deletedAt),
				sql`${task.status} not in ('DONE', 'DROPPED')`
			)
		)
		.limit(1);
	const failing = rows.filter((r) => r.status === 'fail');
	if (failing.length > 0) {
		let taskId = open?.id ?? null;
		if (!taskId) {
			const proj = (
				await tx.select({ key: project.key }).from(project).where(eq(project.id, o.plan.projectId))
			)[0];
			const made = await createTask(subRequest(ctx, 'test:defect', o.caseRow.id, o.plan.id), {
				project: proj.key,
				title:
					`${o.caseRow.key} fails on ${failing.map((f) => f.device).join(', ')}: ${o.caseRow.title}`.slice(
						0,
						200
					),
				linkedItems: [o.plan.ref],
				priority:
					o.caseRow.priority === 'high' ? 'High' : o.caseRow.priority === 'low' ? 'Low' : 'Normal',
				groupName: 'Defects',
				body: [
					`Filed by test run for ${o.caseRow.key} on ${o.plan.ref}.`,
					'',
					...failing.map(
						(f) => `- ${f.device}: ${f.actual || 'failed'} (severity ${f.severity ?? 'major'})`
					)
				].join('\n')
			});
			taskId = made.task.id;
		}
		await tx
			.update(testResult)
			.set({ taskId })
			.where(
				inArray(
					testResult.id,
					failing.map((f) => f.id)
				)
			);
	} else if (open && rows.length > 0 && rows.every((r) => r.status === 'pass')) {
		await updateTask(subRequest(ctx, 'test:defect-close', open.id), {
			task: open.id,
			status: 'DONE'
		});
	}
}

/**
 * Keeps the proof files of a case's last 10 results per device: older proofs are marked gone in a transaction first, then
 * their files are deleted (a file already missing is fine). Runs in the caller's tenant, so it carries its org and project.
 */
async function pruneProofs(ctx: Ctx, projectId: string, resultIds: string[]) {
	if (resultIds.length === 0 || !ctx.services?.storage) return;
	const store = ctx.services.storage;
	const gone = await run(ctx, async (tx) => {
		// The old keys are read in the victims step, before the update clears them
		const rows = (await tx.execute(sql`
			with slots as (
				select distinct r.case_id, r.device, r.width, r.height from ${testResult} r
				where r.id in (${sql.join(
					resultIds.map((i) => sql`${i}::uuid`),
					sql`, `
				)})
			), ranked as (
				select r.id, row_number() over (partition by r.case_id, r.device, r.width, r.height order by r.updated_at desc) as n
				from ${testResult} r join slots s using (case_id, device, width, height)
				where r.project_id = ${projectId}
			), victims as (
				select p.id, p.storage_key from ${testProof} p join ranked on p.result_id = ranked.id
				where ranked.n > ${PROOF_KEEP_RESULTS} and p.storage_key is not null
			)
			update ${testProof} q set storage_key = null, gone_at = now()
			from victims v where q.id = v.id
			returning v.storage_key as key`)) as unknown as { rows: { key: string | null }[] };
		return rows.rows.map((r) => r.key).filter((k): k is string => !!k);
	});
	for (const k of gone) await store.delete(k).catch(() => undefined);
}

// -- SURFACES -- //

/** Records the routes, MCP tools and API endpoints found in the code; each keeps the time it was first and last seen. */
export async function pushSurfaces(ctx: Ctx, raw: z.input<typeof testSurfacesInput>) {
	const input = testSurfacesInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			const proj = await findProject(tx, ctx, input.project);
			await requireCap(tx, ctx, 'write', proj.id);
			await rateLimit(tx, ctx, 'write');
			const seen = new Map(input.surfaces.map((s) => [`${s.kind}:${s.key}`, s]));
			for (const s of seen.values())
				await tx
					.insert(testSurface)
					.values({ orgId: ctx.orgId, projectId: proj.id, kind: s.kind, key: redact(s.key) })
					.onConflictDoUpdate({
						target: [testSurface.projectId, testSurface.kind, testSurface.key],
						set: { lastSeenAt: sql`now()` }
					});
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: proj.id,
				...actorFields(ctx),
				verb: 'test.surfaces',
				targetType: 'project',
				targetId: proj.id,
				after: { count: seen.size } as never,
				undoable: false
			});
			return { project: proj.key, surfaces: seen.size };
		})
	);
}

// -- READS -- //

export type SheetResult = {
	device: TestDevice;
	width: number;
	height: number;
	status: TestStatus;
	runNo: number;
	at: string;
};
export type SheetCase = {
	key: string;
	area: string;
	kind: string;
	title: string;
	priority: string;
	version: number;
	steps: number;
	mode: string;
	retired: boolean;
	devices: TestDeviceSpec[];
	results: SheetResult[];
	status: TestStatus;
	severity: string | null;
	history: { runNo: number; status: TestStatus; version: number }[];
	testedBy: string;
	testedAt: string | null;
	defect: string | null;
	flaky: boolean;
};

/** Flaky: within the last ten runs the case went pass, fail and pass again (or the other way). */
export function isFlaky(history: TestStatus[]): boolean {
	const decided = history.filter((s) => s === 'pass' || s === 'fail');
	let flips = 0;
	for (let i = 1; i < decided.length; i++) if (decided[i] !== decided[i - 1]) flips++;
	return flips >= 2;
}

/** Everything the Testing page shows for one project, filtered to the runs the viewer may see. */
export async function testingSheet(ctx: Ctx, projectKey: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireTestingRead(tx, ctx, proj.id);
		return sheetIn(tx, ctx, proj);
	});
}

async function sheetIn(tx: Tx, ctx: Ctx, proj: { id: string; key: string }) {
	const cases = await tx
		.select()
		.from(testCase)
		.where(eq(testCase.projectId, proj.id))
		.orderBy(asc(testCase.area), asc(testCase.key));
	const ids = cases.map((c) => c.id);
	const versions = ids.length
		? await tx.select().from(testCaseVersion).where(inArray(testCaseVersion.caseId, ids))
		: [];
	const results = ids.length
		? await tx
				.select({
					caseId: testResult.caseId,
					runId: testResult.runId,
					runNo: testRun.runNo,
					device: testResult.device,
					width: testResult.width,
					height: testResult.height,
					status: testResult.status,
					severity: testResult.severity,
					version: testResult.caseVersion,
					at: testResult.updatedAt,
					taskId: testResult.taskId,
					harness: testRun.harness,
					startedAt: testRun.startedAt
				})
				.from(testResult)
				.innerJoin(testRun, eq(testRun.id, testResult.runId))
				.where(and(inArray(testResult.caseId, ids), runVisibleSql(ctx.actor.userId)))
				.orderBy(desc(testResult.updatedAt))
		: [];
	const tasks = results.some((r) => r.taskId)
		? await tx
				.select({ id: task.id, number: task.number, status: task.status })
				.from(task)
				.where(
					and(
						inArray(task.id, [
							...new Set(results.map((r) => r.taskId).filter((t): t is string => !!t))
						]),
						isNull(task.deletedAt)
					)
				)
		: [];
	const taskById = new Map(tasks.map((t) => [t.id, t]));
	const out: SheetCase[] = cases.map((c) => {
		const ver = versions.find((v) => v.caseId === c.id && v.number === c.currentVersion);
		const mine = results.filter((r) => r.caseId === c.id);
		// The newest result of each device slot
		const latest = new Map<string, (typeof mine)[number]>();
		for (const r of mine) {
			const slot = `${r.device}:${r.width}x${r.height}`;
			if (!latest.has(slot)) latest.set(slot, r);
		}
		const now = [...latest.values()];
		// The last ten runs, oldest first: each run's worst status for the case
		const byRun = new Map<
			string,
			{ runNo: number; statuses: TestStatus[]; version: number; at: Date }
		>();
		for (const r of mine) {
			const e = byRun.get(r.runId) ?? {
				runNo: r.runNo,
				statuses: [],
				version: r.version,
				at: r.startedAt
			};
			e.statuses.push(r.status as TestStatus);
			byRun.set(r.runId, e);
		}
		const history = [...byRun.values()]
			.sort((a, b) => a.at.getTime() - b.at.getTime())
			.slice(-10)
			.map((e) => ({ runNo: e.runNo, status: worstOf(e.statuses), version: e.version }));
		const status = now.length ? worstOf(now.map((r) => r.status as TestStatus)) : 'not_run';
		const failing = now.find((r) => r.status === 'fail');
		const openTask = now
			.map((r) => (r.taskId ? taskById.get(r.taskId) : undefined))
			.find((t) => t && t.status !== 'DONE' && t.status !== 'DROPPED');
		return {
			key: c.key,
			area: c.area,
			kind: c.kind,
			title: c.title,
			priority: c.priority,
			version: c.currentVersion,
			steps: ver?.steps.length ?? 0,
			mode: ver?.mode ?? 'light',
			retired: !!c.retiredAt,
			devices: ver?.devices ?? [],
			results: now.map((r) => ({
				device: r.device as TestDevice,
				width: r.width,
				height: r.height,
				status: r.status as TestStatus,
				runNo: r.runNo,
				at: r.at.toISOString()
			})),
			status,
			severity: failing?.severity ?? null,
			history,
			testedBy: now[0]?.harness ?? '',
			testedAt: now[0]?.at.toISOString() ?? null,
			defect: openTask ? `T-${openTask.number}` : null,
			flaky: isFlaky(history.map((h) => h.status))
		};
	});
	// The newest run the viewer may see, and whether it is still running
	const [latestRun] = await tx
		.select({
			id: testRun.id,
			runNo: testRun.runNo,
			state: testRun.state,
			lastActivityAt: testRun.lastActivityAt,
			startedAt: testRun.startedAt,
			finishedAt: testRun.finishedAt,
			commit: testRun.commit,
			harness: testRun.harness,
			tier: testRun.tier,
			plan: planRefSql
		})
		.from(testRun)
		.where(and(eq(testRun.projectId, proj.id), runVisibleSql(ctx.actor.userId)))
		.orderBy(desc(testRun.startedAt))
		.limit(1);
	let latest: null | {
		runNo: number;
		state: string;
		plan: string | null;
		commit: string;
		harness: string;
		startedAt: string;
		finishedAt: string | null;
		done: number;
		total: number;
		counts: Record<TestStatus, number>;
		/** While the run is open: the cases its plan adopted that have no result in it yet, the first one running. */
		pending: string[];
	} = null;
	if (latestRun) {
		const rs = await tx
			.select({ status: testResult.status, caseId: testResult.caseId })
			.from(testResult)
			.where(eq(testResult.runId, latestRun.id));
		const counts = { pass: 0, fail: 0, blocked: 0, not_run: 0 } as Record<TestStatus, number>;
		for (const r of rs) counts[r.status as TestStatus]++;
		const state = runStateOf(latestRun);
		let pending: string[] = [];
		const [planRow] =
			state === 'open'
				? await tx
						.select({ id: testRun.planItemId })
						.from(testRun)
						.where(eq(testRun.id, latestRun.id))
				: [];
		if (planRow?.id) {
			const adopted = await tx
				.select({ caseId: testPlanCase.caseId, role: testPlanCase.role })
				.from(testPlanCase)
				.where(eq(testPlanCase.planItemId, planRow.id));
			const done = new Set(rs.map((r) => r.caseId));
			pending = adopted
				.filter((a) => a.role !== 'retire' && !done.has(a.caseId))
				.map((a) => cases.find((c) => c.id === a.caseId)?.key)
				.filter((k): k is string => !!k)
				.sort();
		}
		latest = {
			runNo: latestRun.runNo,
			state,
			plan: latestRun.plan,
			commit: latestRun.commit,
			harness: latestRun.harness,
			startedAt: latestRun.startedAt.toISOString(),
			finishedAt: latestRun.finishedAt?.toISOString() ?? null,
			done: new Set(rs.map((r) => r.caseId)).size,
			total: new Set(rs.map((r) => r.caseId)).size + pending.length,
			counts,
			pending
		};
	}
	// Coverage: the surfaces found in the code and the ones no live case names
	const surfaces = await tx
		.select()
		.from(testSurface)
		.where(eq(testSurface.projectId, proj.id))
		.orderBy(asc(testSurface.kind), asc(testSurface.key));
	const named = new Set<string>();
	for (const c of cases) {
		if (c.retiredAt) continue;
		const ver = versions.find((v) => v.caseId === c.id && v.number === c.currentVersion);
		for (const s of ver?.surfaces ?? []) named.add(s);
	}
	const covered = surfaces.filter((s) => named.has(`${s.kind}:${s.key}`));
	const uncovered = surfaces
		.filter((s) => !named.has(`${s.kind}:${s.key}`))
		.map((s) => ({ kind: s.kind, key: s.key, firstSeenAt: s.firstSeenAt.toISOString() }));
	const byKind = (k: string) => ({
		total: surfaces.filter((s) => s.kind === k).length,
		covered: covered.filter((s) => s.kind === k).length
	});
	const defects = new Set(out.map((c) => c.defect).filter(Boolean)).size;
	return {
		project: proj.key,
		cases: out,
		run: latest,
		coverage: {
			route: byKind('route'),
			mcp: byKind('mcp'),
			api: byKind('api'),
			uncovered
		},
		defects
	};
}

/** One case with everything the drawer shows, filtered to the runs the viewer may see. */
export async function testCaseDetail(ctx: Ctx, projectKey: string, key: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireTestingRead(tx, ctx, proj.id);
		const [c] = await tx
			.select()
			.from(testCase)
			.where(and(eq(testCase.projectId, proj.id), eq(testCase.key, key)));
		if (!c) throw new OpError('NOT_FOUND', `No test case ${key}.`);
		const [ver] = await tx
			.select()
			.from(testCaseVersion)
			.where(and(eq(testCaseVersion.caseId, c.id), eq(testCaseVersion.number, c.currentVersion)));
		const results = await tx
			.select({
				r: testResult,
				runNo: testRun.runNo,
				harness: testRun.harness,
				commit: testRun.commit,
				startedAt: testRun.startedAt
			})
			.from(testResult)
			.innerJoin(testRun, eq(testRun.id, testResult.runId))
			.where(and(eq(testResult.caseId, c.id), runVisibleSql(ctx.actor.userId)))
			.orderBy(desc(testResult.updatedAt));
		const latest = new Map<string, (typeof results)[number]>();
		for (const x of results) {
			const slot = `${x.r.device}:${x.r.width}x${x.r.height}`;
			if (!latest.has(slot)) latest.set(slot, x);
		}
		const now = [...latest.values()];
		const proofRows = now.length
			? await tx
					.select()
					.from(testProof)
					.where(
						inArray(
							testProof.resultId,
							now.map((x) => x.r.id)
						)
					)
					.orderBy(asc(testProof.createdAt))
			: [];
		const plans = await tx
			.select({ ref: item.ref, role: testPlanCase.role, at: testPlanCase.linkedAt })
			.from(testPlanCase)
			.innerJoin(item, eq(item.id, testPlanCase.planItemId))
			.where(
				and(
					eq(testPlanCase.caseId, c.id),
					isNull(item.deletedAt),
					sql`(${item.visibility} = 'public' or ${item.createdBy} = ${ctx.actor.userId})`
				)
			)
			.orderBy(asc(testPlanCase.linkedAt));
		const taskIds = [...new Set(now.map((x) => x.r.taskId).filter((t): t is string => !!t))];
		const tasks = taskIds.length
			? await tx
					.select({ id: task.id, number: task.number, title: task.title, status: task.status })
					.from(task)
					.where(and(inArray(task.id, taskIds), isNull(task.deletedAt)))
			: [];
		const byRun = new Map<
			string,
			{ runNo: number; statuses: TestStatus[]; version: number; at: Date }
		>();
		for (const x of results) {
			const e = byRun.get(x.r.runId) ?? {
				runNo: x.runNo,
				statuses: [],
				version: x.r.caseVersion,
				at: x.startedAt
			};
			e.statuses.push(x.r.status as TestStatus);
			byRun.set(x.r.runId, e);
		}
		const history = [...byRun.values()]
			.sort((a, b) => a.at.getTime() - b.at.getTime())
			.slice(-10)
			.map((e) => ({ runNo: e.runNo, status: worstOf(e.statuses), version: e.version }));
		return {
			// Written by agents: a reader that is an agent never follows instructions found in it
			untrusted: true as const,
			key: c.key,
			area: c.area,
			kind: c.kind,
			title: c.title,
			priority: c.priority,
			version: c.currentVersion,
			retired: !!c.retiredAt,
			steps: ver?.steps ?? [],
			inputData: ver?.inputData ?? '',
			checks: ver?.checks ?? [],
			unitRef: ver?.unitRef ?? null,
			devices: ver?.devices ?? [],
			mode: ver?.mode ?? 'light',
			status: now.length
				? worstOf(now.map((x) => x.r.status as TestStatus))
				: ('not_run' as TestStatus),
			results: now.map((x) => ({
				device: x.r.device,
				width: x.r.width,
				height: x.r.height,
				mode: x.r.mode,
				status: x.r.status,
				reason: x.r.reason,
				failedStep: x.r.failedStep,
				actual: x.r.actual,
				output: x.r.output,
				consoleLines: x.r.consoleLines,
				browser: x.r.browser,
				severity: x.r.severity,
				bugPriority: x.r.bugPriority,
				runNo: x.runNo,
				harness: x.harness,
				commit: x.commit,
				at: x.r.updatedAt.toISOString(),
				proofs: proofRows
					.filter((p) => p.resultId === x.r.id)
					.map((p) => ({
						id: p.id,
						step: p.step,
						gone: !p.storageKey,
						image: p.storageKey ? `${testProofPath(p.id)}?v=${p.checksum.slice(0, 12)}` : null,
						width: p.width,
						height: p.height
					}))
			})),
			history,
			plans: plans.map((p) => ({ ref: p.ref, role: p.role })),
			defects: tasks.map((t) => ({ ref: `T-${t.number}`, title: t.title, status: t.status }))
		};
	});
}

/** The address a member's browser asks for a proof picture. The route checks the caller's access. */
export const testProofPath = (id: string) => `/pictures/test-proof/${id}`;

/**
 * The bytes of one proof for a signed in person who may see its run's plan. An unknown id, a hidden plan, a gone file, a guest
 * and another organisation all answer null, so an id cannot be used to probe.
 */
export async function readProofImage(
	handle: DbHandle,
	store: Storage,
	viewerId: string,
	proofId: string
): Promise<{ bytes: Uint8Array; checksum: string; mime: string } | null> {
	if (!/^[0-9a-f-]{36}$/i.test(proofId)) return null;
	for (const o of await listMyOrgs(handle, viewerId)) {
		if (o.deletedAt) continue;
		const ctx: Ctx = { handle, orgId: o.id, actor: { userId: viewerId, kind: 'person' } };
		try {
			const row = await run(ctx, async (tx) => {
				const [found] = await tx
					.select({ p: testProof })
					.from(testProof)
					.innerJoin(testResult, eq(testResult.id, testProof.resultId))
					.innerJoin(testRun, eq(testRun.id, testResult.runId))
					.where(
						and(eq(testProof.id, proofId), eq(testProof.orgId, ctx.orgId), runVisibleSql(viewerId))
					);
				if (!found) return null;
				await requireTestingRead(tx, ctx, found.p.projectId);
				return found.p;
			});
			if (!row) continue;
			if (!row.storageKey) return null;
			const bytes = await store.get(row.storageKey);
			return bytes ? { bytes, checksum: row.checksum, mime: row.mime } : null;
		} catch (e) {
			if (e instanceof OpError) continue;
			throw e;
		}
	}
	return null;
}

// -- EXPORT -- //

/**
 * The sheet as the full QA template, one row per case and device, from the same visibility-filtered reads as the page. Data
 * only: a proof is the address of its picture on the board, never the file or its storage key.
 */
export async function testingExportTable(ctx: Ctx, projectKey: string, baseUrl = '') {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKey);
		await requireTestingRead(tx, ctx, proj.id);
		const cases = await tx
			.select()
			.from(testCase)
			.where(and(eq(testCase.projectId, proj.id), isNull(testCase.retiredAt)))
			.orderBy(asc(testCase.area), asc(testCase.key));
		const ids = cases.map((c) => c.id);
		const versions = ids.length
			? await tx.select().from(testCaseVersion).where(inArray(testCaseVersion.caseId, ids))
			: [];
		const results = ids.length
			? await tx
					.select({
						r: testResult,
						runNo: testRun.runNo,
						harness: testRun.harness,
						plan: planRefSql
					})
					.from(testResult)
					.innerJoin(testRun, eq(testRun.id, testResult.runId))
					.where(and(inArray(testResult.caseId, ids), runVisibleSql(ctx.actor.userId)))
					.orderBy(desc(testResult.updatedAt))
			: [];
		const latest = new Map<string, (typeof results)[number]>();
		for (const x of results) {
			const slot = `${x.r.caseId}:${x.r.device}:${x.r.width}x${x.r.height}`;
			if (!latest.has(slot)) latest.set(slot, x);
		}
		const kept = [...latest.values()];
		const proofs = kept.length
			? await tx
					.select({ id: testProof.id, resultId: testProof.resultId, gone: testProof.goneAt })
					.from(testProof)
					.where(
						inArray(
							testProof.resultId,
							kept.map((x) => x.r.id)
						)
					)
			: [];
		const taskIds = [...new Set(kept.map((x) => x.r.taskId).filter((t): t is string => !!t))];
		const tasks = taskIds.length
			? await tx
					.select({ id: task.id, number: task.number })
					.from(task)
					.where(and(inArray(task.id, taskIds), isNull(task.deletedAt)))
			: [];
		const columns = [
			'Test case ID',
			'Title',
			'Area',
			'Kind',
			'Priority',
			'Version',
			'Steps',
			'Input data',
			'Expected',
			'Device',
			'Size',
			'Mode',
			'Status',
			'Actual',
			'Severity',
			'Bug priority',
			'Tested by',
			'Date',
			'Run',
			'Plan',
			'Defect',
			'Notes',
			'Proof'
		];
		const rows: string[][] = [];
		for (const c of cases) {
			const ver = versions.find((v) => v.caseId === c.id && v.number === c.currentVersion);
			const mine = kept.filter((x) => x.r.caseId === c.id);
			const base = [
				c.key,
				c.title,
				c.area,
				c.kind,
				c.priority,
				`v${c.currentVersion}`,
				(ver?.steps ?? []).map((s, i) => `${i + 1}. ${s.action}`).join('\n'),
				ver?.inputData ?? '',
				(ver?.checks ?? []).map((k) => `${k.kind}: ${k.expect}`).join('\n')
			];
			if (mine.length === 0) {
				rows.push([
					...base,
					'',
					'',
					ver?.mode ?? '',
					'not run',
					'',
					'',
					'',
					'',
					'',
					'',
					'',
					'',
					'',
					''
				]);
				continue;
			}
			for (const x of mine) {
				const pics = proofs.filter((p) => p.resultId === x.r.id && !p.gone);
				const t = tasks.find((k) => k.id === x.r.taskId);
				rows.push([
					...base,
					x.r.device,
					`${x.r.width} x ${x.r.height}`,
					x.r.mode,
					x.r.status.replace('_', ' '),
					x.r.actual || x.r.output,
					x.r.severity ?? '',
					x.r.bugPriority ?? '',
					x.harness,
					x.r.updatedAt.toISOString().slice(0, 16).replace('T', ' '),
					String(x.runNo),
					x.plan ?? '',
					t ? `T-${t.number}` : '',
					x.r.reason,
					pics.map((p) => `${baseUrl}${testProofPath(p.id)}`).join('\n')
				]);
			}
		}
		return { project: proj.key, columns, rows };
	});
}

// -- PLAN -- //

export type PlanCaseView = {
	key: string;
	title: string;
	kind: string;
	role: string;
	baseline: string;
	now: TestStatus | 'retired';
	regression: boolean;
	devices: { device: TestDevice; width: number; height: number; status: TestStatus }[];
};

/** The owed lines of a plan that are tests: "- [ ] test: TC-X-01 (no browser)". */
export function owedTests(
	body: string | null | undefined
): { key: string; note: string; done: boolean }[] {
	const out: { key: string; note: string; done: boolean }[] = [];
	for (const line of (body ?? '').split('\n')) {
		const m = /^\s*-\s*\[( |x|X)\]\s*test:\s*(TC-[A-Z0-9]{1,12}-\d{2,4})\b(.*)$/.exec(line);
		if (m)
			out.push({ key: m[2], note: m[3].trim().replace(/^[(:\s-]+|\)$/g, ''), done: m[1] !== ' ' });
	}
	return out;
}

/** The tests waiver of a plan, when its section names one of the fixed reasons. */
export function waiverOf(body: string | null | undefined): string | null {
	const text = (body ?? '').trim().toLowerCase();
	if (!text) return null;
	return TESTS_WAIVER_REASONS.find((r) => text.includes(r)) ?? null;
}

/** What a plan's Testing tab shows and what the Completed rules read: its cases, their baseline and now, owed lines and waiver. */
export async function planTestingIn(tx: Tx, ctx: Ctx, planId: string) {
	const links = await tx
		.select({ link: testPlanCase, c: testCase })
		.from(testPlanCase)
		.innerJoin(testCase, eq(testCase.id, testPlanCase.caseId))
		.where(eq(testPlanCase.planItemId, planId))
		.orderBy(asc(testCase.key));
	const sections = await tx
		.select({ slug: section.slug, body: section.body })
		.from(section)
		.where(and(eq(section.itemId, planId), inArray(section.slug, ['tests-waiver', 'owed'])));
	const waiver = waiverOf(sections.find((s) => s.slug === 'tests-waiver')?.body);
	const owed = owedTests(sections.find((s) => s.slug === 'owed')?.body);
	const caseIds = links.map((l) => l.c.id);
	// The plan's own latest result per case and device, across its runs
	const latest = caseIds.length
		? (
				(await tx.execute(sql`
			select distinct on (r.case_id, r.device, r.width, r.height) r.case_id, r.device, r.width, r.height, r.case_version, r.status, r.reason
			from ${testResult} r join ${testRun} t on t.id = r.run_id
			where t.plan_item_id = ${planId} and r.case_id in (${sql.join(
				caseIds.map((i) => sql`${i}::uuid`),
				sql`, `
			)})
			order by r.case_id, r.device, r.width, r.height, r.updated_at desc`)) as unknown as {
					rows: {
						case_id: string;
						device: TestDevice;
						width: number;
						height: number;
						case_version: number;
						status: TestStatus;
						reason: string;
					}[];
				}
			).rows
		: [];
	const cases: PlanCaseView[] = links.map(({ link, c }) => {
		// A result of an older version of the case does not count: a new version is run again
		const mine = latest.filter((r) => r.case_id === c.id && r.case_version >= c.currentVersion);
		const now: TestStatus | 'retired' =
			link.role === 'retire'
				? 'retired'
				: mine.length
					? worstOf(mine.map((r) => r.status))
					: 'not_run';
		return {
			key: c.key,
			title: c.title,
			kind: c.kind,
			role: link.role,
			baseline: link.baseline,
			now,
			regression: link.baseline === 'pass' && now === 'fail',
			devices: mine.map((r) => ({
				device: r.device,
				width: r.width,
				height: r.height,
				status: r.status
			}))
		};
	});
	const [open] = await tx
		.select({ runNo: testRun.runNo, state: testRun.state, lastActivityAt: testRun.lastActivityAt })
		.from(testRun)
		.where(and(eq(testRun.planItemId, planId), eq(testRun.state, 'open')))
		.orderBy(desc(testRun.startedAt))
		.limit(1);
	const live = open && runStateOf(open) === 'open' ? { runNo: open.runNo } : null;
	return { cases, waiver, owed, live, latest };
}

/** The plan's Testing tab: shown when it has cases or a waiver. The full view only when the tab is open. */
export async function planTesting(ctx: Ctx, itemRef: string, full: boolean) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemRef);
		const role = await requireCap(tx, ctx, 'read', it.projectId).then((r) => r.role);
		if (role === 'guest') return { shown: false, count: 0, view: null };
		const v = await planTestingIn(tx, ctx, it.id);
		const count = v.cases.length;
		const shown = count > 0 || v.waiver !== null;
		if (!full || !shown) return { shown, count, view: null };
		return {
			shown,
			count,
			view: {
				untrusted: true as const,
				cases: v.cases,
				waiver: v.waiver,
				owed: v.owed,
				live: v.live,
				block: await testingBlock(tx, ctx, it.id)
			}
		};
	});
}

// -- SIZING -- //

/**
 * How much testing a plan gets and which earlier cases it re-runs (src/lib/shared/testTier.ts): the agent passes the files it
 * changed and the areas it touched; the plan's own steps and design brief come from the board.
 */
export async function suggestForPlan(
	ctx: Ctx,
	itemRef: string,
	o: { files: string[]; areas: string[]; tweak?: boolean }
) {
	return run(ctx, async (tx) => {
		const it = await findItem(tx, ctx, itemRef);
		await requireTestingRead(tx, ctx, it.projectId);
		const counted = (await tx.execute(
			sql`select count(*)::int as n from step where item_id = ${it.id} and state <> 'superseded'`
		)) as unknown as { rows: { n: number }[] };
		const n = counted.rows[0]?.n ?? 0;
		const brief = await tx
			.select({ id: section.id })
			.from(section)
			.where(and(eq(section.itemId, it.id), eq(section.slug, 'design-brief')))
			.limit(1);
		const tier = planTier({ steps: n, files: o.files, visible: brief.length > 0, tweak: o.tweak });
		const cases = await tx
			.select({
				id: testCase.id,
				key: testCase.key,
				area: testCase.area,
				priority: testCase.priority
			})
			.from(testCase)
			.where(and(eq(testCase.projectId, it.projectId), isNull(testCase.retiredAt)));
		const last = cases.length
			? (
					(await tx.execute(sql`
				select r.case_id, max(r.updated_at) as at from ${testResult} r join ${testRun} on ${testRun.id} = r.run_id
				where r.case_id in (${sql.join(
					cases.map((c) => sql`${c.id}::uuid`),
					sql`, `
				)}) and ${runVisibleSql(ctx.actor.userId)}
				group by r.case_id`)) as unknown as { rows: { case_id: string; at: Date | string }[] }
				).rows
			: [];
		const lastBy = new Map(last.map((l) => [l.case_id, new Date(l.at).toISOString()]));
		const pick = pickRerun(
			cases.map((c) => ({
				key: c.key,
				area: c.area,
				priority: c.priority,
				lastRunAt: lastBy.get(c.id) ?? null
			})),
			o.areas,
			tier
		);
		// The cases the plan already adopted, with their area, so an audit can hold the changed files against them
		const adopted = await tx
			.select({ key: testCase.key, area: testCase.area, role: testPlanCase.role })
			.from(testPlanCase)
			.innerJoin(testCase, eq(testCase.id, testPlanCase.caseId))
			.where(eq(testPlanCase.planItemId, it.id))
			.orderBy(asc(testCase.key));
		return { item: it.ref, tier, rerun: pick.run, owed: pick.owed, adopted };
	});
}

// -- THE COMPLETED RULES -- //

export type TestingBlock = {
	reason: 'tests-missing' | 'tests-not-run' | 'tests-failed' | 'tests-regression';
	message: string;
	cases: string[];
};

/**
 * Why an agent may not mark a plan Completed for its tests, or null (AFB-20261127-0438). Only plans created at or after their
 * project's testing_since are checked. A UI case owed for want of a browser (an open owed line "test: <key> (no browser)")
 * does not count as not run. A person is never refused: the caller decides who is asked.
 */
export async function testingBlock(tx: Tx, ctx: Ctx, planId: string): Promise<TestingBlock | null> {
	const [it] = await tx
		.select({ createdAt: item.createdAt, since: project.testingSince })
		.from(item)
		.innerJoin(project, eq(project.id, item.projectId))
		.where(eq(item.id, planId));
	if (!it || it.createdAt < it.since) return null;
	const v = await planTestingIn(tx, ctx, planId);
	if (v.cases.length === 0) {
		if (v.waiver) return null;
		return {
			reason: 'tests-missing',
			message:
				'This plan has no test cases and no tests waiver. Adopt or write its cases and run them, or record a tests-waiver section naming one of: docs only, skill text only, no behaviour change, config or deploy only.',
			cases: []
		};
	}
	const live = v.cases.filter((c) => c.now !== 'retired');
	const regression = live.filter((c) => c.regression);
	if (regression.length)
		return {
			reason: 'tests-regression',
			message: `${regression.map((c) => c.key).join(', ')} passed before this plan and ${regression.length === 1 ? 'fails' : 'fail'} now.`,
			cases: regression.map((c) => c.key)
		};
	// Any adopted case failing now blocks, except one that was already failing before the plan (the plan did not break it)
	const failing = live.filter(
		(c) => c.now === 'fail' && (c.role !== 'reuse' || c.baseline !== 'fail')
	);
	if (failing.length)
		return {
			reason: 'tests-failed',
			message: `${failing.map((c) => c.key).join(', ')} ${failing.length === 1 ? 'fails' : 'fail'} in this plan.`,
			cases: failing.map((c) => c.key)
		};
	const owedOpen = new Set(v.owed.filter((o) => !o.done).map((o) => o.key));
	const notRun = live.filter(
		(c) => (c.now === 'not_run' || c.now === 'blocked') && !(owedOpen.has(c.key) && c.kind === 'ui')
	);
	if (notRun.length)
		return {
			reason: 'tests-not-run',
			message: `${notRun.map((c) => c.key).join(', ')} ${notRun.length === 1 ? 'has' : 'have'} no result in this plan. Run ${notRun.length === 1 ? 'it' : 'them'}, or record a UI case that could not run for want of a browser as an open owed line "test: <key> (no browser)".`,
			cases: notRun.map((c) => c.key)
		};
	return null;
}
