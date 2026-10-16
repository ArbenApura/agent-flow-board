// THE UI SHOTS RULES SHARED BY THE SERVER, THE RUNNER AND THE PAGES: THE "UI CHANGES" TABLE, THE MEASURED SCALE AND THE FLAGS (SPEC 10.1)
// Nothing here opens a browser or touches a database, so the same code runs in the operations layer, in the runner program
// and in unit tests.

// -- DEP-MODULES -- //
import { STATE_STEP, UI_LEVELS, UI_THEMES, UI_VIEWPORTS, levelName } from './uiChange';

// -- TYPES -- //

export type UiChangeRow = {
	page: string;
	/** click:, wait: or scroll: steps joined by " > ". Empty for the page as it opens. */
	stateRecipe: string;
	themes: string[];
	accounts: string;
	siblings: string[];
	levels: string[];
	viewports: number[];
};
/** What one element measured in the page's own computed style. */
export type Measured = {
	fontSize: number;
	fontWeight: number;
	height: number;
	width: number;
	radius: number;
};
export type MeasuredLevels = Record<string, Measured | null>;
/** The project's scale for one theme and width: for each level, the values it may take. */
export type ScaleLevels = Record<string, Record<string, number | number[]>>;
export type Flag = { level: string; kind: string; text: string };
export type ScaleSample = { page: string; measured: MeasuredLevels };

// -- CONSTANTS -- //

const COLUMNS = ['Page', 'State', 'Themes', 'Accounts', 'Siblings', 'Levels', 'Viewports'] as const;
/** The default locator of each level. A row may replace one with level=css:<selector>. */
export const DEFAULT_LOCATORS: Record<string, string> = {
	title: 'h1',
	section: 'h2, h3',
	body: "p:not([id$='-hint']):not([id$='-error']):not([role=alert]):not([role=status])",
	label: 'label, th',
	'button-primary': "button.primary, [data-variant='primary']",
	button: "button:not(.primary):not([data-variant='primary']):not([data-icon-only]):not([role])",
	'button-icon': 'button[data-icon-only], button[aria-label]:not(:has(span))',
	input: 'input:not([type=hidden]), select, textarea',
	card: '[data-card], .screen',
	row: 'tbody tr, [data-row]',
	icon: 'svg',
	image: 'img, .shot'
};
/** Which measured properties a level is compared on. */
export const LEVEL_PROPS: Record<string, (keyof Measured)[]> = {
	title: ['fontSize'],
	section: ['fontSize'],
	body: ['fontSize'],
	label: ['fontSize'],
	'button-primary': ['height', 'fontSize', 'radius'],
	button: ['height', 'fontSize', 'radius'],
	'button-icon': ['height'],
	input: ['height', 'fontSize', 'radius'],
	card: ['radius'],
	row: ['height'],
	icon: ['width'],
	image: ['width']
};
/** A level must be seen on this many pages before the scale uses it. */
export const MIN_PAGES_FOR_SCALE = 3;
export const TOLERANCE_PX = 0.5;

export class UiChangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UiChangeError';
	}
}

// -- FUNCTIONS: THE TABLE -- //

const cells = (line: string) =>
	line
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((c) => c.trim());
const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** A mockup page kept in the repo, which a local run may use beside the app's own pages. */
export const isMockup = (p: string) => /^[\w./-]+\.html$/.test(p) && !p.includes('..');

/** An address inside the web app: starts with one slash, no host, no scheme. */
export const isAppRoute = (p: string) => /^\/(?!\/)[^\s]*$/.test(p) && !/^\/\\/.test(p);

/**
 * Reads the "UI changes" table from Markdown into rows. A row that names several pages or several states becomes one row
 * for each. `lenient` drops sibling entries that are not app routes (a mockup file named for the human reader).
 */
