// THEME MODE: LIGHT, DARK OR SYSTEM, KEPT IN A COOKIE SO THE SERVER RENDERS THE RIGHT FIRST PAINT (SPEC 11)

// -- TYPES -- //

export type ModeChoice = 'light' | 'dark' | 'system';
export type ResolvedMode = 'light' | 'dark';

// -- CONSTANTS -- //

export const MODE_COOKIE = 'afb-mode';
export const MODE_CHOICES: ModeChoice[] = ['light', 'dark', 'system'];

/** Runs in the head before first paint, so a system mode never flashes the wrong theme. */
export const SYSTEM_MODE_SCRIPT =
	"(function(){var d=document.documentElement;if(d.dataset.system==='1'){d.dataset.mode=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}})()";

// -- FUNCTIONS -- //

/** Reads the stored choice. Anything unknown is the default, system. */
export function parseMode(value: string | undefined | null): ModeChoice {
	return value === 'light' || value === 'dark' ? value : 'system';
}

/** The mode the server renders. System starts as light and the head script corrects it before paint. */
export function serverMode(choice: ModeChoice): ResolvedMode {
	return choice === 'dark' ? 'dark' : 'light';
}

/** Sets the choice in the browser: the cookie for the next request and the attributes for this page. */
export function applyMode(choice: ModeChoice): void {
	const root = document.documentElement;
	const resolved: ResolvedMode =
		choice === 'system'
			? matchMedia('(prefers-color-scheme: dark)').matches
				? 'dark'
				: 'light'
			: choice;
	root.dataset.mode = resolved;
	root.dataset.system = choice === 'system' ? '1' : '0';
	document.cookie = `${MODE_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax`;
}
