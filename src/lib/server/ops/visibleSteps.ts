// VISIBLE STEPS, SERVER-VERIFIED COMPARE EVIDENCE, VERTICAL-SLICE GATE, AND OWNER WAIVERS (PHASE C, AFB-20261113-1008)

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { NamedMockupScreen } from '../../shared/screenGlobs';
import type { StepEvidence, StepEvidenceWaiver } from '../db/schema';
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import {
	DEFAULT_SCREEN_GLOBS,
	anyFileMatchesScreenGlobs,
	effectiveStepVisible,
	extractMockupScreensFromHtml,
	stepTextNamesScreen
} from '../../shared/screenGlobs';
import { recalcItem } from '../db/calc';
import { appendEvent } from '../db/events';
import {
	attachment,
	check,
	checkRun,
	item,
	member,
	mockup,
	mockupVersion,
	phase,
	project,
	projectMember,
	session,
	step,
	user
} from '../db/schema';
import { withTenant } from '../db/tenant';
import { OpError, idempotent, isLivePersonSession, rateLimit, requireCap, run } from './context';
import { notifyChange } from '../realtime/notify';
import { findItem, isUuid } from './resolve';
import { logSessionEvent } from './sessionEvents';
import { setSessionWaitingTx } from './waiting';

// -- TYPES -- //

export type ItemVisualContext = {
	projectId: string;
	screenGlobs: string[];
	visualEvidenceGate: boolean;
	hasMockup: boolean;
	linkedMockups: { id: string; currentVersion: number; title: string }[];
	mockupScreens: NamedMockupScreen[];
};

export type CompareVerifyInput = {
	commit?: string;
	checkRunId?: string;
	runIds?: string[];
	diffReportId?: string;
	target?: 'dev' | 'preview' | 'deployed';
	note?: string;
};

export type VerifiedCompareResult = {
	mockupId: string;
	mockupVersion: number;
	runIds: string[];
	diffReportId: string;
	screens: string[];
	widths: number[];
};

type ParsedComparePair = {
	screen: string;
	width: number;
	passed: boolean;
	mismatchCount: number;
	comparedCount: number | null;
	notComparedCount: number;
};

// -- CONSTANTS -- //

const COMPARE_REPORT_NAME = /^compare-(?:diff|summary)(?:[-._a-z0-9]*)?\.json$/i;

export const evidenceWaiveInput = z.object({
	item: z.string().min(1),
	key: z.string().regex(/^[0-9A-Za-z]+\.[0-9]+[a-z]?$/),
	reason: z.string().trim().min(3).max(500),
	expectVersion: z.number().int().optional()
});

// -- FUNCTIONS -- //

function actorOf(ctx: Ctx) {
	return {
		actorUserId: ctx.actor.userId,
		actorLabel: ctx.actor.label ?? null,
		tool: ctx.actor.tool ?? null,
		sessionId: ctx.actor.sessionId ?? null
	};
}

/** Exact CLI command named in VISUAL_EVIDENCE_REQUIRED refusals so agents and runners know what to run next. */
export function compareCommandHint(
	ref: string,
	stepKey: string,
	screens: readonly string[],
	widths: readonly number[]
): string {
	const screenArg = screens.length ? ` --screens ${screens.join(',')}` : '';
	const widthArg = widths.length ? ` --widths ${widths.join(',')}` : '';
	return `agent-flow-board check compare --item ${ref} --step ${stepKey}${screenArg}${widthArg}`;
}

