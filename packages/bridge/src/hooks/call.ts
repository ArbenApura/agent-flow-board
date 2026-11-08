// CALLING THE SERVER FROM A HOOK. A HOOK MUST BE QUICK AND MUST NEVER BREAK THE TOOL, SO EVERY FAILURE BECOMES AN EMPTY ANSWER.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetch } from '../device.js';
import { configDir } from '../tokenStore.js';
import { installedModVersion } from './modVersion.js';

// -- TYPES -- //

export type HookEvent = {
	tool: 'claude-code' | 'antigravity' | 'gemini';
	event: 'start' | 'prompt' | 'tool' | 'closing' | 'stop' | 'end';
	externalId: string;
	cwd?: string;
	subagent?: boolean;
	stopActive?: boolean;
	failed?: boolean;
	action?:
		| { kind: 'edit'; file: string }
		| { kind: 'shell'; command: string }
		| { kind: 'board'; name: string }
		| { kind: 'read' };
	closing?: { item: string; status: string }[];
	/** Asks the board to put the status of this conversation's session in the answer. */
	status?: boolean;
};
export type HookAnswer = {
	context?: string;
	title?: string;
	ask?: string;
	block?: string;
	/** Progress first: finished work is not recorded yet. Shown to the agent right after an edit, never blocks. */
	nudge?: string;
	/** The status of the conversation's session, only when the event asked for it. Written to the status file, never printed. */
	status?: unknown;
	/** A line for the person: a newer editor status mod is available. Claude Code shows it at the start of a conversation. */
	notice?: string;
};

// -- CONSTANTS -- //

const TIMEOUT_MS = 4000;

// -- FUNCTIONS -- //

/** The slug of the org the token belongs to, remembered in the bridge's folder so each hook costs one request. */
async function orgOf(server: string, token: string, fetchImpl: Fetch): Promise<string | null> {
	// Named by the token too, so signing in again as another organisation does not keep sending to the old one
	const who = createHash('sha256').update(token).digest('hex').slice(0, 12);
	const file = join(
		configDir(),
		`org-${new URL(server).host.replace(/[^A-Za-z0-9.-]/g, '_')}-${who}.txt`
	);
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
	const me = (await res.json()) as { orgs?: { slug: string }[] };
	const slug = me.orgs?.[0]?.slug ?? null;
	if (slug) {
		mkdirSync(configDir(), { recursive: true, mode: 0o700 });
		writeFileSync(file, slug, { mode: 0o600 });
	}
	return slug;
}

// -- STATES -- //

let warned = false;

// -- FUNCTIONS -- //

/** A hook still answers empty when it cannot reach the board, but says why once on stderr so the failure is not silent. */
function warnOnce(reason: string) {
	if (warned) return;
	warned = true;
	process.stderr.write(`agent-flow-board hook: ${reason}
`);
}

/** Sends one event and returns the answer, or null on any problem (no token, offline, a refusal, a slow server). */
export async function callHook(
	o: { server: string; token: string | null; fetch: Fetch; home?: string },
	event: HookEvent
): Promise<HookAnswer | null> {
	if (!o.token) {
		warnOnce(
			'no sign-in found, so no progress reminder or claim release will reach the board. Run: agent-flow-board login'
		);
		return null;
	}
	try {
		const org = await orgOf(o.server, o.token, o.fetch);
		if (!org) {
			warnOnce(`the server ${o.server} did not give an organisation for this sign-in.`);
			return null;
		}
		// A Claude Code start tells the board which editor status mod is installed, so it can say when a newer one is served
		const modVersion =
			event.tool === 'claude-code' && event.event === 'start'
				? installedModVersion(o.home)
				: undefined;
		const res = await o.fetch(`${o.server}/api/v1/orgs/${org}/hooks`, {
			method: 'POST',
			headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
			body: JSON.stringify(modVersion ? { ...event, modVersion } : event),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!res.ok) warnOnce(`the server answered ${res.status} to a hook event.`);
		return res.ok ? ((await res.json()) as HookAnswer) : null;
	} catch {
		warnOnce(
			`the server ${o.server} could not be reached, so the board is not told about this session.`
		);
		return null;
	}
}
