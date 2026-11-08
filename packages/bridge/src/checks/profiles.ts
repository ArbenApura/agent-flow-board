// SAVED SIGN-INS: ONE SEALED FILE PER REGISTRATION AND SITE
// A saved sign-in is the browser state (cookies and local storage) of a person signed in to one site. It is sealed with the bridge's key, bound
// to the registration and the site address (the AAD), and lives under that registration's own state folder. It is used only for the site it
// was saved for, and it never reaches a check except through the child's stdin.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { ensureDir, ORG_SLUG, stateDirFor } from './paths.js';
import { renameRetry } from './fsretry.js';
import { seal, unseal } from './store.js';

// -- TYPES -- //

/** What is sealed in a file. */
export type SavedProfile = {
	bindKey: string;
	savedAt: string;
	/** The browser state: cookies and origins. Never printed. */
	state: unknown;
};
/** What a listing shows: no cookie and no value, only which site and when. */
export type ProfileEntry = { file: string; bindKey: string; savedAt: string };

// -- CONSTANTS -- //

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const FILE = /^[0-9a-f]{16}\.enc$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

// -- FUNCTIONS -- //

function check(org: string, name: string): void {
	if (!ORG_SLUG.test(org)) throw new Error('The organisation is not a slug.');
	if (!NAME.test(name)) throw new Error('The registration name is not a plain name.');
}

const profilesDir = (org: string, name: string) => {
	check(org, name);
	return join(stateDirFor(org, name), 'profiles');
};
/** The file name for a site address: 16 hex characters of its hash. */
export const fileNameFor = (bindKey: string): string =>
	`${createHash('sha256').update(bindKey).digest('hex').slice(0, 16)}.enc`;
const aadFor = (org: string, name: string, bindKey: string) => `profile:${org}/${name}:${bindKey}`;

/** Saves (replaces) the sign-in of one registration and site. Returns the file name, not the path. */
export function saveProfile(org: string, name: string, bindKey: string, state: unknown): string {
	if (!bindKey) throw new Error('A saved sign-in needs the address of the site.');
	const dir = ensureDir(profilesDir(org, name));
	const file = fileNameFor(bindKey);
	const profile: SavedProfile = { bindKey, savedAt: new Date().toISOString(), state };
	const blob = seal(aadFor(org, name, bindKey), enc.encode(JSON.stringify(profile)));
	const tmp = join(dir, `${file}.${process.pid}.tmp`);
	writeFileSync(tmp, blob, { mode: 0o600 });
	renameRetry(tmp, join(dir, file));
	// The address is not a secret: a plain index lets a listing name the site without opening the sealed file
	writeFileSync(indexPath(org, name, file), JSON.stringify({ bindKey }), { mode: 0o600 });
	return file;
}

/** The saved sign-in for exactly this registration and site, or null (none, damaged, or saved for another address). */
export function loadProfile(org: string, name: string, bindKey: string): SavedProfile | null {
	return loadProfileChecked(org, name, bindKey).profile;
}

/** The same, and says when a file is there but cannot be opened (damaged, or sealed for another address), so a run does not go signed out without saying so. */
export function loadProfileChecked(
	org: string,
	name: string,
	bindKey: string
): { profile: SavedProfile | null; damaged: boolean } {
	const path = join(profilesDir(org, name), fileNameFor(bindKey));
	if (!existsSync(path)) return { profile: null, damaged: false };
	try {
		const raw = unseal(aadFor(org, name, bindKey), readFileSync(path));
		const p = JSON.parse(dec.decode(raw)) as SavedProfile;
		return p && p.bindKey === bindKey
			? { profile: p, damaged: false }
			: { profile: null, damaged: true };
	} catch {
		return { profile: null, damaged: true };
	}
}

/** A plain sentence when every timed cookie has run out, so a run can say so before it fails on a sign-in page. */
export function expiryNote(profile: SavedProfile | null): string | null {
	const cookies = (profile?.state as { cookies?: { expires?: number }[] } | null)?.cookies ?? [];
	const now = Date.now() / 1000;
	const timed = cookies.filter((c) => typeof c.expires === 'number' && c.expires > 0);
	return timed.length && timed.every((c) => (c.expires as number) < now)
		? 'The saved sign-in has expired.'
		: null;
}

/** Which sites have a saved sign-in: file, address and date, never a cookie or a value. The address is read from the plain index beside each file. */
export function listProfiles(org: string, name: string): ProfileEntry[] {
	const dir = profilesDir(org, name);
	if (!existsSync(dir)) return [];
	const out: ProfileEntry[] = [];
	for (const file of readdirSync(dir).filter((f) => FILE.test(f))) {
		let bindKey = '(unknown)';
		try {
			bindKey = String(
				(JSON.parse(readFileSync(indexPath(org, name, file), 'utf8')) as { bindKey?: string })
					.bindKey ?? bindKey
			);
		} catch {
			/* No index: the file is still listed */
		}
		out.push({ file, bindKey, savedAt: statSync(join(dir, file)).mtime.toISOString() });
	}
	return out;
}

const indexPath = (org: string, name: string, file: string) =>
	join(profilesDir(org, name), file + '.site');

/** Removes one saved sign-in by its exact file name. True when a file went. */
export function removeProfile(org: string, name: string, file: string): boolean {
	if (!FILE.test(file)) throw new Error('That is not a saved sign-in file name.');
	const dir = profilesDir(org, name);
	let removed = false;
	for (const f of [file, `${file}.site`]) {
		const p = join(dir, f);
		if (existsSync(p)) {
			rmSync(p, { force: true });
			removed ||= f === file;
		}
	}
	return removed;
}
