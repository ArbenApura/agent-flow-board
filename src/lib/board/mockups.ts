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
/** From this many mockups on a plan the switch between them is one picker instead of a row of chips. */
export const PICKER_FROM = 6;

// -- FUNCTIONS -- //

/** True when the switch between a plan's mockups is one picker: a phone always, a desktop from six mockups on. */
export const switchIsPicker = (count: number, phone: boolean): boolean =>
	phone || count >= PICKER_FROM;

/** The place before or after `index` in a list of `length`, going round at both ends. An empty list stays at 0. */
export function roundIndex(index: number, step: number, length: number): number {
	if (length <= 0) return 0;
	return (((index + step) % length) + length) % length;
}

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

// -- WHAT A MOCKUP OFFERS (AFB-20261109-0604) -- //

const CONFIG_KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_CONFIG_SCREENS = 12;
export const MAX_CONFIG_OPTIONS = 6;
export const MAX_CONFIG_VALUES = 12;
/** The key of the screen list in a choice. An option may not use it. */
export const SCREEN_OPTION = 'screen';

export type ConfigValue = { value: string; label: string };
/** An option may say which of the page's screens it applies to. Without `screens` it applies to every screen. */
export type ConfigOption = {
	key: string;
	label: string;
	values: ConfigValue[];
	screens?: string[];
};
/** What a mockup declared: its own screens (steps of a flow) and the options a person may switch (a mode, a brand, a role). */
export type FrameConfig = { screens: ConfigValue[]; options: ConfigOption[] };

/** A label: printable text only, trimmed, 1 to 32 characters. */
const labelOf = (v: unknown): string | null => {
	if (typeof v !== 'string') return null;
	const t = [...v]
		.filter((c) => c >= ' ' && c !== '\u007f')
		.join('')
		.trim();
	return t.length >= 1 && t.length <= 32 ? t : null;
};

/** A list of [key, label] pairs with unique keys, or null when anything is off or there are more than `max`. */
function valuesOf(raw: unknown, max: number): ConfigValue[] | null {
	if (!Array.isArray(raw) || raw.length > max) return null;
	const seen = new Set<string>();
	const out: ConfigValue[] = [];
	for (const p of raw) {
		if (!Array.isArray(p) || p.length !== 2) return null;
		const [value, label] = p as [unknown, unknown];
		const text = labelOf(label);
		if (typeof value !== 'string' || !CONFIG_KEY.test(value) || !text || seen.has(value))
			return null;
		seen.add(value);
		out.push({ value, label: text });
	}
	return out;
}

/**
 * The screens an option applies to: an array of at most MAX_CONFIG_SCREENS unique keys that are all screens the page declared, or
 * null when anything is off. A Set is used for both checks, so a key such as `__proto__` is only ever a string.
 */
function optionScreensOf(raw: unknown, declared: ReadonlySet<string>): string[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_CONFIG_SCREENS) return null;
	const seen = new Set<string>();
	for (const s of raw) {
		if (typeof s !== 'string' || !CONFIG_KEY.test(s) || !declared.has(s) || seen.has(s))
			return null;
		seen.add(s);
	}
	return [...seen];
}

/** True when an option shows on a screen: no list (or an empty one) means every screen, and so does a page that has no current screen. */
export function optionApplies(option: ConfigOption, screen: string | undefined): boolean {
	return !option.screens?.length || screen === undefined || option.screens.includes(screen);
}

/** The options to draw for the screen on show. Purely derived: a hidden option keeps its value, it is only not drawn. */
export function visibleOptions(config: FrameConfig, screen: string | undefined): ConfigOption[] {
	return config.options.filter((o) => optionApplies(o, screen));
}

/**
 * The message a mockup sends once, after it loads: the screens and options it declared and the value each has now. Anything that is
 * not exactly in shape (too many, a bad key, a duplicate, an option with fewer than two values) makes a whole option or the whole
 * message refused, so a page can never put more than the limits on the board's toolbar. A current value that is not declared is
 * the first one.
 */