/** Loads the project settings, non-trashed linked mockups, and declared mockup screens for one item. */
export async function loadItemVisualContext(
	tx: Tx,
	ctx: Ctx,
	itemId: string,
	projectId: string
): Promise<ItemVisualContext> {
	const [proj] = await tx
		.select({
			screenGlobs: project.screenGlobs,
			visualEvidenceGate: project.visualEvidenceGate
		})
		.from(project)
		.where(eq(project.id, projectId));
	const globs = proj?.screenGlobs?.length ? proj.screenGlobs : [...DEFAULT_SCREEN_GLOBS];
	const linked = await tx
		.select({
			id: mockup.id,
			currentVersion: mockup.currentVersion,
			title: mockup.title
		})
		.from(mockup)
		.where(and(eq(mockup.itemId, itemId), eq(mockup.orgId, ctx.orgId), isNull(mockup.trashedAt)));
	const mockupScreens: NamedMockupScreen[] = [];
	const seenScreens = new Set<string>();
	const pushScreen = (s: NamedMockupScreen) => {
		const k = s.key.trim().toLowerCase();
		if (!k || seenScreens.has(k)) return;
		seenScreens.add(k);
		mockupScreens.push(s);
	};
	if (linked.length) {
		const versions = await tx
			.select({
				mockupId: mockupVersion.mockupId,
				number: mockupVersion.number,
				screens: mockupVersion.screens,
				storageKey: mockupVersion.storageKey
			})
			.from(mockupVersion)
			.where(
				inArray(
					mockupVersion.mockupId,
					linked.map((m) => m.id)
				)
			);
		for (const m of linked) {
			const v = versions.find((r) => r.mockupId === m.id && r.number === m.currentVersion);
			if (!v) continue;
			if (Array.isArray(v.screens) && v.screens.length) {
				for (const s of v.screens) pushScreen(s);
			} else if (ctx.services?.storage) {
				const bytes = await ctx.services.storage.get(v.storageKey).catch(() => null);
				if (bytes) {
					const extracted = extractMockupScreensFromHtml(new TextDecoder().decode(bytes));
					for (const s of extracted) pushScreen(s);
				}
			}
		}
	}
	return {
		projectId,
		screenGlobs: globs,
		visualEvidenceGate: Boolean(proj?.visualEvidenceGate),
		hasMockup: linked.length > 0,
		linkedMockups: linked,
		mockupScreens
	};
}

/** True when a step should default to visible because the item has a linked mockup and the step touches screen files or names a screen. */
export function inferStepVisible(
	vis: Pick<ItemVisualContext, 'hasMockup' | 'mockupScreens' | 'screenGlobs'>,
	s: { text: string; files?: readonly string[]; screens?: readonly string[] }
): boolean {
	if (!vis.hasMockup) return false;
	if (s.screens && s.screens.length > 0) return true;
	if (s.files && anyFileMatchesScreenGlobs(s.files, vis.screenGlobs)) return true;
	return stepTextNamesScreen(s.text, vis.mockupScreens, vis.screenGlobs);
}

/** Recomputes `visibleInferred` for open steps on one item and logs `step.visibility` events for any changes. */
export async function refreshItemStepVisibility(tx: Tx, ctx: Ctx, itemId: string): Promise<void> {
	const [it] = await tx
		.select({ id: item.id, projectId: item.projectId })
		.from(item)
		.where(and(eq(item.id, itemId), eq(item.orgId, ctx.orgId)));
	if (!it) return;
	const vis = await loadItemVisualContext(tx, ctx, it.id, it.projectId);
	const openSteps = await tx
		.select({
			id: step.id,
			key: step.key,
			text: step.text,
			visible: step.visible,
			visibleInferred: step.visibleInferred,
			files: step.files,
			screens: step.screens
		})
		.from(step)
		.where(and(eq(step.itemId, it.id), eq(step.state, 'open')));
	for (const st of openSteps) {
		const nextInferred = inferStepVisible(vis, {
			text: st.text,
			files: st.files ?? [],
			screens: st.screens ?? []
		});
		if (nextInferred === st.visibleInferred) continue;
		await tx
			.update(step)
			.set({
				visibleInferred: nextInferred,
				updatedAt: sql`now()`,
				version: sql`${step.version} + 1`
			})
			.where(eq(step.id, st.id));
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: it.projectId,
			itemId: it.id,
			...actorOf(ctx),
			verb: 'step.visibility',
			targetType: 'step',
			targetId: st.id,
			before: {
				key: st.key,
				visible: st.visible,
				visibleInferred: st.visibleInferred,
				effectiveVisible: effectiveStepVisible(st)
			} as never,
			after: {
				key: st.key,
				visible: st.visible,
				visibleInferred: nextInferred,
				effectiveVisible: effectiveStepVisible({
					visible: st.visible,
					visibleInferred: nextInferred
				}),
				source: 'inference'
			} as never,
			undoable: false
		});
	}
}

