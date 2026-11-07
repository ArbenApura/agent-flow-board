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
	/** A signed address of the picture, made by the page loader: a screenshot, or a live preview page when there is none. */
	thumb?: string | null;
	/** True when `thumb` is a page to show in a frame, false when it is a screenshot. */
	live?: boolean;
};
/** Where a click or a drag landed: percent of the page, and the point in the frame with the frame's own size, so the board can place its box. */
export type PinPoint = {
	x: number;
	y: number;
	clientX: number;
	clientY: number;
	viewW: number;
	viewH: number;
};
export type PinMessage = PinPoint & { hint: string };
export type PinRow = {
	id: string;
	version: number;
	x: number;
	y: number;
	hint: string;
	/** The device the pin was placed on. Null for an older pin, which shows on every device. */
	device: string | null;
	resolved: boolean;
	resolvedBy: string | null;
	author: string;
	body: string;
	createdAt: string | Date;
};
/** A pin numbered for the list: the number is its place among all the pins of its version. */
export type CommentRow = PinRow & { n: number };
/** What a person asked of the frame by key, forwarded by the frame because the keys go to the page that has focus. */
export type PinKey = 'c' | 'Escape';
/** A pin as the frame draws it: no text and no author, only where it is, its number and whether it is done. */
export type FramePin = { id: string; x: number; y: number; n: number; done: boolean };
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const POINT_KEYS = 'clientX,clientY,type,viewH,viewW,x,y';

/** The messages a mockup page may send its parent, all read by one function so each has its own exact shape. */
function messageFrom(data: unknown, from: unknown, frame: unknown, type: string, keys: string) {
	if (!frame || from !== frame) return null;
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	if (Object.keys(data).sort().join(',') !== keys.split(',').sort().join(',')) return null;
	const m = data as Record<string, unknown>;
	return m.type === type ? m : null;
}

/** A finite number inside a range, or null. */
const inRange = (v: unknown, min: number, max: number): number | null =>
	typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;

function pointOf(m: Record<string, unknown>): PinPoint | null {
	const x = inRange(m.x, 0, 100);
	const y = inRange(m.y, 0, 100);
	const viewW = inRange(m.viewW, 1, 10_000);
	const viewH = inRange(m.viewH, 1, 100_000);
	const clientX = inRange(m.clientX, 0, 10_000);
	const clientY = inRange(m.clientY, 0, 100_000);
	if (x === null || y === null || viewW === null || viewH === null) return null;
	if (clientX === null || clientY === null) return null;
	return {
		x: Math.round(x * 100) / 100,
		y: Math.round(y * 100) / 100,
		clientX,
		clientY,
		viewW,
		viewH
	};
}

/**
 * The message a mockup sends when the person clicks to place a pin: a type, two numbers in percent, the click point in the frame, the
 * frame size and a short element hint. The parent accepts it only from the preview frame's own window and only in exactly this
 * shape, so a page that sends anything else is ignored.
 */
export function parsePinMessage(data: unknown, from: unknown, frame: unknown): PinMessage | null {
	const m = messageFrom(data, from, frame, 'afb-mockup-pin', `hint,${POINT_KEYS}`);
	if (!m || typeof m.hint !== 'string') return null;
	const point = pointOf(m);
	if (!point) return null;
	return {
		...point,
		// Printable text only, cut to the length the server keeps
		hint: [...m.hint]
			.filter((c) => c >= ' ' && c !== '\u007f')
			.join('')
			.slice(0, 120)
	};
}

/** The message a mockup sends while the pin being placed is dragged. Same checks, no hint. */
export function parsePinMove(data: unknown, from: unknown, frame: unknown): PinPoint | null {
	const m = messageFrom(data, from, frame, 'afb-pin-move', POINT_KEYS);
	return m ? pointOf(m) : null;
}

/** The message a mockup sends when a pin on it is clicked: only the id. The board looks the id up in the pins it already has. */
export function parsePinClick(data: unknown, from: unknown, frame: unknown): string | null {
	const m = messageFrom(data, from, frame, 'afb-pin-click', 'id,type');
	return m && typeof m.id === 'string' && UUID.test(m.id) ? m.id : null;
}

/** The message a mockup sends for the one key it forwards (the keys go to the page that has focus, which is the frame after a click). */
export function parsePinKey(data: unknown, from: unknown, frame: unknown): PinKey | null {
	const m = messageFrom(data, from, frame, 'afb-pin-key', 'key,type');
	return m && (m.key === 'c' || m.key === 'Escape') ? m.key : null;
}

