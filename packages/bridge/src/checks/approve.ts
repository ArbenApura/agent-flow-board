// THE OWNER APPROVAL CHANNEL. An agent can ask for things the owner must decide (register a live site, adopt a repo .env, widen the roots, upload pictures of a
// signed-in run, import secrets). The owner runs `check approve --action <x> --target <name>` on an interactive terminal and gets a single-use code that is valid for
// 10 minutes for that one action and target. The code is stored hashed (HMAC with a key in the bridge home), so the file never holds a usable code. An agent cannot
// make a code: minting needs a terminal. This is tamper-evident, not tamper-proof: a process that runs as the same user can read the key.

// -- DEP-MODULES -- //
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// -- MODULES -- //
import { appendAudit } from './audit.js';
import { withLockSync } from './lock.js';
import { approvalsFile, checksHome, ensureDir } from './paths.js';
import { renameRetry } from './fsretry.js';

// -- TYPES -- //

export type ApprovalAction = 'register' | 'secrets' | 'adopt-env' | 'roots' | 'pictures' | 'login';
/** Who decided a code that came from the board. The local audit line records it, but this file is user-writable: the board's own history is the authoritative audit. */
export type DecisionNote = { by: string; at: string };
type Entry = {
	h: string;
	action: ApprovalAction;
	target: string;
	exp: number;
	note?: DecisionNote;
};
/** A board decision after the bridge claimed it (once, atomically, on the board). Only claimBoardDecisions makes one. */
export type ClaimedDecision = {
	readonly id: string;
	readonly action: string;
	readonly target: string;
	readonly decidedBy: string;
	readonly decidedAt: string;
};

// -- CONSTANTS -- //

export const APPROVAL_ACTIONS: readonly ApprovalAction[] = [
	'register',
	'secrets',
	'adopt-env',
	'roots',
	'pictures',
	'login'
];
/** A code is valid for ten minutes. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
/** The most codes the file holds: the board's batch cap, so a whole batch is valid at once. */
const MAX_CODES = 20;
/** The decisions this module's own claim function returned. A decision that is not in here is never minted into a code. */
const claimedDecisions = new WeakSet<object>();
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

// -- FUNCTIONS -- //

/** A refusal the owner or the agent can read: one plain sentence. The command handlers turn it into exit code 1. */
export class Refusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Refusal';
	}
}

/** A mistake in how a command was typed (exit code 2). */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

export const isApprovalAction = (v: string): v is ApprovalAction =>
	(APPROVAL_ACTIONS as readonly string[]).includes(v);

/** Writes a temporary file in the same folder and renames it over the real one, so a reader never sees half a file. */
export function writeFileAtomic(file: string, text: string): void {
	ensureDir(dirname(file));
	const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	try {
		writeFileSync(temp, text, { mode: 0o600 });
		renameRetry(temp, file);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}
}

const keyFile = () => join(checksHome(), 'approval.key');

/** The HMAC key of the approvals, the sealed roots and the registration files. Created once, whole, with mode 0600 (linked into place so nobody reads half of it). */
export function approvalKey(): Buffer {
	ensureDir(checksHome());
	const file = keyFile();
	if (!existsSync(file)) {
		const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
		writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
		try {
			linkSync(tmp, file);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
		} finally {
			rmSync(tmp, { force: true });
		}
	}
	const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
	if (key.length !== 32)
		throw new Error('The approval key file is damaged. Remove it and approve again.');
	return key;
}

/** HMAC-SHA256 hex of a text under the approval key, with a purpose word so one seal can never stand for another. */
export function seal(purpose: string, text: string): string {
	return createHmac('sha256', approvalKey()).update(`${purpose}\0${text}`).digest('hex');
}

