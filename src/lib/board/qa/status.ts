// THE WORDS AND TONES OF THE TESTING PAGE (AFB-20261125-0442). PURE, SO THE PAGE, THE FEATURE PAGE AND THE PLAN TAB SAY THE SAME THING.
// A status always uses a fixed status tone, never the accent (CLAUDE.md, Colour and theme).

// -- TYPES -- //

export type QaStatus = 'works' | 'broken' | 'could_not_test' | 'not_tested' | 'needs_retest';
export type QaTone = 'success' | 'danger' | 'warning' | 'neutral' | 'info';
export type QaTab = 'map' | 'runs' | 'bugs';

// -- CONSTANTS -- //

export const QA_STATUSES: readonly QaStatus[] = [
	'broken',
	'needs_retest',
	'could_not_test',
	'not_tested',
	'works'
];
export const QA_STATUS_LABEL: Record<QaStatus, string> = {
	works: 'Works',
	broken: 'Broken',
	could_not_test: "Couldn't test",
	not_tested: 'Not tested yet',
	needs_retest: 'Needs retest'
};
export const QA_STATUS_TONE: Record<QaStatus, QaTone> = {
	works: 'success',
	broken: 'danger',
	could_not_test: 'warning',
	not_tested: 'neutral',
	needs_retest: 'info'
};
/** A baseline of a plan link reads like a status; unknown means the feature was not tested before the plan. */
export const QA_BASELINE_LABEL: Record<string, string> = {
	works: 'Works',
	broken: 'Broken',
	could_not_test: "Couldn't test",
	unknown: 'Not tested yet'
};
export const QA_BASELINE_TONE: Record<string, QaTone> = {
	works: 'success',
	broken: 'danger',
	could_not_test: 'warning',
	unknown: 'neutral'
};
export const QA_SEVERITY_LABEL: Record<string, string> = {
	blocker: 'Blocker',
	major: 'Major',
	minor: 'Minor',
	cosmetic: 'Cosmetic'
};
export const QA_TABS: readonly QaTab[] = ['map', 'runs', 'bugs'];
export const QA_TAB_LABEL: Record<QaTab, string> = { map: 'Map', runs: 'Runs', bugs: 'Bugs' };

// -- FUNCTIONS -- //

export const qaStatusOf = (v: string): QaStatus =>
	(QA_STATUSES as readonly string[]).includes(v) ? (v as QaStatus) : 'not_tested';

export const qaTabOf = (v: string | null): QaTab =>
	v && (QA_TABS as readonly string[]).includes(v) ? (v as QaTab) : 'map';

/** The command a person pastes into their coding tool to map or test the app, in the repo of this project. */
export const qaCommand = (scope?: string) =>
	scope?.trim() ? `/flow-qa ${scope.trim()}` : '/flow-qa';

/** One line that sums up the map: how many features, and how many of each status that has any. */
export function qaSummary(statuses: QaStatus[]): string {
	const n = statuses.length;
	if (n === 0) return 'No features on the map yet';
	const count = (s: QaStatus) => statuses.filter((x) => x === s).length;
	const parts = [`${n} ${n === 1 ? 'feature' : 'features'}`];
	const words: [QaStatus, string][] = [
		['works', 'work'],
		['broken', 'broken'],
		['needs_retest', 'need a retest'],
		['could_not_test', "couldn't be tested"],
		['not_tested', 'not tested yet']
	];
	for (const [s, w] of words) if (count(s) > 0) parts.push(`${count(s)} ${w}`);
	return parts.join(' · ');
}
