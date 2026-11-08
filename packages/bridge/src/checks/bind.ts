// THE FOLDER BINDING OF `check watch`: WHICH REAL FOLDER BUILDS THE PROJECT <org>/<KEY>, AND THE PIN OF THE FILES THAT DECIDED WHAT RUNS.
// When the pin changes (a new script, a changed recipe, a new lockfile) the watcher stops and tells the person to run `check run` in that
// folder, which looks at the new setup and pins it again. Nothing in the repo can re-pin by itself.

// -- DEP-MODULES -- //
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// -- MODULES -- //
import { bindingsFile, ensureDir, ORG_SLUG } from './paths.js';
import { checkRepoFolder } from './guardrails.js';
import { pinFiles } from './recipe.js';

// -- TYPES -- //

export type Binding = { org: string; projectKey: string; folder: string; pin: string };
type Stored = { folder: string; pin: string };

// -- CONSTANTS -- //

const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

// -- FUNCTIONS -- //

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

function idOf(org: string, projectKey: string): string {
	if (!ORG_SLUG.test(org)) throw new Error('The organisation is not a slug.');
	if (!PROJECT_KEY.test(projectKey))
		throw new Error(
			'The project key must be 2 to 10 capital letters or digits, starting with a letter.'
		);
	return `${org}/${projectKey}`;
}

function readAll(): Record<string, Stored> {
	const file = bindingsFile();
	if (!existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		throw new Error(`${file} is not valid JSON. Fix or remove it.`);
	}
	const out: Record<string, Stored> = {};
	if (isRecord(parsed) && isRecord(parsed.bindings))
		for (const [id, v] of Object.entries(parsed.bindings))
			if (isRecord(v) && typeof v.folder === 'string' && typeof v.pin === 'string')
				out[id] = { folder: v.folder, pin: v.pin };
	return out;
}

/** Writes a temp file in the same folder, then renames it over the real one, so a reader never sees half a file. */
function writeAll(bindings: Record<string, Stored>): void {
	const file = bindingsFile();
	ensureDir(dirname(file));
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify({ version: 1, bindings }, null, 2) + '\n', { mode: 0o600 });
		renameSync(temp, file);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}
}

/** Binds a project to a folder. Refuses a folder the guardrails refuse. Stores the real path and the given pin. */
export function bindFolder(org: string, projectKey: string, folder: string, pin: string): void {
	const id = idOf(org, projectKey);
	const problem = checkRepoFolder(folder);
	if (problem) throw new Error(problem);
	const all = readAll();
	all[id] = { folder: realpathSync.native(folder), pin };
	writeAll(all);
}

/** The folder and pin of a project, or null when it has none. */
export function boundFolder(
	org: string,
	projectKey: string
): { folder: string; pin: string } | null {
	const found = readAll()[idOf(org, projectKey)];
	return found ? { folder: found.folder, pin: found.pin } : null;
}

/** Every binding, sorted by org and key. */
export function listBindings(): Binding[] {
	return Object.entries(readAll())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, v]) => {
			const [org = '', projectKey = ''] = id.split('/');
			return { org, projectKey, folder: v.folder, pin: v.pin };
		});
}

/** Removes a binding. True when there was one. */
export function unbind(org: string, projectKey: string): boolean {
	const id = idOf(org, projectKey);
	const all = readAll();
	if (!(id in all)) return false;
	delete all[id];
	writeAll(all);
	return true;
}

/**
 * Whether the files that decide what runs are still the ones the person approved. `changed` also covers a folder that is gone or no longer
 * allowed: the caller tells the person to run `check run` in that folder, which looks again and re-pins.
 */
export function pinStatus(org: string, projectKey: string): 'ok' | 'changed' | 'unbound' {
	const found = boundFolder(org, projectKey);
	if (!found) return 'unbound';
	if (checkRepoFolder(found.folder)) return 'changed';
	return pinFiles(join(found.folder)) === found.pin ? 'ok' : 'changed';
}
