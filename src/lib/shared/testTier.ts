// HOW MUCH TESTING A PLAN GETS (AFB-20261127-0438): THE TIER FROM WHAT THE PLAN TOUCHES, AND WHICH EARLIER CASES IT RE-RUNS
// The owner's rule: testing is sized to the plan and never takes most of a small plan's time. A plan of docs or skill text gets
// no run, a tweak to an approved screen is covered by its Screens capture, a small fix runs its own cases, a normal plan adds the
// High priority cases of the areas it touched (least recently run first, at most 8), and a plan that touches server, auth or
// migration code re-runs every case of those areas. What does not fit the cap is owed to the next deploy.

// -- TYPES -- //

export type TestTier = 'none' | 'screens-only' | 'lite' | 'normal' | 'deep';
export type TierInput = {
	/** Counted steps of the plan. */
	steps: number;
	/** Files the plan changed. */
	files: string[];
	/** True when the plan changes something a person sees (it has a design brief). */
	visible: boolean;
	/** True when the visible change is only a tweak to an approved screen (no new layout or behaviour). */
	tweak?: boolean;
};
export type RerunCandidate = {
	key: string;
	area: string;
	priority: 'high' | 'normal' | 'low';
	/** The last time the case ran, or null when it never did. */
	lastRunAt: string | null;
};

// -- CONSTANTS -- //

/** The most earlier cases a normal plan re-runs. */
export const RERUN_CAP = 8;
const DOC_FILE = /(^|\/)(docs?\/|README|CHANGELOG|LICENSE)|\.(md|mdx|txt)$/i;
const CONFIG_FILE =
	/(^|\/)(\.github\/|deploy\/|\.yarnrc|\.gitignore|\.editorconfig|Dockerfile|compose\.ya?ml)|\.(ya?ml|toml|ini)$/i;
const SENSITIVE_FILE =
	/(^|\/)(migrations?\/|auth\/|security|db\/schema\/|orgs\/|hooks\.server\.|server\/api\/|server\/mcp\/)|\.sql$/i;

// -- FUNCTIONS -- //

/** The tier of a plan from its files, its size and whether it changes a screen. */
export function planTier(input: TierInput): TestTier {
	// A Windows path reads the same as its git form
	const files = input.files.filter(Boolean).map((f) => f.replace(/\\/g, '/'));
	if (files.length > 0 && files.every((f) => DOC_FILE.test(f) || CONFIG_FILE.test(f)))
		return 'none';
	if (files.some((f) => SENSITIVE_FILE.test(f)) || files.length > 15) return 'deep';
	if (input.visible && input.tweak && input.steps <= 3) return 'screens-only';
	if (input.steps <= 3 && files.length <= 5) return 'lite';
	return 'normal';
}

/** True when a case's area is one the plan touched, or inside one (apps/centers covers apps/centers/queue). */
export function inAreas(area: string, touched: string[]): boolean {
	const a = area.toLowerCase().replace(/\\/g, '/');
	return touched.some((t) => {
		const x = t.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
		return a === x || a.startsWith(`${x}/`);
	});
}

/**
 * The earlier cases a plan re-runs and the ones it owes to the next deploy. Lite and lower re-run none; normal re-runs the
 * High priority cases of the touched areas, least recently run first, up to the cap; deep re-runs every case of those areas.
 */
export function pickRerun(
	candidates: RerunCandidate[],
	touched: string[],
	tier: TestTier,
	cap = RERUN_CAP
): { run: string[]; owed: string[] } {
	if (tier === 'none' || tier === 'screens-only' || tier === 'lite') return { run: [], owed: [] };
	const inScope = candidates.filter((c) => inAreas(c.area, touched));
	// Never run first, then the oldest run; the key breaks ties so the pick is the same every time
	const order = (a: RerunCandidate, b: RerunCandidate) => {
		if (a.lastRunAt === b.lastRunAt) return a.key.localeCompare(b.key);
		if (a.lastRunAt === null) return -1;
		if (b.lastRunAt === null) return 1;
		return a.lastRunAt < b.lastRunAt ? -1 : 1;
	};
	if (tier === 'deep') return { run: [...inScope].sort(order).map((c) => c.key), owed: [] };
	const high = inScope.filter((c) => c.priority === 'high').sort(order);
	const run = high.slice(0, cap).map((c) => c.key);
	const owed = high.slice(cap).map((c) => c.key);
	return { run, owed };
}
