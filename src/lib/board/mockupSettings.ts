// THE MOCKUP SETTINGS PAGE WITHOUT THE SCREEN: ITS FOUR TABS, THE EXAMPLE CHIPS, THE DEVICE AND MODE RULES, THE PAGE EXAMPLES AND THE STATE OF COLOURS AND FONTS

// -- TYPES -- //
import type { ScreenKey } from '#lib/board/mockups.js';
// -- CONSTANTS -- //
import { ALL_SCREENS, screensOf } from '#lib/board/mockups.js';

// -- TYPES -- //

export type MockupTab = 'look' | 'devices' | 'examples' | 'colours';
export type DevicesDraft = {
	screens: ScreenKey[];
	light: boolean;
	dark: boolean;
	/** Any other saved mode name. It is kept on save, never dropped. */
	extra: string[];
};
export type ExampleRow = { name: string; prompt: string };
export type KitState = { number: number; stale: boolean } | null;

// -- CONSTANTS -- //

export const MOCKUP_TABS: { id: MockupTab; label: string }[] = [
	{ id: 'look', label: 'Look and feel' },
	{ id: 'devices', label: 'Devices' },
	{ id: 'examples', label: 'Page examples' },
	{ id: 'colours', label: 'Colours and fonts' }
];
/** One tap adds this sentence to Look and feel. */
export const LOOK_CHIPS: { label: string; text: string }[] = [
	{
		label: 'Calm and roomy',
		text: 'Calm and roomy: generous spacing, soft corners and one quiet accent colour.'
	},
	{
		label: 'Dense like a dashboard',
		text: 'Dense like a dashboard: tight rows, small controls and as much on screen as fits.'
	},
	{
		label: 'Friendly and rounded',
		text: 'Friendly and rounded: large rounded corners, warm wording and plain icons.'
	},
	{
		label: 'Serious and minimal',
		text: 'Serious and minimal: flat surfaces, thin lines, no decoration and short labels.'
	}
];
export const EXAMPLE_SUGGESTIONS = [
	'Settings page',
	'List page',
	'Detail page',
	'Form page',
	'Dashboard'
];
/** The old section names of project settings and the tab of the new page each one forwards to. */
const LEGACY_TABS: Record<string, MockupTab> = {
	'mockup-style': 'look',
	'mockup-screens': 'devices',
	'mockup-templates': 'examples',
	'mockup-kit': 'colours'
};
export const DEVICE_WORDS: Record<ScreenKey, string> = {
	wide: 'Wide',
	laptop: 'Laptop',
	tablet: 'Tablet',
	phone: 'Phone'
};

// -- FUNCTIONS -- //

/** The tab named in the address, or the first one for anything else. */
export const readTab = (raw: string | null | undefined): MockupTab =>
	MOCKUP_TABS.find((t) => t.id === raw)?.id ?? 'look';

/** Adds an example sentence to what is already written, on its own line, once. */
export function addChip(current: string, chipText: string): string {
	if (current.includes(chipText)) return current;
	const base = current.trimEnd();
	return base ? `${base}\n${chipText}` : chipText;
}

// -- DEVICES -- //

/** Reads what is saved into the draft. An empty list of modes reads as light and dark both on. */
export function devicesFromSaved(screens: string[], themes: string[]): DevicesDraft {
	const modes = themes.map((t) => t.trim()).filter(Boolean);
	const none = modes.length === 0;
	return {
		screens: screensOf(screens),
		light: none || modes.includes('light'),
		dark: none || modes.includes('dark'),
		extra: modes.filter((t) => t !== 'light' && t !== 'dark')
	};
}

/** Why the devices cannot be saved yet, in plain words, or null. */
export function devicesIssue(d: DevicesDraft): string | null {
	if (d.screens.length === 0) return 'Keep at least one device on.';
	if (!d.light && !d.dark) return 'Keep at least one colour mode on.';
	return null;
}

/** What is sent to the board: the devices in their fixed order, and the modes with any other saved name kept. */
export function devicesToSave(d: DevicesDraft): { screens: ScreenKey[]; themes: string[] } {
	return {
		screens: ALL_SCREENS.filter((s) => d.screens.includes(s)),
		themes: [...(d.light ? ['light'] : []), ...(d.dark ? ['dark'] : []), ...d.extra]
	};
}