/** Recomputes `visibleInferred` for open steps on items in a project that have a linked mockup. */
export async function refreshProjectStepVisibility(
	tx: Tx,
	ctx: Ctx,
	projectId: string
): Promise<void> {
	const linkedItems = await tx
		.selectDistinct({ itemId: mockup.itemId })
		.from(mockup)
		.where(
			and(
				eq(mockup.projectId, projectId),
				eq(mockup.orgId, ctx.orgId),
				isNull(mockup.trashedAt),
				sql`${mockup.itemId} is not null`
			)
		);
	for (const row of linkedItems) {
		if (row.itemId) await refreshItemStepVisibility(tx, ctx, row.itemId);
	}
}

function parseCompareReportJson(bytes: Uint8Array): {
	mockupId: string;
	mockupVersion: number;
	passed: boolean;
	totalMismatches: number;
	totalNotCompared: number;
	pairs: ParsedComparePair[];
} | null {
	try {
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
		const mockupId = typeof raw.mockupId === 'string' ? raw.mockupId : '';
		const mockupVersion =
			typeof raw.mockupVersion === 'number' && Number.isInteger(raw.mockupVersion)
				? raw.mockupVersion
				: 0;
		const passed = raw.passed === true;
		const totalMismatches =
			typeof raw.totalMismatches === 'number' && Number.isFinite(raw.totalMismatches)
				? raw.totalMismatches
				: 0;
		const totalNotCompared =
			typeof raw.totalNotCompared === 'number' && Number.isFinite(raw.totalNotCompared)
				? raw.totalNotCompared
				: 0;
		const pairsRaw = Array.isArray(raw.pairs) ? raw.pairs : [];
		const pairs: ParsedComparePair[] = [];
		for (const p of pairsRaw) {
			if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
			const rec = p as Record<string, unknown>;
			const screen = typeof rec.screen === 'string' ? rec.screen.trim() : '';
			const width = typeof rec.width === 'number' && Number.isFinite(rec.width) ? rec.width : 0;
			const nestedDiff =
				rec.diff && typeof rec.diff === 'object' && !Array.isArray(rec.diff)
					? (rec.diff as Record<string, unknown>)
					: null;
			const pairPassed = nestedDiff ? nestedDiff.passed === true : rec.passed === true;
			const mismatchCount = nestedDiff
				? Array.isArray(nestedDiff.mismatches)
					? nestedDiff.mismatches.length
					: 1
				: typeof rec.mismatchCount === 'number' && Number.isFinite(rec.mismatchCount)
					? rec.mismatchCount
					: 1;
			const comparedCount = nestedDiff
				? typeof nestedDiff.comparedCount === 'number' && Number.isFinite(nestedDiff.comparedCount)
					? nestedDiff.comparedCount
					: null
				: typeof rec.comparedCount === 'number' && Number.isFinite(rec.comparedCount)
					? rec.comparedCount
					: null;
			const notComparedCount = nestedDiff
				? Array.isArray(nestedDiff.notCompared)
					? nestedDiff.notCompared.length
					: 1
				: typeof rec.notComparedCount === 'number' && Number.isFinite(rec.notComparedCount)
					? rec.notComparedCount
					: 1;
			if (screen && width > 0) {
				pairs.push({
					screen,
					width,
					passed: pairPassed,
					mismatchCount,
					comparedCount,
					notComparedCount
				});
			}
		}
		if (!mockupId || mockupVersion < 1) return null;
		return { mockupId, mockupVersion, passed, totalMismatches, totalNotCompared, pairs };
	} catch {
		return null;
	}
}

/**
 * Verifies compare evidence on the server before marking an effectively-visible step done when the project's
 * visual-evidence gate is active. Refuses with VISUAL_EVIDENCE_REQUIRED (never writing anything) on any gap.
 */
