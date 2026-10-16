// CALLING THE SERVER FROM A HOOK. A HOOK MUST BE QUICK AND MUST NEVER BREAK THE TOOL, SO EVERY FAILURE BECOMES AN EMPTY ANSWER.
// -- DEP-MODULES -- //
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../tokenStore.js';
// -- CONSTANTS -- //
const TIMEOUT_MS = 4000;
// -- FUNCTIONS -- //
/** The slug of the org the token belongs to, remembered in the bridge's folder so each hook costs one request. */
async function orgOf(server, token, fetchImpl) {
	const file = join(configDir(), `org-${new URL(server).host.replace(/[^A-Za-z0-9.-]/g, '_')}.txt`);
	try {
		const cached = readFileSync(file, 'utf8').trim();
		if (cached) return cached;
	} catch {
		/* Not remembered yet */
	}
	const res = await fetchImpl(`${server}/api/v1/me`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	if (!res.ok) return null;
	const me = await res.json();
	const slug = me.orgs?.[0]?.slug ?? null;
	if (slug) {
		mkdirSync(configDir(), { recursive: true, mode: 0o700 });
		writeFileSync(file, slug, { mode: 0o600 });
	}
	return slug;
}
/** Sends one event and returns the answer, or null on any problem (no token, offline, a refusal, a slow server). */
export async function callHook(o, event) {
	if (!o.token) return null;
	try {
		const org = await orgOf(o.server, o.token, o.fetch);
		if (!org) return null;
		const res = await o.fetch(`${o.server}/api/v1/orgs/${org}/hooks`, {
			method: 'POST',
			headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}