/** True when the draft says something other than what is saved. Order does not matter, and an empty saved list equals both on. */
export function devicesDirty(draft: DevicesDraft, saved: DevicesDraft): boolean {
	const a = devicesToSave(draft);
	const b = devicesToSave(saved);
	return JSON.stringify(a) !== JSON.stringify(b);
}

// -- PAGE EXAMPLES -- //

/** The one click suggestions that are not already in the list, ignoring case and spaces. */
export function suggestionsLeft(names: string[]): string[] {
	const taken = new Set(names.map((n) => n.trim().toLowerCase()));
	return EXAMPLE_SUGGESTIONS.filter((s) => !taken.has(s.toLowerCase()));
}

/** Why the examples cannot be saved yet, or null. An empty list is fine. */
export function examplesIssue(rows: ExampleRow[]): string | null {
	if (rows.some((r) => !r.name.trim())) return 'Every example needs a name.';
	const names = rows.map((r) => r.name.trim().toLowerCase());
	return new Set(names).size !== names.length ? 'Two examples have the same name.' : null;
}

/**
 * What a save has to send. New and changed names are written first and the names that are gone are deleted after, so a failed
 * write never leaves the project with fewer examples than it had.
 */
export function exampleChanges(
	saved: ExampleRow[],
	rows: ExampleRow[]
): { writes: ExampleRow[]; deletes: string[] } {
	const wanted = rows.map((r) => ({ name: r.name.trim(), prompt: r.prompt }));
	const had = new Map(saved.map((s) => [s.name, s.prompt]));
	const keep = new Set(wanted.map((r) => r.name));
	return {
		writes: wanted.filter((r) => !had.has(r.name) || had.get(r.name) !== r.prompt),
		deletes: saved.map((s) => s.name).filter((n) => !keep.has(n))
	};
}

// -- COLOURS AND FONTS -- //

/** The badge of Colours and fonts: made and current, made but behind the design files, or not made yet. */
export function kitState(kit: KitState): {
	label: 'Up to date' | 'Needs an update' | 'Not made yet';
	tone: 'success' | 'warning' | 'neutral';
	line: string;
} {
	if (!kit)
		return {
			label: 'Not made yet',
			tone: 'neutral',
			line: 'Mockups use a plain look until your coding tool makes this.'
		};
	return kit.stale
		? {
				label: 'Needs an update',
				tone: 'warning',
				line: 'Your design files changed after this was made. Your coding tool updates it before the next mockup.'
			}
		: {
				label: 'Up to date',
				tone: 'success',
				line: 'Mockups use these colours, fonts, logo and icons.'
			};
}

/** What a person pastes into their coding tool. Fixed wording plus the project name and key, nothing else the board stores. */
export function kitRequest(projectName: string, projectKey: string): string {
	const clean = (v: string, max: number) =>
		[...v]
			.filter((c) => c >= ' ' && c !== '\u007f')
			.join('')
			.trim()
			.slice(0, max);
	return `Make or update the colours and fonts for ${clean(projectName, 80)} (project ${clean(projectKey, 20)}) for design mockups. Read the design files in the repo (colours for light and dark, fonts, logo, icons and the shell and component markup), build one HTML kit from them, and save it to the board with mockup_kit_set, with the commit it was built from.`;
}

// -- OLD ADDRESSES -- //

/**
 * Where an old project settings address with a mockup tab goes: the new page and its tab. Only a settings address of the shape
 * /org/project/settings is read, the target is built from its two names and a fixed path, and anything else is null.
 */
export function legacyMockupTarget(pathname: string, search: string): string | null {
	const m = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/settings\/?$/.exec(pathname);
	if (!m) return null;
	const tab = new URLSearchParams(search).get('tab');
	if (!tab?.startsWith('mockup-')) return null;
	return `/${m[1]}/${m[2]}/mockups/settings?tab=${LEGACY_TABS[tab] ?? 'look'}`;
}