export async function verifyCompareEvidenceForStep(
	tx: Tx,
	ctx: Ctx,
	it: { id: string; ref: string; projectId: string },
	stepRow: {
		key: string;
		screens: string[];
		widths: number[];
		evidence: StepEvidence | null;
	},
	vis: ItemVisualContext,
	evidence: CompareVerifyInput | undefined
): Promise<VerifiedCompareResult> {
	const nextCmd = compareCommandHint(
		it.ref,
		stepRow.key,
		stepRow.screens ?? [],
		stepRow.widths ?? []
	);
	const refuse = (reason: string): never => {
		throw new OpError(
			'VISUAL_EVIDENCE_REQUIRED',
			`Step ${stepRow.key} of ${it.ref} is visually verified and needs passed compare evidence: ${reason} Run: ${nextCmd}`,
			{
				reason: 'visual-evidence',
				step: stepRow.key,
				nextCommand: nextCmd
			}
		);
	};

	const rawIds = [
		...(evidence?.checkRunId ? [evidence.checkRunId] : []),
		...(evidence?.runIds ?? [])
	];
	const runIds = [...new Set(rawIds)];
	if (!runIds.length) {
		refuse('no compare check run id was provided.');
	}

	if (!vis.linkedMockups.length) {
		refuse('this item has no active linked mockup to compare against.');
	}

	const sessionState = ctx.actor.sessionId
		? (
				await tx
					.select({
						codeTouchedAt: session.codeTouchedAt,
						recordedState: session.recordedState
					})
					.from(session)
					.where(and(eq(session.id, ctx.actor.sessionId), eq(session.orgId, ctx.orgId)))
			)[0]
		: null;
	const [latestClaimedTouch] = await tx
		.select({ codeTouchedAt: session.codeTouchedAt })
		.from(session)
		.where(
			and(
				eq(session.orgId, ctx.orgId),
				eq(session.claimedItemId, it.id),
				isNotNull(session.codeTouchedAt)
			)
		)
		.orderBy(desc(session.codeTouchedAt))
		.limit(1);
	const latestCodeTouchedAt =
		sessionState?.codeTouchedAt && latestClaimedTouch?.codeTouchedAt
			? sessionState.codeTouchedAt.getTime() >= latestClaimedTouch.codeTouchedAt.getTime()
				? sessionState.codeTouchedAt
				: latestClaimedTouch.codeTouchedAt
			: (sessionState?.codeTouchedAt ?? latestClaimedTouch?.codeTouchedAt ?? null);
	const recordedDiffHash =
		sessionState?.recordedState &&
		typeof sessionState.recordedState === 'object' &&
		typeof (sessionState.recordedState as Record<string, unknown>).diffHash === 'string'
			? ((sessionState.recordedState as Record<string, unknown>).diffHash as string)
			: null;

	const coveredPairs: { screen: string; width: number }[] = [];
	let matchedMockup: { id: string; currentVersion: number } | null = null;
	let diffReportId: string | null = null;

	for (const runId of runIds) {
		if (!isUuid(runId)) refuse(`run id "${runId}" is not a valid UUID.`);
		const [runRow] = await tx
			.select({
				id: checkRun.id,
				result: checkRun.result,
				runnerId: checkRun.runnerId,
				diffHash: checkRun.diffHash,
				evidence: checkRun.evidence,
				finishedAt: checkRun.finishedAt,
				itemId: check.itemId,
				projectId: check.projectId
			})
			.from(checkRun)
			.innerJoin(check, eq(check.id, checkRun.checkId))
			.where(and(eq(checkRun.id, runId), eq(checkRun.orgId, ctx.orgId)));
		if (!runRow) refuse(`compare run ${runId} was not found in this organisation.`);
		if (runRow.itemId !== it.id || runRow.projectId !== it.projectId) {
			refuse(`compare run ${runId} belongs to another item or project, not ${it.ref}.`);
		}
		if (!runRow.runnerId) {
			refuse(`compare run ${runId} was not recorded through a bridge runner token.`);
		}
		const finishedAt = runRow.finishedAt;
		if (runRow.result !== 'pass' || !finishedAt) {
			return refuse(`compare run ${runId} did not pass (status ${runRow.result}).`);
		}
		if (latestCodeTouchedAt && finishedAt.getTime() < latestCodeTouchedAt.getTime()) {
			const digestMatches = Boolean(
				recordedDiffHash && runRow.diffHash && recordedDiffHash === runRow.diffHash
			);
			if (!digestMatches) {
				return refuse(
					`code was edited at ${latestCodeTouchedAt.toISOString()} after compare run ${runId} finished at ${finishedAt.toISOString()}. Re-run compare after the latest edit.`
				);
			}
		}

		const evIds = Array.isArray(runRow.evidence) ? runRow.evidence.filter(Boolean) : [];
		if (!evIds.length) {
			return refuse(`compare run ${runId} has no uploaded diff artifact.`);
		}
		const attRows = await tx
			.select({
				id: attachment.id,
				itemId: attachment.itemId,
				kind: attachment.kind,
				refs: attachment.refs,
				filename: attachment.filename,
				storageKey: attachment.storageKey
			})
			.from(attachment)
			.where(
				and(
					inArray(attachment.id, evIds),
					eq(attachment.itemId, it.id),
					isNull(attachment.deletedAt)
				)
			);
		const reportAtt = attRows.find(
			(a) =>
				a.kind === 'check-evidence' &&
				Array.isArray(a.refs) &&
				a.refs.includes(runId) &&
				COMPARE_REPORT_NAME.test(a.filename)
		);
		if (!reportAtt) {
			return refuse(`run ${runId} has no uploaded compare-diff or compare-summary artifact.`);
		}
		const storage = ctx.services?.storage;
		if (!storage) {
			return refuse(`compare report storage is unavailable on the server to verify run ${runId}.`);
		}
		const bytes = await storage.get(reportAtt.storageKey);
		if (!bytes) {
			refuse(`compare report blob for run ${runId} is missing from storage.`);
		}
		const parsed = parseCompareReportJson(bytes!);
		if (!parsed) {
			refuse(`compare report for run ${runId} is malformed.`);
		}
		const linked = vis.linkedMockups.find((m) => m.id === parsed!.mockupId);
		if (!linked) {
			refuse(
				`compare run ${runId} targeted mockup ${parsed!.mockupId}, which is not linked to ${it.ref}.`
			);
		}
		if (linked!.currentVersion !== parsed!.mockupVersion) {
			refuse(
				`compare run ${runId} targeted mockup v${parsed!.mockupVersion}, but the current mockup version is v${linked!.currentVersion}.`
			);
		}
		if (
			matchedMockup &&
			(matchedMockup.id !== linked!.id || matchedMockup.currentVersion !== linked!.currentVersion)
		) {
			refuse(`supplied compare runs reference different mockups or versions.`);
		}
		matchedMockup = linked!;
		if (!parsed!.passed || parsed!.totalMismatches > 0 || parsed!.totalNotCompared > 0) {
			refuse(
				`compare report for run ${runId} recorded ${parsed!.totalMismatches} unwaived mismatch(es), ${parsed!.totalNotCompared} uncompared item(s), or did not pass.`
			);
		}
		if (!parsed!.pairs.length) {
			refuse(`compare report for run ${runId} checked zero screen/width pairs.`);
		}
		for (const p of parsed!.pairs) {
			if (
				!p.passed ||
				p.mismatchCount > 0 ||
				p.notComparedCount > 0 ||
				p.comparedCount === null ||
				p.comparedCount <= 0
			) {
				refuse(
					`screen "${p.screen}" at ${p.width}px in run ${runId} did not complete full comparison (mismatches=${p.mismatchCount}, notCompared=${p.notComparedCount}, compared=${p.comparedCount ?? 'n/a'}).`
				);
			}
			coveredPairs.push({ screen: p.screen, width: p.width });
		}
		diffReportId = diffReportId ?? reportAtt!.id;
	}

	const reqScreens = stepRow.screens ?? [];
	const reqWidths = stepRow.widths ?? [];
	if (reqScreens.length && reqWidths.length) {
		for (const scr of reqScreens) {
			for (const w of reqWidths) {
				if (!coveredPairs.some((p) => p.screen === scr && p.width === w)) {
					refuse(`missing passed compare pair for screen "${scr}" at width ${w}px.`);
				}
			}
		}
	} else if (reqScreens.length) {
		for (const scr of reqScreens) {
			if (!coveredPairs.some((p) => p.screen === scr)) {
				refuse(`missing passed compare pair for declared screen "${scr}".`);
			}
		}
	} else if (reqWidths.length) {
		for (const w of reqWidths) {
			if (!coveredPairs.some((p) => p.width === w)) {
				refuse(`missing passed compare pair for declared width ${w}px.`);
			}
		}
	}

	const allScreens = [...new Set(coveredPairs.map((p) => p.screen))];
	const allWidths = [...new Set(coveredPairs.map((p) => p.width))].sort((a, b) => a - b);
	return {
		mockupId: matchedMockup!.id,
		mockupVersion: matchedMockup!.currentVersion,
		runIds,
		diffReportId: diffReportId!,
		screens: allScreens,
		widths: allWidths
	};
}