export function parseUiChangesTable(
	markdown: string,
	opts: { lenient?: boolean } = {}
): UiChangeRow[] {
	const lines = markdown.split('\n');
	const head = lines.findIndex((l) => l.startsWith('|') && COLUMNS.every((c) => l.includes(c)));
	if (head < 0)
		throw new UiChangeError(`No "UI changes" table found (columns ${COLUMNS.join(', ')}).`);
	const names = cells(lines[head]);
	const rows: UiChangeRow[] = [];
	for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
		const c = cells(lines[i]);
		if (c.length !== names.length)
			throw new UiChangeError(`Row ${i + 1} has ${c.length} columns, expected ${names.length}.`);
		const r = Object.fromEntries(names.map((n, k) => [n, c[k]])) as Record<string, string>;
		const pages = ticks(r.Page);
		if (!pages.length)
			throw new UiChangeError(`Row ${i + 1} names no page. Put each page in backticks.`);
		const states = r.State.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => (s === 'none' ? '' : s.replace(/`/g, '').trim()));
		const siblingsAll = ticks(r.Siblings);
		// A lenient read keeps app routes and the mockup files this repo's own table names beside them
		const siblings = opts.lenient
			? siblingsAll.filter((x) => isAppRoute(x) || isMockup(x))
			: siblingsAll;
		for (const page of pages)
			for (const stateRecipe of states.length ? states : [''])
				rows.push({
					page,
					stateRecipe,
					themes: r.Themes.trim() === 'both' ? [...UI_THEMES] : [r.Themes.trim()],
					accounts: r.Accounts.trim() || 'default',
					siblings,
					levels: r.Levels.split(',')
						.map((l) => l.trim())
						.filter(Boolean),
					viewports: r.Viewports.split(',').map((v) => Number(v.trim()))
				});
	}
	return rows;
}

/**
 * Refuses an unknown level, a bad state step, a viewport other than 1440 or 390, a theme the project does not have, a page
 * or sibling outside the web app, or no sibling at all (a screen is judged against the pages around it).
 */
export function validateUiChange(
	row: UiChangeRow,
	opts: { themes?: string[]; allowNoSiblings?: boolean; allowMockups?: boolean } = {}
): void {
	if (!isAppRoute(row.page))
		throw new UiChangeError(
			`The page "${row.page}" must be an address inside the app that starts with /.`
		);
	for (const s of row.siblings)
		if (!isAppRoute(s) && !(opts.allowMockups && isMockup(s)))
			throw new UiChangeError(
				`The sibling "${s}" must be an address inside the app that starts with /.`
			);
	if ((row.siblings.length < 1 && !opts.allowNoSiblings) || row.siblings.length > 3)
		throw new UiChangeError('Name 1 to 3 sibling pages.');
	if (!row.levels.length) throw new UiChangeError('Name at least one level to measure.');
	for (const l of row.levels) {
		if (!(UI_LEVELS as readonly string[]).includes(levelName(l)))
			throw new UiChangeError(`Unknown level "${l}". Levels: ${UI_LEVELS.join(', ')}.`);
		const override = l.split('=')[1];
		if (override !== undefined && !/^css:\S.*$/.test(override))
			throw new UiChangeError(`The selector of "${l}" must be written level=css:<selector>.`);
	}
	if (row.stateRecipe)
		for (const step of row.stateRecipe.split(' > '))
			if (!STATE_STEP.test(step.trim()))
				throw new UiChangeError(
					`State step "${step}" must be click:, wait: or scroll: with a target.`
				);
	if (!row.viewports.length) throw new UiChangeError('Name at least one viewport.');
	for (const v of row.viewports)
		if (!(UI_VIEWPORTS as readonly number[]).includes(v))
			throw new UiChangeError(`Viewport ${v} must be ${UI_VIEWPORTS.join(' or ')}.`);
	if (!row.themes.length) throw new UiChangeError('Name at least one theme.');
	const allowed = opts.themes?.length ? opts.themes : [...UI_THEMES];
	for (const t of row.themes)
		if (!allowed.includes(t))
			throw new UiChangeError(
				`Theme "${t}" is not one of this project's themes (${allowed.join(', ')}).`
			);
	if (!row.accounts.trim())
		throw new UiChangeError('Name an account, or "none" to stay signed out.');
}

/** The page's own locator for a level spec, honouring a css: override. */
export const locatorFor = (spec: string): string | null => {
	const [name, override] = spec.split('=');
	if (override?.startsWith('css:')) return override.slice(4);
	return DEFAULT_LOCATORS[name] ?? null;
};

// -- FUNCTIONS: THE SCALE AND THE FLAGS -- //

const within = (value: number, want: number | number[], tol: number) =>
	Array.isArray(want)
		? want.some((w) => Math.abs(value - w) <= tol)
		: Math.abs(value - want) <= tol;

/**
 * Flags for one measured level: a value off the project scale, or larger than the sibling at the same level.
 * `scaleLevel` is the scale entry for this theme and width. Text levels compare font size to the sibling, controls also height.
 */
export function flagsFor(
	level: string,
	measured: Measured | null,
	sibling: Measured | null,
	scaleLevel: Record<string, number | number[]> | undefined,
	tol = TOLERANCE_PX
): Flag[] {
	if (!measured) return [{ level, kind: 'missing', text: `No ${level} found on the page` }];
	const flags: Flag[] = [];
	for (const [k, want] of Object.entries(scaleLevel ?? {})) {
		const v = (measured as Record<string, number>)[k];
		if (v == null || k === 'fontWeight') continue;
		if (!within(v, want, tol))
			flags.push({
				level,
				kind: 'off-scale',
				text: `${level} ${k} ${v}px, the scale says ${([] as number[]).concat(want).join(' or ')}px`
			});
	}
	if (sibling) {
		const keys: (keyof Measured)[] = ['title', 'section', 'body', 'label'].includes(level)
			? ['fontSize']
			: ['fontSize', 'height'];
		for (const k of keys) {
			const a = measured[k];
			const b = sibling[k];
			if (a != null && b != null && a > b + tol)
				flags.push({
					level,
					kind: 'larger-than-sibling',
					text: `${level} ${k} ${a}px, the sibling uses ${b}px`
				});
		}
	}
	return flags;
}

/** All flags of one measured page against its siblings (the first sibling that has the level) and the scale. */
export function flagsForPage(
	levels: string[],
	measured: MeasuredLevels,
	siblings: MeasuredLevels[],
	scale: ScaleLevels | undefined,
	tol = TOLERANCE_PX
): Flag[] {
	const out: Flag[] = [];
	for (const spec of levels) {
		const name = levelName(spec);
		const sib = siblings.map((m) => m[name]).find(Boolean) ?? null;
		out.push(...flagsFor(name, measured[name] ?? null, sib, scale?.[name], tol));
	}
	return out;
}

/**
 * Builds a project scale from the pages a measure job opened. For each level and property it keeps the values seen
 * (rounded to half a pixel), and counts on how many pages the level was seen. A level seen on fewer than three pages is
 * reported and left out of `levels`, so it never flags anything.
 */
export function buildScale(samples: ScaleSample[]): {
	levels: ScaleLevels;
	seenOn: Record<string, number>;
	unused: string[];
} {
	const seenOn: Record<string, number> = {};
	const values: Record<string, Record<string, Map<number, number>>> = {};
	for (const s of samples) {
		for (const [level, m] of Object.entries(s.measured)) {
			if (!m) continue;
			seenOn[level] = (seenOn[level] ?? 0) + 1;
			for (const prop of LEVEL_PROPS[level] ?? []) {
				const v = Math.round(m[prop] * 2) / 2;
				const byProp = (values[level] ??= {});
				const counts = (byProp[prop] ??= new Map());
				counts.set(v, (counts.get(v) ?? 0) + 1);
			}
		}
	}
	const levels: ScaleLevels = {};
	const unused: string[] = [];
	for (const level of Object.keys(seenOn)) {
		if (seenOn[level] < MIN_PAGES_FOR_SCALE) {
			unused.push(level);
			continue;
		}
		const entry: Record<string, number | number[]> = {};
		for (const [prop, counts] of Object.entries(values[level] ?? {})) {
			// A value counts when it was seen on at least two pages or is the most common one
			const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
			const keep = sorted.filter(([, n], i) => i === 0 || n >= 2).map(([v]) => v);
			keep.sort((a, b) => a - b);
			entry[prop] = keep.length === 1 ? keep[0] : keep;
		}
		levels[level] = entry;
	}
	return { levels, seenOn, unused };
}

/** The name of a stored picture for a shots result, safe for a file name. */
export const shotFileName = (r: {
	page: string;
	state: string;
	theme: string;
	viewport: number;
	side: string;
}) =>
	`${r.side}-${r.page.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root'}${r.state ? '-state' : ''}-${r.theme}-${r.viewport}.jpg`;
