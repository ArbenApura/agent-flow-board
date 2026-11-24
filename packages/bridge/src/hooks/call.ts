// CALLING THE SERVER FROM A HOOK. A HOOK MUST BE QUICK AND MUST NEVER BREAK THE TOOL, SO EVERY FAILURE BECOMES AN EMPTY ANSWER.

// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetch } from '../device.js';
import { configDir } from '../tokenStore.js';
import { installedModVersion } from './modVersion.js';
import { purgeStatus, statusName } from './statusFile.js';

// -- TYPES -- //

export type HookEvent = {
	tool: 'claude-code' | 'antigravity' | 'gemini' | 'codex';
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
	/** Waiting-for-a-person blocker shown cleanly on stop instead of blocking or telling the agent to carry on. */
	waiting?: string;
	/** Progress first: finished work is not recorded yet. Shown to the agent right after an edit, never blocks. */
	nudge?: string;
	/** The status of the conversation's session, only when the event asked for it. Written to the status file, never printed. */
	status?: unknown;
	/** A line for the person: a newer editor status mod is available. Claude Code shows it at the start of a conversation. */
	notice?: string;
	/** Set by the bridge itself, never by the server: the board could not be reached earlier in this conversation. Shown once. */
	outage?: string;
};

// -- CONSTANTS -- //

const TIMEOUT_MS = 4000;
/** The whole budget of an end event (the organisation lookup and the post), inside the 3 seconds Codex allows a SessionEnd hook. */
const END_TIMEOUT_MS = 2000;

// -- FUNCTIONS -- //

/** An outage older than this is not worth a line any more. */
const OUTAGE_FRESH_MS = 6 * 60 * 60 * 1000;
const OUTAGE_DIR = 'outage';

/** Remembers, for this conversation only, that the board could not be reached. Only a fixed code and the host are kept, never the address. */
function noteOutage(server: string, event: HookEvent, reason: string) {
	try {
		// A conversation that is ending has no later answer to carry the line
		if (event.event === 'end') return;
		const name = statusName(event.externalId);
		if (!name) return;
		const dir = join(configDir(), OUTAGE_DIR);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const temp = join(dir, `${name}.${process.pid}.tmp`);
		writeFileSync(temp, JSON.stringify({ reason, host: new URL(server).host, at: Date.now() }), {
			mode: 0o600
		});
		renameSync(temp, join(dir, `${name}.json`));
	} catch {
		/* A note that cannot be written never fails a hook */
	}
}

/** The one line for an earlier outage of this conversation, taken (renamed away) so it is shown once, or null. */
function takeOutage(event: HookEvent): string | null {
	try {
		const name = statusName(event.externalId);
		if (!name) return null;
		const dir = join(configDir(), OUTAGE_DIR);
		const file = join(dir, `${name}.json`);
		const taken = join(dir, `${name}.${process.pid}.taken`);
		renameSync(file, taken);
		const note = JSON.parse(readFileSync(taken, 'utf8')) as {
			reason?: string;
			host?: string;
			at?: number;
		};
		rmSync(taken, { force: true });
		if (typeof note.at !== 'number' || Date.now() - note.at > OUTAGE_FRESH_MS) return null;
		const reason = /^[a-z0-9-]{1,24}$/.test(note.reason ?? '') ? note.reason : 'unreachable';
		const host = /^[A-Za-z0-9.:-]{1,100}$/.test(note.host ?? '') ? note.host : 'the board';
		return `Agent Flow Board could not be reached earlier in this conversation (${host}, ${reason}), so some progress may not have been reported.`;
	} catch {
		return null;
	}
}

/** The slug of the org the token belongs to, remembered in the bridge's folder so each hook costs one request. */
async function orgOf(
	server: string,
	token: string,
	fetchImpl: Fetch,
	deadline: AbortSignal | null
): Promise<string | null> {
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
		signal: deadline ?? AbortSignal.timeout(TIMEOUT_MS)
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
		// The end of a conversation has one short deadline for the organisation lookup and the post together: Codex gives that hook
		// 1 to 3 seconds in all, and kills it after that
		const deadline = event.event === 'end' ? AbortSignal.timeout(END_TIMEOUT_MS) : null;
		const org = await orgOf(o.server, o.token, o.fetch, deadline);
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
			signal: deadline ?? AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!res.ok) {
			warnOnce(`the server answered ${res.status} to a hook event.`);
			noteOutage(o.server, event, `status-${Math.trunc(res.status)}`);
			return null;
		}
		const answer = (await res.json()) as HookAnswer;
		// The board is back: say once that it was not, in the answer this event's output carries
		// Taken only where the output can show it: Claude Code at a start, a prompt or a tool call (a closing check, a stop that waits or
		// blocks and the other tools' adapters would drop it), so the line is never consumed unseen
		if (event.event === 'start') purgeStatus(join(configDir(), OUTAGE_DIR));
		const shown = event.tool === 'claude-code' && ['start', 'prompt', 'tool'].includes(event.event);
		const outage = shown ? takeOutage(event) : null;
		return outage ? { ...answer, outage } : answer;
	} catch {
		warnOnce(
			`the server ${o.server} could not be reached, so the board is not told about this session.`
		);
		noteOutage(o.server, event, 'unreachable');
		return null;
	}
}