/** True when an item's vertical-slice gate (opt-in `item.sliceGate`) currently holds phases after phase 1. */
export async function sliceGateHoldForItem(
	tx: Tx,
	itemId: string
): Promise<{
	firstPhaseId: string;
	firstPhaseKey: string;
	gateStepKey: string;
	gateStepId: string;
} | null> {
	const phases = await tx
		.select({ id: phase.id, key: phase.key, position: phase.position })
		.from(phase)
		.where(eq(phase.itemId, itemId))
		.orderBy(asc(phase.position));
	if (phases.length < 2) return null;
	const firstPhase = phases[0];
	const phaseSteps = await tx
		.select({
			id: step.id,
			key: step.key,
			state: step.state,
			visible: step.visible,
			visibleInferred: step.visibleInferred,
			evidence: step.evidence
		})
		.from(step)
		.where(eq(step.phaseId, firstPhase.id))
		.orderBy(asc(step.position));
	const firstVis = phaseSteps.find((s) => effectiveStepVisible(s));
	if (!firstVis) return null;
	const ev = firstVis.evidence as StepEvidence | null;
	const hasCompare =
		firstVis.state === 'done' && Boolean(ev?.checkRunId || (ev?.runIds && ev.runIds.length > 0));
	const hasWaiver = Boolean(ev?.waived);
	if (hasCompare || hasWaiver) return null;
	return {
		firstPhaseId: firstPhase.id,
		firstPhaseKey: firstPhase.key,
		gateStepKey: firstVis.key,
		gateStepId: firstVis.id
	};
}

