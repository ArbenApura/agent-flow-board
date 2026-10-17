// SEARCH, FILTER AND SORT FOR THE PROJECTS ON THE ORG HOME (AFB-20261017-0537)
// Pure functions over the overview the server already sent. Pinned projects always stay in their own group, and the sort applies
// inside each group.

// -- TYPES -- //

export type ProjectSort = 'name' | 'key' | 'active' | 'newest' | 'items';
export type ProjectChip = 'all' | 'running' | 'open' | 'empty';
export type ProjectView = 'cards' | 'list';
export type ProjectRow = {
	project: { id: string; key: string; name: string };
	total: number;
	byStatus: Record<string, number>;
	running: number;
	pinned: boolean;
	createdAt: Date | string;
	lastActivityAt: Date | string | null;
};
export type ProjectQuery = { q: string; chip: ProjectChip; sort: ProjectSort };
export type ProjectGroups<T extends ProjectRow> = {
	pinned: T[];
	rest: T[];
	/** How many projects each chip would show for the current search, for the counts on the chips. */
	counts: Record<ProjectChip, number>;
};

// -- CONSTANTS -- //

export const PROJECT_SORTS: { value: ProjectSort; label: string; hint: string }[] = [
	{ value: 'name', label: 'Name', hint: 'A to Z' },
	{ value: 'key', label: 'Key', hint: 'A to Z, like AFB before POR' },
	{ value: 'active', label: 'Most active', hint: 'Running now first, then in progress' },
	{ value: 'newest', label: 'Newest', hint: 'The project made last comes first' },
	{ value: 'items', label: 'Most items', hint: 'The biggest plan first' }
];
export const PROJECT_CHIPS: { value: ProjectChip; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'running', label: 'Running now' },
	{ value: 'open', label: 'Open work' },
	{ value: 'empty', label: 'Empty' }
];
export const PROJECT_VIEWS: { value: ProjectView; label: string }[] = [
	{ value: 'cards', label: 'Cards' },
	{ value: 'list', label: 'List' }
];
/** The toolbar (search, sort, view) shows from this many projects up. Always shown once there is a project. */
export const TOOLBAR_FROM = 1;
/** More members than this and the Members card shows the first few behind a Show all button. */
/** The quick filter chips show from this many projects up. Always shown once there is a project. */
export const CHIPS_FROM = 1;
export const MEMBERS_COLLAPSE_OVER = 6;
export const MEMBERS_SHOWN = 5;

// -- FUNCTIONS -- //

export const parseSort = (v: unknown): ProjectSort =>
	PROJECT_SORTS.some((s) => s.value === v) ? (v as ProjectSort) : 'name';
export const parseView = (v: unknown): ProjectView => (v === 'list' ? 'list' : 'cards');

const ms = (d: Date | string | null) => (d ? new Date(d).getTime() : 0);
const byName = (a: ProjectRow, b: ProjectRow) =>
	a.project.name.localeCompare(b.project.name, undefined, { sensitivity: 'base' });

/** Items that are neither completed nor removed. */
export const openItems = (o: ProjectRow) =>
	Object.entries(o.byStatus).reduce(
		(n, [status, count]) => (status === 'COMPLETED' || status === 'REMOVED' ? n : n + count),
		0
	);

const matches = (o: ProjectRow, chip: ProjectChip) =>
	chip === 'all' ||
	(chip === 'running' && o.running > 0) ||
	(chip === 'open' && openItems(o) > 0) ||
	(chip === 'empty' && o.total === 0);

const COMPARE: Record<ProjectSort, (a: ProjectRow, b: ProjectRow) => number> = {
	name: byName,
	key: (a, b) => a.project.key.localeCompare(b.project.key),
	active: (a, b) =>
		b.running - a.running ||
		(b.byStatus['IN PROGRESS'] ?? 0) - (a.byStatus['IN PROGRESS'] ?? 0) ||
		ms(b.lastActivityAt) - ms(a.lastActivityAt) ||
		byName(a, b),
	newest: (a, b) => ms(b.createdAt) - ms(a.createdAt) || byName(a, b),
	items: (a, b) => b.total - a.total || byName(a, b)
};

/** Searches name and key, keeps the chip's projects, sorts, and splits pinned from the rest. */
export function arrangeProjects<T extends ProjectRow>(
	rows: T[],
	query: ProjectQuery
): ProjectGroups<T> {
	const needle = query.q.trim().toLowerCase();
	const found = needle
		? rows.filter(
				(o) =>
					o.project.name.toLowerCase().includes(needle) ||
					o.project.key.toLowerCase().includes(needle)
			)
		: rows;
	const counts: Record<ProjectChip, number> = { all: 0, running: 0, open: 0, empty: 0 };
	for (const chip of PROJECT_CHIPS)
		counts[chip.value] = found.filter((o) => matches(o, chip.value)).length;
	const shown = found.filter((o) => matches(o, query.chip)).sort(COMPARE[query.sort]);
	return { pinned: shown.filter((o) => o.pinned), rest: shown.filter((o) => !o.pinned), counts };
}

/** "3 minutes ago" style text for the last change, or a plain note when nothing was ever recorded. */
export function activityText(at: Date | string | null, now = Date.now()): string {
	if (!at) return 'No activity yet';
	const minutes = Math.max(0, Math.round((now - ms(at)) / 60_000));
	if (minutes < 1) return 'Active just now';
	if (minutes < 60) return `Active ${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `Active ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `Active ${days} ${days === 1 ? 'day' : 'days'} ago`;
	return `Active ${new Date(ms(at)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
