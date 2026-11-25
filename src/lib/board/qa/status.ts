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
/** The order a person should look at features in: what is broken first, what works last. */
export const QA_STATUS_RANK: Record<QaStatus, number> = {
	broken: 0,
	needs_retest: 1,
	could_not_test: 2,
	not_tested: 3,
	works: 4
};
/** A status dot and a row rail, always a fixed status token, never the accent. */
export const QA_STATUS_DOT: Record<QaStatus, string> = {
	works: 'bg-success',
	broken: 'bg-danger',
	needs_retest: 'bg-info',
	could_not_test: 'bg-warning',
	not_tested: 'bg-muted'
};
export const QA_STATUS_RAIL: Record<QaStatus, string> = {
	works: 'bg-success',
	broken: 'bg-danger',
	needs_retest: 'bg-info',
	could_not_test: 'bg-warning',
	not_tested: 'bg-line'
};
/** The worst first, so a group of bugs reads from the one that blocks the most. */
export const QA_SEVERITIES = ['blocker', 'major', 'minor', 'cosmetic'] as const;
export type QaSort = 'attention' | 'name' | 'recent';
export const QA_SORTS: readonly QaSort[] = ['attention', 'name', 'recent'];
export const QA_SORT_LABEL: Record<QaSort, string> = {
	attention: 'Needs attention',
	name: 'Name',
	recent: 'Recently tested'
};
export type QaBugState = 'open' | 'fixed' | 'all';
export const QA_BUG_STATES: readonly QaBugState[] = ['open', 'fixed', 'all'];

// -- FUNCTIONS -- //

export const qaStatusOf = (v: string): QaStatus =>
	(QA_STATUSES as readonly string[]).includes(v) ? (v as QaStatus) : 'not_tested';

export const qaTabOf = (v: string | null): QaTab =>
	v && (QA_TABS as readonly string[]).includes(v) ? (v as QaTab) : 'map';

/** The command a person pastes into their coding tool to map or test the app, in the repo of this project. */
export const qaCommand = (scope?: string) =>
	scope?.trim() ? `/flow-qa ${scope.trim()}` : '/flow-qa';

export const qaSortOf = (v: string | null): QaSort =>
	v && (QA_SORTS as readonly string[]).includes(v) ? (v as QaSort) : 'attention';

export const qaBugStateOf = (v: string | null): QaBugState =>
	v && (QA_BUG_STATES as readonly string[]).includes(v) ? (v as QaBugState) : 'open';

/** "1 journey", "2 journeys". */
export const qaPlural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** How many features have each status, every status present (a zero stays a zero). */
export function qaCounts(statuses: QaStatus[]): Record<QaStatus, number> {
	const out = { works: 0, broken: 0, could_not_test: 0, not_tested: 0, needs_retest: 0 };
	for (const s of statuses) out[s] += 1;
	return out;
}

/** The share of cases that pass, a whole number from 0 to 100. Nothing tested yet is 0. */
export const qaPercent = (pass: number, total: number) =>
	total > 0 ? Math.min(100, Math.round((pass / total) * 100)) : 0;

/** Sorts a copy of the features: broken first by default, then by name, or the most recently tested first. */
export function qaSortFeatures<
	T extends { name: string; status: string; lastTestedAt: Date | string | null }
>(list: T[], sort: QaSort): T[] {
	const time = (f: T) => (f.lastTestedAt ? new Date(f.lastTestedAt).getTime() : 0);
	const byName = (a: T, b: T) => a.name.localeCompare(b.name);
	return [...list].sort((a, b) => {
		if (sort === 'name') return byName(a, b);
		if (sort === 'recent') return time(b) - time(a) || byName(a, b);
		return (
			QA_STATUS_RANK[qaStatusOf(a.status)] - QA_STATUS_RANK[qaStatusOf(b.status)] || byName(a, b)
		);
	});
}

/** The bugs that are still open count as open; a done or dropped one is fixed. */
export const qaBugIsOpen = (status: string) => status !== 'DONE' && status !== 'DROPPED';

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
