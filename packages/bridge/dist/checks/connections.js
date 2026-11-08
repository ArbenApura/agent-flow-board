// THE BOARDS THIS MACHINE IS CONNECTED TO FOR CHECKS: SERVER AND ORGANISATION ONLY, NEVER A TOKEN (THE TOKEN IS IN THE TOKEN STORE)
// `check watch` re-reads this list on every loop, so a `check connect` for a second organisation is picked up without a restart.
// -- DEP-MODULES -- //
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { checksHome, ensureDir, ORG_SLUG } from './paths.js';
// -- FUNCTIONS -- //
const file = () => join(checksHome(), 'connections.json');
export function listConnections() {
    if (!existsSync(file()))
        return [];
    try {
        const v = JSON.parse(readFileSync(file(), 'utf8'));
        return Array.isArray(v)
            ? v.filter((c) => !!c &&
                typeof c.server === 'string' &&
                typeof c.org === 'string' &&
                ORG_SLUG.test(c.org) &&
                typeof c.name === 'string')
            : [];
    }
    catch {
        return [];
    }
}
/** Adds or replaces the connection for a server and organisation. Written whole, never half. */
export function recordConnection(c) {
    const next = [...listConnections().filter((x) => !(x.server === c.server && x.org === c.org)), c];
    ensureDir(checksHome());
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
    renameSync(tmp, file());
}
export function forgetConnection(server, org) {
    const next = listConnections().filter((x) => !(x.server === server && x.org === org));
    ensureDir(checksHome());
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
    renameSync(tmp, file());
}