/** A colour the frame may be given: exactly #rrggbb, anything else is null and the frame uses its own fallback. */
export const frameColour = (v: string | null | undefined): string | null => {
	const t = (v ?? '').trim();
	return HEX_COLOUR.test(t) ? t : null;
};

/**
 * What the parent sends a mockup frame each time the frame says it is ready or something changes: the pin mode, then the pins to
 * draw. A pin goes with its place, its number and whether it is done. Never its text or its author.
 */
export function pinMessages(
	pinMode: boolean,
	pins: FramePin[],
	look: {
		draft?: { x: number; y: number } | null;
		accent?: string | null;
		ink?: string | null;
		reduced?: boolean;
	} = {}
) {
	return [
		{ type: 'afb-pin-mode', on: pinMode },
		{
			type: 'afb-pins',
			pins: pins.map((p) => ({ id: p.id, x: p.x, y: p.y, n: p.n, done: p.done })),
			draft: look.draft ? { x: look.draft.x, y: look.draft.y } : null,
			accent: frameColour(look.accent),
			ink: frameColour(look.ink),
			reduced: look.reduced === true
		}
	];
}

/** Asks the frame to scroll a pin into view and pulse it. */
export const focusMessage = (id: string, reduced: boolean) => ({
	type: 'afb-pin-focus',
	id,
	reduced
});

/** True for the message a mockup sends when it has loaded, so the parent can hand it the pins to draw. */
export const isReadyMessage = (data: unknown, from: unknown, frame: unknown): boolean =>
	Boolean(frame) &&
	from === frame &&
	typeof data === 'object' &&
	data !== null &&
	Object.keys(data).join(',') === 'type' &&
	(data as { type?: unknown }).type === 'afb-mockup-ready';

/** The pins of one version, numbered in the order they were made (the number is the position in this list, whatever the device), for the list and the frame. */
export function pinsOf(pins: PinRow[], version: number): PinRow[] {
	return pins
		.filter((p) => p.version === version)
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Whether a pin shows on a device: one placed on that device, or an older pin with no device. */
export const onDevice = (p: Pick<PinRow, 'device'>, device: string): boolean =>
	p.device === null || p.device === device;

/** Which pins a filter shows: the ones still open, the ones done, or all of them. */
export type PinFilter = 'open' | 'done' | 'all';
export const PIN_FILTERS: PinFilter[] = ['open', 'done', 'all'];
export const PIN_FILTER_LABEL: Record<PinFilter, string> = {
	open: 'Open',
	done: 'Resolved',
	all: 'All'
};
export const inPinFilter = (p: Pick<PinRow, 'resolved'>, filter: PinFilter): boolean =>
	filter === 'all' || (filter === 'open') !== p.resolved;

/**
 * Where the board puts its comment box so it sits beside a pin: the click point in the frame, scaled to the stage by the frame's
 * on-screen rectangle (which already carries the zoom or the transform), to the right of the pin or to the left when the right is
 * too tight, kept inside the stage. All numbers are pixels of the stage.
 */
export function boxPlace(
	point: Pick<PinPoint, 'clientX' | 'clientY' | 'viewW' | 'viewH'>,
	frame: { left: number; top: number; width: number; height: number },
	stage: { width: number; height: number },
	box: { width: number; height: number },
	gap = 22
): { left: number; top: number } {
	const px = frame.left + (point.clientX / Math.max(1, point.viewW)) * frame.width;
	const py = frame.top + (point.clientY / Math.max(1, point.viewH)) * frame.height;
	const width = Math.min(box.width, Math.max(0, stage.width - 16));
	const right = px + gap + width;
	const left = right > stage.width - 8 ? px - gap - width : px + gap;
	return {
		left: Math.max(8, Math.min(left, stage.width - width - 8)),
		top: Math.max(8, Math.min(py - 20, stage.height - box.height - 8))
	};
}

/** What a person pastes into their coding tool to ask for a mockup. It names no file and no secret. */
export const mockupPrompt = (projectName: string) =>
	`Make a design mockup for ${projectName} with the flow-mockup skill. Read the project's kit from the board first, build one interactive HTML page that looks like the real product, and publish it to the board. Tell me which plan or screen it is for before you start if I did not say.`;
