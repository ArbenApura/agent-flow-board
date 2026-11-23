// WHERE THE MOCKUP RENDERS KEEP THEIR STATE: ONE FOLDER UNDER THE BRIDGE HOME, NEVER INSIDE A REPO
// The folder is still called `checks` (the browser runtime installed there by an earlier bridge is reused, nothing is downloaded again).
// The bridge home also holds the token store (key and token files). Nothing here ever names those.

// IMPORTED DEP-MODULES
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
// IMPORTED MODULES
import { configDir } from '../tokenStore.js';

// -- CONSTANTS -- //

/** A plain name: letters, digits, dash and underscore only, so a name can never leave its folder. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// -- FUNCTIONS -- //

/** The folder of the browser state. AFB_BRIDGE_HOME moves it, which is how the tests get a throwaway one. */
export const checksHome = () => join(configDir(), 'checks');
export const locksDir = () => join(checksHome(), 'locks');
/** The shared browser pool of this machine, found through files here. */
export const poolDir = () => join(checksHome(), 'pool');

export function ensureDir(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Refuses a name that is not a plain name (a path separator, a dot dot, an empty string). */
export function assertName(value: string, what: string): string {
	if (!NAME.test(value))
		throw new Error(
			`${what} "${value.slice(0, 40)}" is not a plain name (letters, digits, dash, underscore).`
		);
	return value;
}
