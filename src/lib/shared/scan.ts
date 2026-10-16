// FINDS A PROJECT SECRET INSIDE BYTES BEFORE THEY ARE STORED: LOGS, PICTURES, VIDEOS AND PLAYWRIGHT TRACES (SPEC 10, L2)
// The runner scans every artifact before it uploads one, and the server scans again before it stores one, so a secret that
// slipped into a trace is caught on both sides. A trace is a zip, so its entries are opened and scanned too. A secret is also
// looked for in the common ways a program writes a text: as it is, URL encoded, base64, and JSON escaped.

// -- DEP-MODULES -- //
import { inflateRawSync } from 'node:zlib';

// -- TYPES -- //

export type Needle = { label: string; value: string };

// -- CONSTANTS -- //

/** Secrets shorter than this are not scanned for: they would match ordinary text. Accounts are saved with 8 or more. */
export const MIN_SCANNED_LENGTH = 8;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const MAX_DEPTH = 3;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

// -- FUNCTIONS -- //

/** Every spelling of a secret the scan looks for. */
function spellings(value: string): Buffer[] {
	const out = new Set<string>([
		value,
		encodeURIComponent(value),
		JSON.stringify(value).slice(1, -1)
	]);
	const raw = Buffer.from(value, 'utf8');
	out.add(raw.toString('base64'));
	out.add(raw.toString('base64url'));
	out.add(raw.toString('hex'));
	return [...out].filter((s) => s.length >= MIN_SCANNED_LENGTH).map((s) => Buffer.from(s, 'utf8'));
}

/** Everything opened while scanning one file may not grow past this, so a small file cannot unpack into gigabytes. */
const TOTAL_BUDGET_BYTES = 512 * 1024 * 1024;
/** The label given to a file the scan could not open all the way. Such a file is refused, never treated as clean. */
export const UNCHECKABLE = 'an archive that could not be checked';

type Budget = { left: number; unchecked: boolean };

/** The entries of a zip file, opened. Returns null when the bytes are not a readable zip. */
function zipEntries(buf: Buffer, budget: Budget): Buffer[] | null {
	if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
		if (buf.readUInt32LE(i) === EOCD) {
			eocd = i;
			break;
		}
	if (eocd < 0) return null;
	const count = buf.readUInt16LE(eocd + 10);
	let at = buf.readUInt32LE(eocd + 16);
	const out: Buffer[] = [];
	for (let n = 0; n < count; n++) {
		if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) return out.length ? out : null;
		const method = buf.readUInt16LE(at + 10);
		const compressed = buf.readUInt32LE(at + 20);
		const size = buf.readUInt32LE(at + 24);
		const nameLen = buf.readUInt16LE(at + 28);
		const extraLen = buf.readUInt16LE(at + 30);
		const commentLen = buf.readUInt16LE(at + 32);
		const local = buf.readUInt32LE(at + 42);
		at += 46 + nameLen + extraLen + commentLen;
		if (local + 30 > buf.length) continue;
		// An entry too large to open, or packed a way this scan does not read, is not clean: the file is refused
		if (size > MAX_ENTRY_BYTES || (method !== 0 && method !== 8)) {
			budget.unchecked = true;
			continue;
		}
		const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
		const body = buf.subarray(dataAt, dataAt + compressed);
		try {
			const opened =
				method === 0
					? body
					: inflateRawSync(body, {
							maxOutputLength: Math.min(MAX_ENTRY_BYTES, Math.max(budget.left, 1))
						});
			budget.left -= opened.length;
			if (budget.left < 0) {
				budget.unchecked = true;
				break;
			}
			out.push(opened);
		} catch (e) {
			// Too big to open is refused. Anything else that cannot be opened is scanned as it is
			if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') budget.unchecked = true;
			else out.push(body);
		}
	}
	return out;
}

function scanBuffer(
	buf: Buffer,
	forms: { label: string; bytes: Buffer }[],
	depth: number,
	budget: Budget
): string | null {
	for (const f of forms) if (buf.includes(f.bytes)) return f.label;
	const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
	if (isZip && depth >= MAX_DEPTH) {
		// A zip inside zips deeper than this is not opened, so it cannot be vouched for
		budget.unchecked = true;
		return null;
	}
	if (depth < MAX_DEPTH) {
		const entries = zipEntries(buf, budget);
		if (entries)
			for (const e of entries) {
				const hit = scanBuffer(e, forms, depth + 1, budget);
				if (hit) return hit;
			}
	}
	return null;
}

/**
 * The label of the first secret found in the bytes, or null when none is. The label names the secret ("password of account
 * default"), never its value, so the answer is safe to log and to show.
 */
export function findSecret(bytes: Uint8Array | string, needles: Needle[]): string | null {
	const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
	const forms = needles
		.filter((n) => n.value.length >= MIN_SCANNED_LENGTH)
		.flatMap((n) => spellings(n.value).map((b) => ({ label: n.label, bytes: b })));
	if (!forms.length) return null;
	const budget: Budget = { left: TOTAL_BUDGET_BYTES, unchecked: false };
	const hit = scanBuffer(buf, forms, 0, budget);
	return hit ?? (budget.unchecked ? UNCHECKABLE : null);
}

/** Replaces every spelling of every secret in a text with a mask, for a log that is kept. */
export function maskSecrets(text: string, needles: Needle[]): string {
	let out = text;
	for (const n of needles) {
		if (n.value.length < MIN_SCANNED_LENGTH) continue;
		for (const s of spellings(n.value)) out = out.split(s.toString('utf8')).join('********');
	}
	return out;
}
