// SHARED, BROWSER SAFE HELPERS OF THE MOCKUP SCREENS: SCREEN WIDTHS, THE FILTERS OF THE LIST, AND THE ONE MESSAGE A MOCKUP MAY SEND

// -- TYPES -- //
export type ScreenKey = 'wide' | 'laptop' | 'tablet' | 'phone';
export type MockupRow = {
	id: string;
	title: string;
	itemId: string | null;
	currentVersion: number;
	versions: number;
	hasShot: boolean;
	visibility: 'public' | 'private';
	publicLinkOn: boolean;
	updatedAt: string | Date;
	plan: { ref: string; title: string } | null;
	/** A signed address of the thumbnail, made by the page loader. */
	thumb?: string | null;
};
export type PinMessage = { x: number; y: number; hint: string };
export type PinRow = {
	id: string;
	version: number;
	x: number;
	y: number;
	hint: string;
	author: string;
	body: string;
	createdAt: string | Date;
};
export type MockupScope = 'all' | 'plan' | 'alone';
export type MockupView = 'cards' | 'list';

// -- CONSTANTS -- //

export const SCREEN_WIDTH: Record<ScreenKey, number> = {
	wide: 1600,
	laptop: 1280,
	tablet: 820,
	phone: 408
};
export const SCREEN_LABEL: Record<ScreenKey, string> = {
	wide: 'Wide',
	laptop: 'Laptop',
	tablet: 'Tablet',
	phone: 'Phone'
};
export const ALL_SCREENS = Object.keys(SCREEN_WIDTH) as ScreenKey[];
export const SCOPES: MockupScope[] = ['all', 'plan', 'alone'];
export const SCOPE_LABEL: Record<MockupScope, string> = {
	all: 'All mockups',
	plan: 'On a plan',
	alone: 'Without a plan'
};
export const VIEWS: MockupView[] = ['cards', 'list'];
export const VIEW_LABEL: Record<MockupView, string> = { cards: 'Cards', list: 'List' };

// -- FUNCTIONS -- //

export const isScreen = (v: unknown): v is ScreenKey => typeof v === 'string' && v in SCREEN_WIDTH;

/** The screens a project offers, in the fixed order, never empty. */
export function screensOf(saved: string[] | null | undefined): ScreenKey[] {
	const picked = ALL_SCREENS.filter((s) => saved?.includes(s));
	return picked.length ? picked : ALL_SCREENS;
}

/** How much a mockup drawn at `screen` pixels is shrunk to fit a stage `available` pixels wide. Never larger than life. */
export function scaleFor(available: number, screen: number): number {
	if (!Number.isFinite(available) || available <= 0 || screen <= 0) return 1;
	return Math.min(1, Math.round((available / screen) * 1000) / 1000);
}

/** The open filters of the list, read from the address. A wrong value is the default. */
export function readFilters(params: { get(name: string): string | null }): {
	q: string;
	scope: MockupScope;
	view: MockupView;
} {
	const scope = params.get('scope');
	const view = params.get('view');
	return {
		q: (params.get('q') ?? '').slice(0, 200),
		scope: SCOPES.includes(scope as MockupScope) ? (scope as MockupScope) : 'all',
		view: VIEWS.includes(view as MockupView) ? (view as MockupView) : 'cards'
	};
}

/** The mockups that match the search and the scope. The search reads the title and the plan reference and title. */
export function filterMockups<T extends Pick<MockupRow, 'title' | 'plan'>>(
	rows: T[],
	f: { q: string; scope: MockupScope }
): T[] {
	const q = f.q.trim().toLowerCase();
	return rows.filter((m) => {
		if (f.scope === 'plan' && !m.plan) return false;
		if (f.scope === 'alone' && m.plan) return false;
		if (!q) return true;
		return [m.title, m.plan?.ref, m.plan?.title].some((s) => s?.toLowerCase().includes(q));
	});
}

/** Counts of each scope, for the filter popover. */
export function scopeCounts(rows: Pick<MockupRow, 'plan'>[]): Record<MockupScope, number> {
	const plan = rows.filter((m) => m.plan).length;
	return { all: rows.length, plan, alone: rows.length - plan };
}

/**
 * The one message a mockup may send its parent: a click as a type, two numbers in percent and a short element hint. The parent
 * accepts it only from the preview frame's own window and only in exactly this shape, so a page that sends anything else is ignored.
 */
export function parsePinMessage(data: unknown, from: unknown, frame: unknown): PinMessage | null {
	if (!frame || from !== frame) return null;
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	const keys = Object.keys(data).sort().join(',');
	if (keys !== 'hint,type,x,y') return null;
	const m = data as Record<string, unknown>;
	if (m.type !== 'afb-mockup-pin') return null;
	if (typeof m.x !== 'number' || typeof m.y !== 'number' || typeof m.hint !== 'string') return null;
	if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
	if (m.x < 0 || m.x > 100 || m.y < 0 || m.y > 100) return null;
	return {
		x: Math.round(m.x * 100) / 100,
		y: Math.round(m.y * 100) / 100,
		// Printable text only, cut to the length the server keeps
		hint: [...m.hint]
			.filter((c) => c >= ' ' && c !== '\u007f')
			.join('')
			.slice(0, 120)
	};
}

/** True for the message a mockup sends when it has loaded, so the parent can hand it the pins to draw. */
export const isReadyMessage = (data: unknown, from: unknown, frame: unknown): boolean =>
	Boolean(frame) &&
	from === frame &&
	typeof data === 'object' &&
	data !== null &&
	Object.keys(data).join(',') === 'type' &&
	(data as { type?: unknown }).type === 'afb-mockup-ready';

/** The pins of one version, numbered in the order they were made, for the list and the frame. */
export function pinsOf(pins: PinRow[], version: number): PinRow[] {
	return pins
		.filter((p) => p.version === version)
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** What a person pastes into their coding tool to ask for a mockup. It names no file and no secret. */
export const mockupPrompt = (projectName: string) =>
	`Make a design mockup for ${projectName} with the flow-mockup skill. Read the project's mockup style and kit from the board first, build one interactive HTML page that looks like the real product, and publish it to the board. Tell me which plan or screen it is for before you start if I did not say.`;