/**
 * Checks the opt-in vertical-slice gate when marking any step in a phase after phase 1.
 * Returns null if allowed, or { error, detail } so callers can persist the waiting blocker outside a rolled-back transaction before throwing.
 */
export async function checkSliceGateHold(
	tx: Tx,
	ctx: Ctx,
	it: { id: string; ref: string; sliceGate: boolean },
	targetStepIds: string[]
): Promise<{ error: OpError; waitDetail: string } | null> {
	if (!it.sliceGate || isLivePersonSession(ctx) || !targetStepIds.length) return null;
	const hold = await sliceGateHoldForItem(tx, it.id);
	if (!hold) return null;
	const stepPhases = await tx
		.select({ phaseId: step.phaseId, key: step.key })
		.from(step)
		.where(inArray(step.id, targetStepIds));
	const blocked = stepPhases.find((s) => s.phaseId !== hold.firstPhaseId);
	if (!blocked) return null;
	const waitDetail = `Vertical-slice gate on ${it.ref}: verify ${hold.gateStepKey} with check compare, get an owner waiver (evidence_waive), or have a person remove step ${hold.gateStepKey} before advancing to ${blocked.key}.`;
	return {
		waitDetail,
		error: new OpError('VISUAL_EVIDENCE_REQUIRED', waitDetail, {
			reason: 'slice-gate',
			gateStep: hold.gateStepKey,
			blockedStep: blocked.key,
			exits: ['compare-evidence', 'owner-waiver', 'person-remove']
		})
	};
}

/** Records a waiting-for-a-person blocker outside the rolled-back write transaction when slice-gate holds a session. */
export async function recordSliceGateWaiting(
	ctx: Ctx,
	itemRef: string,
	detail: string
): Promise<void> {
	if (!ctx.actor.sessionId) return;
	try {
		await withTenant(ctx.handle, { orgId: ctx.orgId, userId: ctx.actor.userId }, (tx) =>
			setSessionWaitingTx(tx, ctx, ctx.actor.sessionId!, {
				kind: 'approval',
				detail: detail.slice(0, 240),
				target: itemRef
			})
		);
	} catch {
		// Best-effort blocker status; never mask the slice-gate OpError
	}
}

/**
 * Clears any slice-gate waiting blockers on sessions claimed on `itemId` once `sliceGateHoldForItem` is resolved.
 * Runs inside an open transaction whenever an exit path completes (compare pass, owner waiver, or gate step removal).
 */
