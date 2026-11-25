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

// -- AREA TREE (AFB-20261125-1421) -- //

/** The deepest group level; a longer path keeps its first four parts. */
export const QA_AREA_DEPTH = 4;
/** The group of a feature whose area is empty. */
export const QA_AREA_OTHER = 'Other';

/** One feature as the Testing page lists it, the same shape the page server sends. */
export type QaMapFeature = {
	id: string;
	key: string;
	area: string;
	name: string;
	sizes: number[];
	status: string;
	flaky: boolean;
	openBugs: number;
	lastTestedAt: Date | string | null;
	lastCommit: string | null;
	journeys: number;
	cases: number;
	works: number;
};

export type QaTreeNode<T> = {
	/** The whole path, such as `apps/centers/queue`. */
	path: string;
	/** The last part, such as `queue`. */
	label: string;
	/** The parts before the label, such as `apps / centers`, or empty for a top group. */
	trail: string;
	/** 0 for a top group. */
	depth: number;
	/** The features that sit right in this group. */
	own: T[];
	children: QaTreeNode<T>[];
	/** Every feature in this group and under it, for the counts and the health bar. */
	all: T[];
};

/** An area is a path of up to four parts split on `/`: "apps/admin" is the group apps and its sub-group admin. Blank is Other. */
export function qaAreaPath(area: string | null | undefined): string {
	const parts = (area ?? '')
		.split('/')
		.map((p) => p.trim())
		.filter(Boolean)
		.slice(0, QA_AREA_DEPTH);
	return parts.length ? parts.join('/') : QA_AREA_OTHER;
}

/** True when the feature sits in the group `area` or in a group under it. An empty `area` means no group filter and matches everything, so a group that is really called "all" stays a group. */
export const qaInArea = (featureArea: string | null | undefined, area: string): boolean => {
	if (area === '') return true;
	const p = qaAreaPath(featureArea);
	return p === area || p.startsWith(`${area}/`);
};

/**
 * Builds the group tree from the features, keeping their order inside each group. A group that only has sub-groups still
 * gets its own node, and Other always comes last.
 */
export function qaBuildTree<T extends { area: string | null | undefined }>(
	features: T[]
): QaTreeNode<T>[] {
	const nodes = new Map<string, QaTreeNode<T>>();
	const roots: QaTreeNode<T>[] = [];
	const nodeOf = (path: string): QaTreeNode<T> => {
		const found = nodes.get(path);
		if (found) return found;
		const parts = path.split('/');
		const label = parts[parts.length - 1];
		const node: QaTreeNode<T> = {
			path,
			label,
			trail: parts.slice(0, -1).join(' / '),
			depth: parts.length - 1,
			own: [],
			children: [],
			all: []
		};
		nodes.set(path, node);
		if (parts.length === 1) roots.push(node);
		else nodeOf(parts.slice(0, -1).join('/')).children.push(node);
		return node;
	};
	for (const f of features) {
		const path = qaAreaPath(f.area);
		nodeOf(path).own.push(f);
		const parts = path.split('/');
		for (let i = 1; i <= parts.length; i++) nodeOf(parts.slice(0, i).join('/')).all.push(f);
	}
	const byLabel = (a: QaTreeNode<T>, b: QaTreeNode<T>) =>
		Number(a.path === QA_AREA_OTHER) - Number(b.path === QA_AREA_OTHER) ||
		a.label.localeCompare(b.label);
	const order = (list: QaTreeNode<T>[]) => {
		list.sort(byLabel);
		for (const n of list) order(n.children);
	};
	order(roots);
	return roots;
}

/** Every group path in tree order, with its depth, for the Group select. Parents come before their children. */
export function qaGroupPaths<T>(
	tree: QaTreeNode<T>[]
): { path: string; label: string; depth: number }[] {
	const out: { path: string; label: string; depth: number }[] = [];
	const walk = (list: QaTreeNode<T>[]) => {
		for (const n of list) {
			out.push({ path: n.path, label: n.label, depth: n.depth });
			walk(n.children);
		}
	};
	walk(tree);
	return out;
}
