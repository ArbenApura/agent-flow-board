// THE VERSION OF THE EDITOR STATUS MOD THIS PERSON HAS INSTALLED (AFB-20261108-0856)
// The setup prompt writes the mod to ~/.claude/skills/afb-flow-status. The hook sends the version on a start so the board can say
// when a newer one is served. A hook must never fail or slow down because of this file, so every problem means "no version".

// IMPORTED DEP-MODULES
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// -- CONSTANTS -- //

const MOD_FOLDER = ['.claude', 'skills', 'afb-flow-status'];
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
/** A manifest is a few hundred bytes: a file far bigger than that is not read. */
const MAX_BYTES = 64 * 1024;

// -- FUNCTIONS -- //

/** The installed mod's plain major.minor.patch version, or undefined when there is no mod, no readable manifest or no plain version. */
export function installedModVersion(home: string = homedir()): string | undefined {
	try {
		const text = readFileSync(join(home, ...MOD_FOLDER, '.claude-plugin', 'plugin.json'), 'utf8');
		if (text.length > MAX_BYTES) return undefined;
		const version = (JSON.parse(text) as { version?: unknown }).version;
		return typeof version === 'string' && VERSION.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}
