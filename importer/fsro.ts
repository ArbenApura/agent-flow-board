// THE ONLY FILE SYSTEM DOOR OF THE IMPORTER: EVERYTHING HERE READS, NOTHING WRITES (SPEC 13, ADR-018)
// The importer touches the HAPR board's folder through these functions only, and this file imports only functions that read. A
// unit test reads the source of every importer file that touches the board and fails if a function that writes, moves, deletes
// or runs a command is named in it.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// -- TYPES -- //

export type Listed = { path: string; size: number; sha256: string };

// -- FUNCTIONS -- //

export const exists = (p: string) => existsSync(p);
export const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
/** Text with the byte order mark dropped and every line break written as a single LF, however the board's tool wrote it. */
export const readText = (p: string) =>
	readFileSync(p, 'utf8')
		.replace(/^\uFEFF/, '')
		.replace(/\r\n/g, '\n');
export const readBytes = (p: string) => readFileSync(p);
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
/** The names in a folder, sorted so every run sees the same order. */
export const names = (p: string) => readdirSync(p).sort((a, b) => a.localeCompare(b, 'en'));
/** A path with forward slashes whatever the system, relative to a root. */
export const rel = (root: string, p: string) => relative(root, p).split(sep).join('/');

/**
 * Every file under the given entries of a folder (all of it when none are given), depth first, with size and checksum. A folder
 * named .git is left out. Used before and after an import to show that nothing it read has changed.
 */
export function listing(root: string, only?: string[]): Listed[] {
	const out: Listed[] = [];
	const walk = (dir: string) => {
		for (const n of names(dir)) {
			if (n === '.git') continue;
			const p = join(dir, n);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else out.push({ path: rel(root, p), size: st.size, sha256: sha256(readFileSync(p)) });
		}
	};
	for (const n of only ?? names(root)) {
		const p = join(root, n);
		if (!existsSync(p)) continue;
		const st = statSync(p);
		if (st.isDirectory()) walk(p);
		else out.push({ path: rel(root, p), size: st.size, sha256: sha256(readFileSync(p)) });
	}
	return out;
}

/** One checksum of a whole listing, so two listings are compared with one value. */
export const listingHash = (l: Listed[]) =>
	sha256(l.map((f) => `${f.path}\t${f.size}\t${f.sha256}`).join('\n'));
