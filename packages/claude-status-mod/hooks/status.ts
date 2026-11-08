// THE PURE PART OF THE MOD: HOW AN ANSWER OF THE BOARD BECOMES A VIEW, AND HOW A VIEW BECOMES ONE LINE.
// No call on `$` lives here, so it can be tested without an engine. Everything the board sends is untrusted text.

import type { Item, View } from '../types';

// -- CONSTANTS -- //

export const POLL_MS = 60_000;
export const MAX_BACKOFF_MS = 600_000;
/** An answer older than this many polls is drawn as old, never as current. */
export const STALE_MS = POLL_MS * 3;
export const NOTE_SHOWN = 280;
export const TEXT_SHOWN = 80;
export const SHAPE = 'view-1';

export const INITIAL: View = {
	kind: 'loading',
	item: null,
	etag: null,
	goodAt: 0,
	nextAt: 0,
	failures: 0,
	isExpanded: false
};

// -- TYPES -- //

/** What a call to the board came to: a status and its parsed body, or nothing at all. */
export type Outcome = { status: number; body: unknown } | { failed: true };

export type Line = {
	tone: 'ok' | 'stale' | 'info' | 'error';
	/** The item, when the line shows one. */
	item: Item | null;
	/** A short tag such as "Old answer, 6 min ago" or "Not found". */
	tag: string | null;
	/** The plain message of a state without an item. */
	message: string | null;
	/** A state that the person fixes in the mod settings. */
	isSettings: boolean;
};

// -- FUNCTIONS -- //

/** Text from the board as one plain line: no control characters, no line breaks, cut with an ellipsis. Never Markdown. */
export function plain(value: unknown, limit = TEXT_SHOWN): string {
	const text = typeof value === 'string' ? value : '';
	// A control character (below a space, or delete) becomes a space, so no line break or escape can reach the line
	const spaced = Array.from(text, (c) =>
		c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c
	).join('');
	const clean = spaced.replace(/\s+/g, ' ').trim();
	return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean;
}

const num = (v: unknown, fallback = 0) =>
	typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const record = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Reads the item of an answer, or null when it is missing or has no reference. Every text is cleaned here. */
export function readItem(raw: unknown): Item | null {
	const o = record(raw);
	if (!o || typeof o.ref !== 'string' || !o.ref) return null;
	const phase = record(o.phase);
	const steps = record(o.steps);
	const url = typeof o.url === 'string' && /^https?:\/\//.test(o.url) ? o.url.slice(0, 2000) : null;
	return {
		ref: plain(o.ref, 40),
		title: plain(o.title),
		tabName: o.tabName === null || o.tabName === undefined ? null : plain(o.tabName, 40) || null,
		status: plain(o.status, 20),
		percent: Math.min(100, Math.max(0, Math.round(num(o.percent)))),
		phase: phase
			? {
					key: plain(phase.key, 12),
					title: plain(phase.title, 40),
					position: num(phase.position),
					of: num(phase.of)
				}
			: null,
		steps: {
			done: num(steps?.done),
			open: num(steps?.open),
			waived: num(steps?.waived),
			total: num(steps?.total)
		},
		manualChecksOpen: num(o.manualChecksOpen),
		resumeHere: plain(o.resumeHere, NOTE_SHOWN),
		blockers: plain(o.blockers, NOTE_SHOWN),
		url
	};
}

/** The wait before the next ask: one poll, doubled for every failure in a row, never past ten minutes. */
export const waitAfter = (failures: number) =>
	Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.max(0, failures));

/** The view after a call to the board. A failure that is not the board's being away drops the old item. */
export function nextView(prev: View, outcome: Outcome, now: number): View {
	if ('failed' in outcome) return down(prev, now);
	const { status, body } = outcome;
	if (status === 401 || status === 403)
		return { ...prev, kind: 'token', item: null, etag: null, failures: 0, nextAt: now + POLL_MS };
	if (status === 404) {
		// A new conversation's hook session appears a moment after its first prompt, so ask again soon: 15, 30, then 60 seconds
		const failures = prev.kind === 'notfound' ? prev.failures + 1 : 1;
		return {
			...prev,
			kind: 'notfound',
			item: null,
			etag: null,
			failures,
			nextAt: now + Math.min(POLL_MS, 15_000 * 2 ** (failures - 1))
		};
	}
	const o = record(body);
	if (status !== 200 || !o) return down(prev, now);
	if (o.unchanged === true && (prev.kind === 'ok' || prev.kind === 'none'))
		return { ...prev, goodAt: now, failures: 0, nextAt: now + POLL_MS };
	const etag = typeof o.etag === 'string' ? o.etag.slice(0, 80) : null;
	const item = readItem(o.item);
	// An item the answer holds but this mod cannot read is a board that talks in a way we do not know: treat it as away
	if (o.item !== null && o.item !== undefined && !item) return down(prev, now);
	return {
		...prev,
		kind: item ? 'ok' : 'none',
		item,
		etag,
		goodAt: now,
		failures: 0,
		nextAt: now + POLL_MS
	};
}