export async function clearSliceWaitingForItem(
	tx: Tx,
	ctx: Ctx,
	itemId: string,
	projectId: string
): Promise<void> {
	const hold = await sliceGateHoldForItem(tx, itemId);
	if (hold) return;
	const heldSessions = await tx
		.select({ id: session.id, tool: session.tool })
		.from(session)
		.where(
			and(
				eq(session.orgId, ctx.orgId),
				eq(session.claimedItemId, itemId),
				sql`${session.waiting}->>'kind' = 'approval'`
			)
		);
	if (!heldSessions.length) return;
	await tx
		.update(session)
		.set({ waiting: null, lastSeenAt: sql`now()`, updatedAt: sql`now()` })
		.where(
			inArray(
				session.id,
				heldSessions.map((s) => s.id)
			)
		);
	for (const s of heldSessions) {
		await logSessionEvent(tx, {
			orgId: ctx.orgId,
			sessionId: s.id,
			itemId,
			tool: s.tool,
			kind: 'waiting_clear',
			detail: 'slice-gate released'
		});
	}
	await notifyChange(tx, { o: ctx.orgId, p: projectId, k: 'claim', i: itemId });
}

/** Checks live org/project role to determine whether the caller holds `owner` right now. */
async function hasLiveOwnerRole(tx: Tx, ctx: Ctx, projectId: string): Promise<boolean> {
	const [[orgMem], [projMem]] = await Promise.all([
		tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, ctx.orgId), eq(member.userId, ctx.actor.userId))),
		tx
			.select({ role: projectMember.role })
			.from(projectMember)
			.where(
				and(eq(projectMember.projectId, projectId), eq(projectMember.userId, ctx.actor.userId))
			)
	]);
	if (!orgMem) return false;
	return projMem?.role === 'owner' || (!projMem && orgMem.role === 'owner');
}

/**
 * Owner-only verb waiving visual evidence on one effectively visible step.
 * Requires BOTH a live person web session (never an agent or API/MCP token) AND live `owner` role.
 */
export async function evidenceWaive(ctx: Ctx, raw: z.input<typeof evidenceWaiveInput>) {
	const input = evidenceWaiveInput.parse(raw);
	return run(ctx, (tx) =>
		idempotent(ctx, tx, async () => {
			if (!isLivePersonSession(ctx)) {
				throw new OpError(
					'FORBIDDEN',
					'Only a person signed in to a live web session can waive visual evidence.'
				);
			}
			const it = await findItem(tx, ctx, input.item, { lock: true });
			await requireCap(tx, ctx, 'write', it.projectId);
			await rateLimit(tx, ctx, 'write');
			if (!(await hasLiveOwnerRole(tx, ctx, it.projectId))) {
				throw new OpError(
					'FORBIDDEN',
					'Only a project or organisation owner can waive visual evidence.'
				);
			}
			if (input.expectVersion !== undefined && input.expectVersion !== it.version) {
				throw new OpError(
					'STALE_VERSION',
					'This was changed by someone else since you opened it. Reload to see the newer version.'
				);
			}
			const [st] = await tx
				.select()
				.from(step)
				.where(and(eq(step.itemId, it.id), eq(step.key, input.key)));
			if (!st) throw new OpError('NOT_FOUND', `${it.ref} has no step ${input.key}.`);
			const [u] = await tx
				.select({ name: user.name })
				.from(user)
				.where(eq(user.id, ctx.actor.userId));
			const waiver: StepEvidenceWaiver = {
				by: ctx.actor.userId,
				...(u?.name ? { byName: u.name } : {}),
				reason: input.reason,
				at: new Date().toISOString()
			};
			const nextEvidence: StepEvidence = {
				...(st.evidence ?? {}),
				waived: waiver
			};
			const prevState = st.state;
			await tx
				.update(step)
				.set({
					state: 'waived',
					reason: input.reason,
					evidence: nextEvidence,
					doneAt: null,
					doneBy: null,
					updatedAt: sql`now()`,
					version: sql`${step.version} + 1`
				})
				.where(eq(step.id, st.id));
			if (it.sliceGate) await clearSliceWaitingForItem(tx, ctx, it.id, it.projectId);
			const calc = await recalcItem(tx, it.id);
			await appendEvent(tx, {
				orgId: ctx.orgId,
				projectId: it.projectId,
				itemId: it.id,
				...actorOf(ctx),
				verb: 'step.evidence_waive',
				targetType: 'step',
				targetId: st.id,
				before: { state: prevState, evidence: st.evidence ?? null } as never,
				after: { state: 'waived', key: st.key, waived: waiver } as never,
				undoable: false
			});
			return {
				item: it.ref,
				key: st.key,
				waiver,
				percent: calc.percent,
				version: calc.item.version
			};
		})
	);
}