export function parseConfigMessage(
	data: unknown,
	from: unknown,
	frame: unknown
): { config: FrameConfig; current: Record<string, string> } | null {
	const m = messageFrom(data, from, frame, 'afb-config', 'config,current,type');
	if (!m || !m.config || typeof m.config !== 'object' || Array.isArray(m.config)) return null;
	const raw = m.config as Record<string, unknown>;
	if (Object.keys(raw).sort().join(',') !== 'options,screens') return null;
	const screens = valuesOf(raw.screens, MAX_CONFIG_SCREENS);
	if (!screens || !Array.isArray(raw.options) || raw.options.length > MAX_CONFIG_OPTIONS)
		return null;
	const options: ConfigOption[] = [];
	const seen = new Set<string>();
	const declared = new Set(screens.map((s) => s.value));
	for (const o of raw.options) {
		if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
		const r = o as Record<string, unknown>;
		const label = labelOf(r.label);
		const values = valuesOf(r.values, MAX_CONFIG_VALUES);
		// Exactly these two shapes: an option with its `screens` list, or without it
		const shape = Object.keys(r).sort().join(',');
		if (shape !== 'key,label,values' && shape !== 'key,label,screens,values') return null;
		if (typeof r.key !== 'string' || !CONFIG_KEY.test(r.key) || r.key === SCREEN_OPTION)
			return null;
		if (!label || !values || values.length < 2 || seen.has(r.key)) return null;
		seen.add(r.key);
		if (shape === 'key,label,values') {
			options.push({ key: r.key, label, values });
			continue;
		}
		// A bad `screens` list refuses only its own option: the rest of the page's controls stand
		const scoped = optionScreensOf(r.screens, declared);
		if (scoped)
			options.push({ key: r.key, label, values, ...(scoped.length ? { screens: scoped } : {}) });
	}
	const given =
		m.current && typeof m.current === 'object' && !Array.isArray(m.current)
			? (m.current as Record<string, unknown>)
			: {};
	const current: Record<string, string> = {};
	for (const o of options)
		current[o.key] = o.values.some((v) => v.value === given[o.key])
			? (given[o.key] as string)
			: o.values[0].value;
	if (screens.length)
		current[SCREEN_OPTION] = screens.some((v) => v.value === given[SCREEN_OPTION])
			? (given[SCREEN_OPTION] as string)
			: screens[0].value;
	return { config: { screens, options }, current };
}

/** The choice the board sends a mockup: an option key (or `screen`) and one of its values. The frame checks both against what the page declared. */
export const setMessage = (key: string, value: string) => ({ type: 'afb-set', key, value });

/** The message a mockup sends when the person presses [ or ] on it: one screen back or forward. */
export function parseStepMessage(
	data: unknown,
	from: unknown,
	frame: unknown
): 'prev' | 'next' | null {
	const m = messageFrom(data, from, frame, 'afb-step', 'dir,type');
	return m && (m.dir === 'prev' || m.dir === 'next') ? m.dir : null;
}

/**
 * The message a mockup sends when a choice from the board changed nothing in the page, or when the page's own hook threw: the key of
 * the choice and why. The board shows it as a quiet hint and never acts on it otherwise.
 */
export function parseUnresponsiveMessage(
	data: unknown,
	from: unknown,
	frame: unknown
): { key: string; reason: 'none' | 'error' } | null {
	const m = messageFrom(data, from, frame, 'afb-unresponsive', 'key,reason,type');
	if (!m || typeof m.key !== 'string' || !CONFIG_KEY.test(m.key)) return null;
	return m.reason === 'none' || m.reason === 'error' ? { key: m.key, reason: m.reason } : null;
}

/** The value of a choice that the mockup declares, or the one it started with. Used to apply what the address or the browser remembered. */
export function validChoice(config: FrameConfig, key: string, value: unknown): string | null {
	const list =
		key === SCREEN_OPTION ? config.screens : config.options.find((o) => o.key === key)?.values;
	return list?.some((v) => v.value === value) ? (value as string) : null;
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
