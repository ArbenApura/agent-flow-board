// THE LIVE LIGHT OR DARK MODE OF THIS PAGE, SHARED BY THE TOP BAR SWITCH AND THE ACCOUNT SETTINGS

// -- MODULES -- //
import { applyMode, type ResolvedMode } from '#lib/theme/mode.js';

// -- STATES -- //

export const live = $state<{ mode: ResolvedMode }>({ mode: 'light' });

// -- FUNCTIONS -- //

/** Reads the mode the page was painted with, so a system choice shows as the light or dark it resolved to. */
export function syncLive(): void {
	live.mode = document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
}

/** Switches at once, then saves it to the account in the background so the choice follows the person to other devices. */
export function setLiveMode(mode: ResolvedMode): void {
	applyMode(mode);
	live.mode = mode;
	void fetch('/theme', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ mode })
	}).catch(() => {
		/* The cookie already holds the choice for this browser */
	});
}
