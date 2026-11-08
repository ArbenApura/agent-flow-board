// WHERE THE CHECK COMMANDS KEEP THEIR STATE: ONE FOLDER UNDER THE BRIDGE HOME, NEVER INSIDE A REPO
// The bridge home also holds the token store (key and token files). Nothing here ever names those, and the sandboxed child of a check is
// given read access to the scripts folder, its own run folder and the Playwright runtime only (see sandbox.ts).
// -- DEP-MODULES -- //
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
// -- MODULES -- //
import { configDir } from '../tokenStore.js';
// -- CONSTANTS -- //
/** The version of the conversation between the board and the check tool. The board refuses a tool older than its minimum. */
export const TOOL_PROTOCOL = 2;
/** Item references and check keys: letters, digits, dash and underscore only, so a name can never leave its folder. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** An organisation slug as the app writes it. */
export const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;
// -- FUNCTIONS -- //
/** The folder of all check state. AFB_BRIDGE_HOME moves it, which is how the tests get a throwaway one. */
export const checksHome = () => join(configDir(), 'checks');
/** Check scripts: scripts/<org>/<item>/<key>.mjs. Written by the agent, never fetched and run from the board. */
export const scriptsDir = () => join(checksHome(), 'scripts');
/** One folder per run, named by the run id. */
export const runsDir = () => join(checksHome(), 'runs');
export const locksDir = () => join(checksHome(), 'locks');
export const auditFile = () => join(checksHome(), 'audit.log');
export const bindingsFile = () => join(checksHome(), 'bindings.json');
/** Private copies of repos, one per run, kept so a crashed run can be swept. */
export const copiesDir = () => join(checksHome(), 'copies');
export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}
/** Refuses a name that is not a plain name (a path separator, a dot dot, an empty string). */
export function assertName(value, what) {
    if (!NAME.test(value))
        throw new Error(`${what} "${value.slice(0, 40)}" is not a plain name (letters, digits, dash, underscore).`);
    return value;
}
/** Joins parts below a base and proves the result stays below it. Throws when it does not. */
export function under(base, ...parts) {
    const full = resolve(base, ...parts);
    const rel = relative(resolve(base), full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('That path leaves its folder.');
    return full;
}
/** The path of a check script. */
export function scriptPath(org, item, key) {
    if (!ORG_SLUG.test(org))
        throw new Error('The organisation is not a slug.');
    return under(scriptsDir(), org, assertName(item, 'item reference'), `${assertName(key, 'check key')}.mjs`);
}
/** True when `child` is `parent` or inside it, compared by real path so a link cannot step outside. */
export function isInside(parent, child) {
    try {
        const rel = relative(realpathSync(parent), realpathSync(child));
        return (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')));
    }
    catch {
        return false;
    }
}
