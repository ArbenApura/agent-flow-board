// THE TESTING SCREENS' WORDS, TONES AND GROUPING (AFB-20261127-0438)
// One place for the status words and their classes, the device names and sizes, and the grouping of cases into apps and areas,
// so the page, the drawer and the plan tab never drift apart. A status uses the fixed status tokens and never the accent.

// -- TYPES -- //

export type Status = 'pass' | 'fail' | 'blocked' | 'not_run' | 'running';
export type Device = 'wide' | 'laptop' | 'tablet' | 'phone' | 'custom';
/** The fields of a case the grouping needs. */
export type Groupable = { key: string; area: string; status: Status };
export type AreaGroup<T> = { path: string; name: string; cases: T[]; worst: number };
export type AppGroup<T> = {
	path: string;
	name: string;
	areas: AreaGroup<T>[];
	cases: T[];
	worst: number;
};

// -- CONSTANTS -- //

export const STATUS_LABEL: Record<Status, string> = {
	pass: 'Pass',
	fail: 'Fail',
	blocked: 'Blocked',
	not_run: 'Not run',
	running: 'Running'
};
/** The dot of a status. A pass is a quiet green, the rest carry their tone. */
export const STATUS_DOT: Record<Status, string> = {
	pass: 'bg-success',
	fail: 'bg-danger',
	blocked: 'bg-warning',
	not_run: 'border border-muted',
	running: 'bg-info motion-safe:animate-pulse'
};
/** The word of a status: muted when nothing needs a person, the status colour and weight when something does. */
export const STATUS_TEXT: Record<Status, string> = {
	pass: 'text-muted',
	not_run: 'text-muted',
	fail: 'font-medium text-danger',
	blocked: 'font-medium text-warning',
	running: 'font-medium text-info'
};
/** The 3 px rail on the left of a row: only where something needs a person. */
export const STATUS_RAIL: Partial<Record<Status, string>> = {
	fail: 'bg-danger',
	blocked: 'bg-warning',
	running: 'bg-info'
};
/** A segment of the device bar or a square of the history strip. */
export const STATUS_FILL: Record<Status, string> = {
	pass: 'bg-success',
	fail: 'bg-danger',
	blocked: 'bg-warning',
	not_run: 'bg-muted/40',
	running: 'bg-info motion-safe:animate-pulse'
};
/** The order a status rises in: a failing case comes first. */
export const STATUS_RANK: Record<Status, number> = {
	fail: 0,
	blocked: 1,
	running: 2,
	not_run: 3,
	pass: 4
};
export const DEVICE_ORDER: Device[] = ['wide', 'laptop', 'tablet', 'phone'];
export const DEVICE_LABEL: Record<Device, string> = {
	wide: 'Wide',
	laptop: 'Laptop',
	tablet: 'Tablet',
	phone: 'Phone',
	custom: 'Custom'
};
export const KIND_LABEL: Record<string, string> = {
	ui: 'UI',
	mcp: 'MCP',
	api: 'API',
	unit: 'Unit',
	skill: 'Skill'
};
/** What a non-UI case shows in the Devices column. */
export const KIND_RUNS: Record<string, string> = {
	mcp: 'MCP call',
	api: 'API call',
	unit: 'Unit test',
	skill: 'Skill check'
};
export const SEVERITY_LABEL: Record<string, string> = {
	blocker: 'Blocker',
	major: 'Major',
	minor: 'Minor',
	cosmetic: 'Cosmetic'
};
export const SEVERITY_DOT: Record<string, string> = {
	blocker: 'bg-danger',
	major: 'bg-danger',
	minor: 'bg-warning',
	cosmetic: 'bg-muted'
};
/** A filter sentinel no real area can be (an area never starts with a colon). */
export const ALL_APPS = ':all';

// -- FUNCTIONS -- //

/** The worst status of a set (none reads as not run). */
export function worst(statuses: Status[]): Status {
	let best: Status = 'not_run';
	let rank = 99;
	for (const s of statuses)
		if (STATUS_RANK[s] < rank) {
			rank = STATUS_RANK[s];
			best = s;
		}
	return statuses.length ? best : 'not_run';
}

/** Counts of each status. */
export function countStatuses<T extends { status: Status }>(list: T[]): Record<Status, number> {
	const n: Record<Status, number> = { pass: 0, fail: 0, blocked: 0, not_run: 0, running: 0 };
	for (const c of list) n[c.status]++;
	return n;
}

/**
 * The app of an area: the first two levels of a path under apps/ (apps/centers), else the first level (AUTH). A single-app
 * project has one app per top area, which reads as plain groups.
 */
export function appOf(area: string): string {
	const parts = area.split('/');
	return parts[0] === 'apps' && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** True when an area is the scope or inside it. */
export function inScope(area: string, scope: string): boolean {
	return scope === ALL_APPS || area === scope || area.startsWith(`${scope}/`);
}

/** The cases grouped into apps and areas, the worst group first and the worst case first inside each. */
export function groupCases<T extends Groupable>(cases: T[]): AppGroup<T>[] {
	const apps = new Map<string, Map<string, T[]>>();
	for (const c of cases) {
		const app = appOf(c.area);
		if (!apps.has(app)) apps.set(app, new Map());
		const areas = apps.get(app)!;
		if (!areas.has(c.area)) areas.set(c.area, []);
		areas.get(c.area)!.push(c);
	}
	const byRank = (a: T, b: T) =>
		STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.key.localeCompare(b.key);
	const out: AppGroup<T>[] = [];
	for (const [path, areas] of apps) {
		const groups: AreaGroup<T>[] = [...areas].map(([p, list]) => {
			const sorted = [...list].sort(byRank);
			return {
				path: p,
				name: p === path ? p.split('/').pop()! : p.slice(path.length + 1),
				cases: sorted,
				worst: STATUS_RANK[sorted[0].status]
			};
		});
		groups.sort((a, b) => a.worst - b.worst || a.path.localeCompare(b.path));
		const all = groups.flatMap((g) => g.cases);
		out.push({
			path,
			name: path.split('/').pop()!,
			areas: groups,
			cases: all,
			worst: Math.min(...groups.map((g) => g.worst))
		});
	}
	return out.sort((a, b) => a.worst - b.worst || a.path.localeCompare(b.path));
}

/** A short age: now, 5 min ago, 2 h ago, 3 d ago. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return 'Never';
	const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
	if (s < 60) return 'now';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}

/** The copy-ready prompt that asks a coding tool to retest. */
export const retestPrompt = (what: string) => `/flow-qa retest ${what}`;
