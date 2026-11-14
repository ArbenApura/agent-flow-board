// THE BOARDS THIS MACHINE IS CONNECTED TO FOR CHECKS: SERVER AND ORGANISATION ONLY, NEVER A TOKEN (THE TOKEN IS IN THE TOKEN STORE)
// `check watch` re-reads this list on every loop, so a `check connect` for a second organisation is picked up without a restart.

// IMPORTED DEP-MODULES
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// IMPORTED MODULES
import { checksHome, ensureDir, ORG_SLUG } from './paths.js';
import { renameRetry } from './fsretry.js';

// -- TYPES -- //

export type Connection = { server: string; org: string; name: string };

// -- FUNCTIONS -- //

const file = () => join(checksHome(), 'connections.json');

export function listConnections(): Connection[] {
	if (!existsSync(file())) return [];
	try {
		const v: unknown = JSON.parse(readFileSync(file(), 'utf8'));
		return Array.isArray(v)
			? v.filter(
					(c): c is Connection =>
						!!c &&
						typeof c.server === 'string' &&
						typeof c.org === 'string' &&
						ORG_SLUG.test(c.org) &&
						typeof c.name === 'string'
				)
			: [];
	} catch {
		return [];
	}
}

/** Adds or replaces the connection for a server and organisation. Written whole, never half. */
export function recordConnection(c: Connection): void {
	const next = [...listConnections().filter((x) => !(x.server === c.server && x.org === c.org)), c];
	ensureDir(checksHome());
	const tmp = `${file()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
	renameRetry(tmp, file());
}

export function forgetConnection(server: string, org: string): void {
	const next = listConnections().filter((x) => !(x.server === server && x.org === org));
	ensureDir(checksHome());
	const tmp = `${file()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
	renameRetry(tmp, file());
}