/** True when two hex strings are equal, compared in constant time. */
export function sameMac(a: string, b: string): boolean {
	return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The target as it is compared: a name is lower cased, a folder (the `roots` action) is its real path when it exists, else its resolved path, lower cased on Windows.
 * The owner and the agent may therefore write the same target in different spellings.
 */
export function normaliseTarget(action: ApprovalAction, target: string): string {
	const text = String(target ?? '').trim();
	if (!text || text.length > 400)
		throw new Refusal('An approval needs a target (a name or a folder).');
	if (action !== 'roots') return text.toLowerCase();
	let full = resolve(text);
	try {
		full = realpathSync.native(full);
	} catch {
		/* A folder that is gone is compared by the path as written */
	}
	return process.platform === 'win32' ? full.toLowerCase() : full;
}

function normaliseCode(code: string): string | null {
	const text = String(code ?? '')
		.toUpperCase()
		.replace(/[\s-]/g, '');
	return new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`).test(text) ? text : null;
}

const macOf = (action: ApprovalAction, target: string, code: string) =>
	seal('approval', `${action}\0${target}\0${code}`);

function readEntries(): Entry[] {
	try {
		const v: unknown = JSON.parse(readFileSync(approvalsFile(), 'utf8'));
		const list = v && typeof v === 'object' ? (v as { codes?: unknown }).codes : null;
		if (!Array.isArray(list)) return [];
		const out: Entry[] = [];
		for (const e of list) {
			if (!e || typeof e !== 'object') continue;
			const { h, action, target, exp, note } = e as Record<string, unknown>;
			if (
				typeof h === 'string' &&
				typeof action === 'string' &&
				isApprovalAction(action) &&
				typeof target === 'string' &&
				typeof exp === 'number'
			) {
				const n = note as Partial<DecisionNote> | undefined;
				out.push({
					h,
					action,
					target,
					exp,
					...(n && typeof n.by === 'string' && typeof n.at === 'string'
						? { note: { by: n.by.slice(0, 80), at: n.at.slice(0, 40) } }
						: {})
				});
			}
		}
		return out;
	} catch {
		return [];
	}
}

const writeEntries = (codes: Entry[]) =>
	writeFileAtomic(approvalsFile(), JSON.stringify({ version: 1, codes }, null, 2) + '\n');

/**
 * Makes a single-use code for one action and target. Needs an interactive terminal: `isTTY` is passed in by the caller (the command passes the real flag, a test
 * passes true or false), and without it nothing is made. An older code for the same action and target is replaced.
 */
export function mintApproval(
	action: string,
	target: string,
	opts: { isTTY: boolean; now?: number }
): { code: string; expiresAt: string } {
	if (!opts.isTTY)
		throw new Refusal(
			'An approval code is made by the owner on an interactive terminal. This is not one, so no code was made.'
		);
	return mintCode(action, target, opts.now);
}

/**
 * Makes a code from a board decision that this module's claim function returned. This is the only way besides a terminal: a decision that was not claimed through the
 * board (a made-up object, a flag, a file) is refused. The code is for the decision's own action and target, and nothing else.
 */
export function mintFromDecision(
	claim: ClaimedDecision,
	opts: { now?: number } = {}
): { code: string; expiresAt: string } {
	if (!claimedDecisions.has(claim))
		throw new Refusal(
			'An approval code is made from a decision the board gave, and this is not one.'
		);
	return mintCode(claim.action, claim.target, opts.now, {
		by: claim.decidedBy,
		at: claim.decidedAt
	});
}

/** The board calls a bridge makes for an approval: the claim, and nothing else, so tests inject a fake board. */
export type ApprovalClaimer = {
	claimApprovals(ids: string[]): Promise<ClaimedDecision[]>;
};

/** Claims the named approved decisions on the board (once) and marks what came back as claimed. A decision the board did not return is not here. */
export async function claimBoardDecisions(
	board: ApprovalClaimer,
	ids: string[]
): Promise<ClaimedDecision[]> {
	const got = await board.claimApprovals(ids);
	const out = got.map((d) => ({ ...d }));
	for (const d of out) claimedDecisions.add(d);
	return out;
}

/** The sentence for the owner's word when a code came from the board, or null when it came from a terminal. */
export function boardSentence(note: DecisionNote | undefined): string | null {
	return note ? `Approved by ${note.by} on the board at ${note.at}.` : null;
}

function mintCode(
	action: string,
	target: string,
	nowMs?: number,
	note?: DecisionNote
): { code: string; expiresAt: string } {
	const opts = { now: nowMs };
	if (!isApprovalAction(action))
		throw new Refusal(
			`"${action.slice(0, 30)}" is not an action (${APPROVAL_ACTIONS.join(', ')}).`
		);
	const now = opts.now ?? Date.now();
	const norm = normaliseTarget(action, target);
	let code = '';
	for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
	const exp = now + APPROVAL_TTL_MS;
	withLockSync('approvals', () => {
		const kept = readEntries().filter(
			(e) => e.exp > now && !(e.action === action && e.target === norm)
		);
		kept.push({
			h: macOf(action, norm, code),
			action,
			target: norm,
			exp,
			...(note ? { note } : {})
		});
		writeEntries(kept.slice(-MAX_CODES));
	});
	appendAudit('approval minted', {
		action,
		target: norm,
		minutes: APPROVAL_TTL_MS / 60000,
		...(note ? { decided_via: 'board', decided_by: note.by } : {})
	});
	return {
		code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`,
		expiresAt: new Date(exp).toISOString()
	};
}

/**
 * True when the code is valid for this action and target right now, without using it. A command with several codes checks all of them with this first and uses them
 * (consumeApproval) last, so a wrong code never burns the right ones.
 */
export function peekApproval(
	action: string,
	target: string,
	code: string,
	now: number = Date.now()
): boolean {
	if (!isApprovalAction(action)) return false;
	const plain = normaliseCode(code);
	if (!plain) return false;
	let norm: string;
	try {
		norm = normaliseTarget(action, target);
	} catch {
		return false;
	}
	const want = macOf(action, norm, plain);
	return readEntries().some((e) => e.exp > now && e.action === action && sameMac(e.h, want));
}

/** True once for a valid code of this action and target, and false for a wrong action, a wrong target, an expired, a used or an unknown code. */
export function consumeApproval(
	action: string,
	target: string,
	code: string,
	now: number = Date.now()
): boolean {
	return consumeApprovalNote(action, target, code, now).ok;
}

/** Like consumeApproval, and says who decided when the code came from the board (for the owner sentence and the audit line). */
export function consumeApprovalNote(
	action: string,
	target: string,
	code: string,
	now: number = Date.now()
): { ok: boolean; note?: DecisionNote } {
	if (!isApprovalAction(action)) return { ok: false };
	const plain = normaliseCode(code);
	if (!plain) return { ok: false };
	let norm: string;
	try {
		norm = normaliseTarget(action, target);
	} catch {
		return { ok: false };
	}
	const want = macOf(action, norm, plain);
	let found: Entry | undefined;
	withLockSync('approvals', () => {
		const all = readEntries();
		const live = all.filter((e) => e.exp > now);
		found = live.find((e) => e.action === action && sameMac(e.h, want));
		const rest = found ? live.filter((e) => e !== found) : live;
		if (found || rest.length !== all.length) writeEntries(rest);
	});
	const hit = found as Entry | undefined;
	if (hit)
		appendAudit('approved with code', {
			action,
			target: norm,
			...(hit.note ? { decided_via: 'board', decided_by: hit.note.by } : {})
		});
	return hit ? { ok: true, ...(hit.note ? { note: hit.note } : {}) } : { ok: false };
}
