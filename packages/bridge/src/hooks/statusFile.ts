// THE STATUS FILE OF A CONVERSATION: WHAT THE BOARD SAYS IT WORKS ON, KEPT BESIDE THE BRIDGE FOR AN EDITOR STATUS LINE.
// The hook answer carries the status when the bridge asks for it. The bridge writes it to <config dir>/status/<conversation id>.json
// so the editor mod reads a local file and needs no token. The file holds the status fields only, never a token or a verifier.
// A hook must never fail or slow down because of this file, so every function here swallows its errors.

// IMPORTED DEP-MODULES
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { HookAnswer, HookEvent } from './call.js';

// -- CONSTANTS -- //

/** Files older than this are removed when a conversation starts. */
export const PURGE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
const ENDED = '.ended';
const TEMP = '.tmp';
/** A rename over a file another process holds can fail for a moment on Windows (antivirus, a parallel hook). */
const RENAME_TRIES = 4;

// -- FUNCTIONS -- //

/**
 * The file name of a conversation, or null when its id is not plain. An id comes from a tool's payload, so it is never used as a
 * path unless it is made only of letters, digits, dots, dashes and underscores and does not start with a dot.
 */
export function statusName(externalId: string): string | null {
	return /^[A-Za-z0-9_-][A-Za-z0-9._-]{7,99}$/.test(externalId) ? externalId : null;
}

/** Waits a few milliseconds without spinning, for the retry of a rename. */
function pause(ms: number) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		/* No wait available: the retry runs at once */
	}
}

function writeAtomic(dir: string, name: string, body: string) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `${name}.${process.pid}${TEMP}`);
	writeFileSync(temp, body, { mode: 0o600 });
	for (let i = 0; i < RENAME_TRIES; i++) {
		try {
			renameSync(temp, join(dir, `${name}.json`));
			return;
		} catch (error) {
			if (i === RENAME_TRIES - 1) {
				rmSync(temp, { force: true });
				throw error;
			}
			pause(15 * (i + 1));
		}
	}
}

/** The time the file in place was asked for, or 0 when there is none or it cannot be read. */
function askedAtOf(dir: string, name: string): number {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as {
			asOf?: unknown;
		};
		return typeof parsed.asOf === 'number' ? parsed.asOf : 0;
	} catch {
		return 0;
	}
}

/** Removes the files nobody asked for in two days: finished conversations, crashed ones and leftovers of a failed write. */
export function purgeStatus(dir: string, now = Date.now()) {
	try {
		for (const file of readdirSync(dir)) {
			const path = join(dir, file);
			try {
				if (now - statSync(path).mtimeMs > PURGE_AFTER_MS) rmSync(path, { force: true });
			} catch {
				/* A file that vanished meanwhile is gone, which is the point */
			}
		}
	} catch {
		/* No folder yet */
	}
}

/**
 * Applies one hook event to the files. `asked` is the time the request left, so two answers that come back in the wrong order never
 * replace a newer file with an older one. It never throws and never prints.
 */
export function applyStatusFile(
	dir: string,
	event: HookEvent,
	answer: HookAnswer | null,
	asked: number,
	now = Date.now()
) {
	try {
		const name = statusName(event.externalId);
		if (!name) return;
		if (event.event === 'end') {
			// A last hook of the same conversation may still be on its way: the marker keeps it from writing the file again
			rmSync(join(dir, `${name}.json`), { force: true });
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(join(dir, `${name}${ENDED}`), String(now), { mode: 0o600 });
			return;
		}
		if (event.event === 'start') {
			// A resumed conversation starts again under the same id
			rmSync(join(dir, `${name}${ENDED}`), { force: true });
			purgeStatus(dir, now);
		}
		if (!event.status) return;
		if (existsSync(join(dir, `${name}${ENDED}`))) return;
		if (!answer?.status) {
			// The board did not answer a call that may have changed the claim: an old file would show a wrong item
			if (event.event === 'tool') rmSync(join(dir, `${name}.json`), { force: true });
			return;
		}
		if (askedAtOf(dir, name) > asked) return;
		writeAtomic(
			dir,
			name,
			JSON.stringify({ v: 1, asOf: asked, writtenAt: now, status: answer.status })
		);
	} catch {
		/* A failed write is never a failed hook */
	}
}
