// RETRIES FOR A FILE ANOTHER PROCESS HOLDS FOR A MOMENT (WINDOWS ANTIVIRUS, INDEXERS, A RENAME IN PROGRESS): EPERM, EBUSY AND EACCES ARE TRIED AGAIN.
// Every atomic rename of this folder goes through here, so no module keeps a copy of the loop.

// -- DEP-MODULES -- //
import { renameSync } from 'node:fs';

// -- CONSTANTS -- //

/** Errors that mean "another process has the file right now". */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Waits between tries, growing: about 2.4 seconds in all. */
export const RETRY_WAITS_MS = [10, 20, 40, 80, 120, 160, 240, 320, 400, 500, 600];

// -- FUNCTIONS -- //

const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` and tries it again while it fails with a busy-file error. Any other error is thrown at once. */
export function withRetry<T>(fn: () => T, waits: number[] = RETRY_WAITS_MS): T {
	for (let i = 0; ; i++) {
		try {
			return fn();
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (!code || !BUSY_CODES.has(code) || i >= waits.length) throw e;
			nap(waits[i]);
		}
	}
}

/** An atomic rename that waits out a busy file. `rename` is replaceable so a test can simulate the errors Windows gives. */
export function renameRetry(
	from: string,
	to: string,
	rename: (from: string, to: string) => void = renameSync
): void {
	withRetry(() => rename(from, to));
}