function down(prev: View, now: number): View {
	const failures = prev.failures + 1;
	return { ...prev, kind: 'down', failures, nextAt: now + waitAfter(failures) };
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * Whether there is nothing worth showing: no answer yet, no item claimed, no board session for the conversation, or a board that
 * cannot be reached with no item to show. The line then stays out of the way. A missing setting, a bad token, or an item (even an
 * old one) is shown, because the person has to see it.
 */
export function isQuiet(view: View): boolean {
	switch (view.kind) {
		case 'loading':
		case 'none':
		case 'notfound':
			return true;
		case 'down':
			return !view.item;
		default:
			return false;
	}
}

/** What the band says for a view at a time: the item, a tag, or a plain message. */
export function lineOf(view: View, now: number): Line {
	const age = now - view.goodAt;
	switch (view.kind) {
		case 'setup':
			return {
				tone: 'error',
				item: null,
				tag: 'Settings',
				isSettings: true,
				message: 'Set the board address, organisation and token in the mod settings.'
			};
		case 'loading':
			return {
				tone: 'info',
				item: null,
				tag: null,
				isSettings: false,
				message: 'Checking the board…'
			};
		case 'none':
			return {
				tone: 'info',
				item: null,
				tag: null,
				isSettings: false,
				message: 'No item claimed in this conversation.'
			};
		case 'notfound':
			return {
				tone: 'error',
				item: null,
				tag: 'Not found',
				isSettings: true,
				message:
					'Nothing on the board for this conversation. Check the organisation name in the mod settings, or that the hooks send to the same organisation.'
			};
		case 'token':
			return {
				tone: 'error',
				item: null,
				tag: 'Token',
				isSettings: true,
				message:
					'The token has expired, been removed or may not read. Make a new read token on the board and paste it in the mod settings.'
			};
		case 'down':
			if (view.item)
				return {
					tone: 'stale',
					item: view.item,
					tag: `Board unreachable, old answer ${minutes(age)} min ago`,
					message: null,
					isSettings: false
				};
			return {
				tone: 'error',
				item: null,
				tag: 'Offline',
				isSettings: false,
				message: 'The board cannot be reached. Trying again in a minute.'
			};
		case 'ok':
		default:
			if (age > STALE_MS)
				return {
					tone: 'stale',
					item: view.item,
					tag: `Old answer, ${minutes(age)} min ago`,
					message: null,
					isSettings: false
				};
			return { tone: 'ok', item: view.item, tag: null, message: null, isSettings: false };
	}
}

export type OrgPair = { org: string; token: string };

/** The organisation a repo's hook commands send to (--org <slug>), read from its Claude settings text. */
export const hookOrgOf = (text: string): string | null =>
	/--org\s+([a-z0-9][a-z0-9-]*)/.exec(text)?.[1] ?? null;

/**
 * Which organisation and token to ask with. The conversation lives in the organisation its repo's hooks send to, so that one
 * is used; with no hook organisation to go by, the first complete pair is. A hook organisation with no pair is a missing setting.
 */
export function pickOrg(pairs: OrgPair[], hookOrg: string | null): OrgPair | null {
	const usable = pairs.filter((p) => p.org && p.token);
	if (hookOrg) return usable.find((p) => p.org === hookOrg) ?? null;
	return usable[0] ?? null;
}

/** The address of the lookup. The conversation id and the etag are encoded; no token and no session header go with it. */
export function lookupUrl(
	server: string,
	org: string,
	conversationId: string,
	etag: string | null
) {
	const base = server.replace(/\/+$/, '');
	const query = `tool=claude-code${etag ? `&etag=${encodeURIComponent(etag)}` : ''}`;
	return `${base}/api/v1/orgs/${encodeURIComponent(org)}/sessions/by-external/${encodeURIComponent(conversationId)}?${query}`;
}

// -- THE STATUS FILE (AFB-20261108-0427) -- //

/** How often the mod looks at its conversation's status file. A local read, so it is cheap. */
export const FILE_POLL_MS = 5_000;
/** An unchanged file renews the time of the answer this often, well inside the three minutes after which an answer is drawn as old. */
export const FILE_RENEW_MS = 30_000;
/**
 * A file this old is not trusted: its hook answers stopped coming (a crash, a board that could not be reached). It falls back to the
 * token lookup. The file is only ever read by the conversation it belongs to, so a long quiet turn is far below this.
 */
export const FILE_STALE_MS = 12 * 60 * 60 * 1000;
/** A file written in the future by more than this is a clock that is wrong, not a fresh file. */
const FILE_SKEW_MS = 5 * 60 * 1000;

/** The file name of a conversation. The same rule as the bridge: a plain id only, never a path. */
export const statusName = (conversationId: string): string | null =>
	/^[A-Za-z0-9_-][A-Za-z0-9._-]{7,99}$/.test(conversationId) ? conversationId : null;

/**
 * Where the bridge keeps this conversation's file, in the order to look: the bridge's own folder when AFB_BRIDGE_HOME names one,
 * then the home folder (USERPROFILE on Windows, HOME elsewhere). Empty when the id is not a plain name.
 */
export function statusPaths(
	env: { bridgeHome?: string; userProfile?: string; home?: string },
	conversationId: string
): string[] {
	const name = statusName(conversationId);
	if (!name) return [];
	const roots = [
		env.bridgeHome,
		env.userProfile && `${env.userProfile}/.agent-flow-board`,
		env.home && `${env.home}/.agent-flow-board`
	].filter((r): r is string => !!r && r.length > 0);
	return [...new Set(roots.map((r) => `${r.replace(/[\\/]+$/, '')}/status/${name}.json`))];
}

/**
 * The status the bridge wrote for this conversation, or null when the text is not a good file: not JSON, another shape, another
 * conversation, too old, from the future, or with an item this mod cannot read. Null means "ask the board the old way".
 */
export function readStatusFile(text: string, conversationId: string, now: number): unknown | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const file = record(parsed);
	if (!file || file.v !== 1 || typeof file.writtenAt !== 'number') return null;
	const age = now - file.writtenAt;
	if (!Number.isFinite(age) || age > FILE_STALE_MS || age < -FILE_SKEW_MS) return null;
	const status = record(file.status);
	if (!status || status.externalId !== conversationId) return null;
	if (status.item !== null && !readItem(status.item)) return null;
	return status;
}
