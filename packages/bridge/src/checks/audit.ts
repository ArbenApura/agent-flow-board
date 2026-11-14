// A HASH-CHAINED AUDIT LOG OF WHAT THE CHECK COMMANDS DID. Each line carries the MAC of the line before it (HMAC-SHA256 with a key that only this machine has),
// so an edited line or a cut shows. It is evidence, not prevention. Only short action words and plain numbers are logged: never a token, a password, a secret's
// path or a command text.

// IMPORTED DEP-MODULES
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// IMPORTED MODULES
import { withLockSync } from './lock.js';
import { auditFile, checksHome, ensureDir } from './paths.js';
import { renameRetry } from './fsretry.js';

// -- TYPES -- //

export type AuditDetail = Record<string, string | number | boolean>;
type Head = { lines: number; head: string };

// -- CONSTANTS -- //

const MAX_ACTION = 40;
const MAX_VALUE = 200;

// -- FUNCTIONS -- //

const keyFile = () => join(checksHome(), 'audit.key');
/** The head file keeps the MAC and the count of the last line, which is what shows a cut tail (the chain of the lines left is still true). */
const headFile = () => `${auditFile()}.head`;

/** The key, created once with mode 0600. It is written whole into a temporary file and linked into place, so another process never reads half of it. */
function homeKey(): Buffer {
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
	return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

const lineMac = (key: Buffer, prev: string, text: string) =>
	createHmac('sha256', Buffer.concat([Buffer.from('afb check audit:'), key]))
		.update(`${prev}\n${text}`)
		.digest('hex');

const readLines = () =>
	existsSync(auditFile()) ? readFileSync(auditFile(), 'utf8').split(/\r?\n/).filter(Boolean) : [];

function tail(lines: string[]): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const e: unknown = JSON.parse(lines[i] ?? '');
			if (e && typeof e === 'object' && typeof (e as { mac?: unknown }).mac === 'string')
				return (e as { mac: string }).mac;
		} catch {
			/* A damaged line is skipped, and verifyAudit reports it */
		}
	}
	return '';
}

function clean(detail: AuditDetail): AuditDetail {
	const out: AuditDetail = {};
	for (const [k, v] of Object.entries(detail)) {
		const name = k.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
		if (name) out[name] = typeof v === 'string' ? v.slice(0, MAX_VALUE) : v;
	}
	return out;
}

/** Adds one line to the chain. Reading the last line and appending the next one is one step under a lock, so two writers never fork the chain. */
export function appendAudit(action: string, detail: AuditDetail = {}): void {
	const key = homeKey();
	const word = action.replace(/[^A-Za-z0-9 _.:-]/g, '').slice(0, MAX_ACTION) || 'action';
	withLockSync('audit', () => {
		const lines = readLines();
		const prev = tail(lines);
		const text = JSON.stringify({
			at: new Date().toISOString(),
			action: word,
			detail: clean(detail),
			prev
		});
		const mac = lineMac(key, prev, text);
		appendFileSync(auditFile(), JSON.stringify({ ...(JSON.parse(text) as object), mac }) + '\n', {
			mode: 0o600
		});
		const head: Head = { lines: lines.length + 1, head: mac };
		const tmp = `${headFile()}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(head), { mode: 0o600 });
		renameRetry(tmp, headFile());
	});
}

function readHead(): Head | null {
	try {
		const v = JSON.parse(readFileSync(headFile(), 'utf8')) as Partial<Head>;
		return typeof v.lines === 'number' && typeof v.head === 'string'
			? { lines: v.lines, head: v.head }
			: null;
	} catch {
		return null;
	}
}

const same = (a: string, b: string) =>
	a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** True when every line holds the MAC of the line before it and the last line is the one the head file names (a cut tail shows there). */
export function verifyAudit(): { ok: boolean; lines: number; head: string } {
	const lines = readLines();
	const head = readHead();
	if (!lines.length) return { ok: head === null || head.lines === 0, lines: 0, head: '' };
	const key = homeKey();
	let prev = '';
	for (let i = 0; i < lines.length; i++) {
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(lines[i] ?? '') as Record<string, unknown>;
		} catch {
			return { ok: false, lines: lines.length, head: prev };
		}
		const { mac, ...rest } = e;
		if (typeof mac !== 'string' || e.prev !== prev)
			return { ok: false, lines: lines.length, head: prev };
		if (!same(lineMac(key, prev, JSON.stringify(rest)), mac))
			return { ok: false, lines: lines.length, head: prev };
		prev = mac;
	}
	// A cut tail, or a line added by hand after the last one, is not what the head file recorded
	const matches = head !== null && head.lines === lines.length && head.head === prev;
	return { ok: matches, lines: lines.length, head: prev };
}
