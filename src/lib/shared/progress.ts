// HONEST PROGRESS CALCULATION (WRITTEN VS VERIFIED) AND BUILT-CLAIM CROSS-CHECK (D.4, D.8)

// IMPORTED MODULES
import { effectiveStepVisible } from './screenGlobs';

// -- TYPES -- //

export type ProgressStepLike = {
	key?: string;
	state: string;
	visible?: boolean | null;
	visibleInferred?: boolean;
	evidence?: {
		checkRunId?: string;
		runIds?: string[];
		waived?: unknown;
	} | null;
};

export type VisualProgressSummary = {
	writtenPercent: number | null;
	verifiedPercent: number | null;
	visibleTotal: number;
	visibleVerified: number;
	unverifiedVisually: boolean;
};

// -- FUNCTIONS -- //

/** True when a done step carries compare check run evidence. */
export function stepHasVisualEvidence(s: ProgressStepLike): boolean {
	if (s.state !== 'done' || !s.evidence) return false;
	return Boolean(s.evidence.checkRunId || (s.evidence.runIds && s.evidence.runIds.length > 0));
}

/**
 * Computes written vs verified progress (D.4 / D.8):
 * - `verifiedPercent` is `visibleVerified / visibleTotal` rounded down, or `null` ("n/a") when there are no visible steps or item is legacy.
 * - `unverifiedVisually` flags any non-legacy item where a done visible step lacks visual evidence (or status is review/done with unverified visible steps).
 */
export function computeVisualProgress(
	steps: readonly ProgressStepLike[],
	options: { legacyPercent?: number | null; status?: string } = {}
): VisualProgressSummary {
	const legacy = options.legacyPercent !== null && options.legacyPercent !== undefined;
	const counted = steps.filter((s) => s.state === 'open' || s.state === 'done');
	const doneCount = counted.filter((s) => s.state === 'done').length;
	const writtenPercent = legacy
		? (options.legacyPercent as number)
		: counted.length === 0
			? null
			: Math.floor((doneCount / counted.length) * 100);

	if (legacy) {
		return {
			writtenPercent,
			verifiedPercent: null,
			visibleTotal: 0,
			visibleVerified: 0,
			unverifiedVisually: false
		};
	}

	const visibleSteps = counted.filter((s) => effectiveStepVisible(s));
	const visibleTotal = visibleSteps.length;
	const visibleVerified = visibleSteps.filter((s) => stepHasVisualEvidence(s)).length;
	const verifiedPercent =
		visibleTotal === 0 ? null : Math.floor((visibleVerified / visibleTotal) * 100);

	const doneVisibleWithoutEvidence = visibleSteps.some(
		(s) => s.state === 'done' && !stepHasVisualEvidence(s)
	);
	const reviewOrClosedWithGap =
		visibleTotal > 0 &&
		visibleVerified < visibleTotal &&
		(options.status === 'IN REVIEW' || options.status === 'COMPLETED');

	return {
		writtenPercent,
		verifiedPercent,
		visibleTotal,
		visibleVerified,
		unverifiedVisually: doneVisibleWithoutEvidence || reviewOrClosedWithGap
	};
}

/**
 * Cross-checks `BUILT` lines in `as-built` text against known changed files and verified evidence runs (D.4).
 * Returns flagged `BUILT` lines that cite neither a matching file/diff nor any attached evidence run id.
 */
export function findUnverifiedBuiltClaims(
	asBuiltBody: string,
	evidence: { files?: readonly string[]; runIds?: readonly string[]; hasDiff?: boolean }
): string[] {
	if (!asBuiltBody.trim()) return [];
	const knownFiles = (evidence.files ?? []).map((f) => f.toLowerCase());
	const knownRuns = (evidence.runIds ?? []).map((r) => r.toLowerCase());
	const hasAnyGlobalEvidence = Boolean(evidence.hasDiff) || knownRuns.length > 0;
	const flagged: string[] = [];

	for (const raw of asBuiltBody.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (!/^(?:[-*]\s+)?(?:\[\s*built\s*\]|built\s*:)/i.test(line)) continue;
		const lower = line.toLowerCase();
		const citesKnownRun = knownRuns.some(
			(id) => lower.includes(id) || (id.length >= 8 && lower.includes(id.slice(0, 8)))
		);
		const citesKnownFile = knownFiles.some((f) => f.length >= 3 && lower.includes(f));
		const hasInlineCommitOrDiff =
			/\b[0-9a-f]{7,40}\b/.test(lower) ||
			/\bdiff\b|\bcompare-diff\b|\bcompare-summary\b|\brun\s+[0-9a-f-]{8,}/i.test(lower);
		if (citesKnownRun || citesKnownFile || (hasAnyGlobalEvidence && hasInlineCommitOrDiff)) {
			continue;
		}
		flagged.push(line.slice(0, 140));
	}
	return flagged;
}
