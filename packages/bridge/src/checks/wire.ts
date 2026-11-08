// WHAT THE BOARD IS TOLD ABOUT THE REGISTRATIONS. Every call carries the header x-afb-tool-registrations: a base64url JSON list of {p: board project, n: NAME, r: folder name, b: branch}, at most 16,
// only this organisation's, refreshed every 20 seconds. The board reads the text of whoever holds the token, so each field is checked against the board's own plain pattern first. A bad
// r or b is dropped from its entry (the board would call the whole header damaged); the entry stays. Never a path, a command or a secret.

// -- DEP-MODULES -- //
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
// -- TYPES -- //
import type { Registration } from './types.js';
// -- MODULES -- //
import { PROJECT_KEY, REGISTRATION_NAME } from './registry.js';

// -- TYPES -- //

export type WireRegistration = Pick<Registration, 'org' | 'name' | 'boardProject' | 'repo'> & {
	/** Overrides the folder name taken from `repo`. */
	repoName?: string | null;
	branch?: string | null;
};
type WireEntry = { p: string; n: string; r?: string; b?: string };

// -- CONSTANTS -- //

export const REGISTRATIONS_HEADER = 'x-afb-tool-registrations';
/** How often the list is sent again, in milliseconds. */
export const REGISTRATIONS_REFRESH_MS = 20_000;
export const MAX_WIRE_REGISTRATIONS = 16;
/** The board refuses a header longer than this. */
const MAX_HEADER_CHARS = 6000;
const REPO = /^[A-Za-z0-9 ._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

// -- FUNCTIONS -- //

/** The checked out branch of a repo, read from .git/HEAD without starting git. Null for a detached HEAD, no repo or a head it cannot read. */
export function readBranch(repo: string): string | null {
	try {
		let gitDir = join(repo, '.git');
		if (statSync(gitDir).isFile()) {
			const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
			if (!m?.[1]) return null;
			const target = m[1].trim();
			gitDir = isAbsolute(target) ? target : resolve(dirname(gitDir), target);
		}
		const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
		const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return ref?.[1] ?? null;
	} catch {
		return null;
	}
}

/** The registrations of one organisation as board entries, with the fields that do not match dropped. */
export function wireEntries(org: string, registrations: WireRegistration[]): WireEntry[] {
	const out: WireEntry[] = [];
	for (const r of registrations) {
		if (r.org !== org) continue;
		// An entry without a valid project key or name cannot be sent at all: the board would refuse the whole header
		if (!PROJECT_KEY.test(r.boardProject) || !REGISTRATION_NAME.test(r.name)) continue;
		const entry: WireEntry = { p: r.boardProject, n: r.name };
		const folder = r.repoName ?? (r.repo ? basename(r.repo) : null);
		if (folder && REPO.test(folder)) entry.r = folder;
		if (r.branch && BRANCH.test(r.branch)) entry.b = r.branch;
		out.push(entry);
		if (out.length === MAX_WIRE_REGISTRATIONS) break;
	}
	return out;
}

/** The header value for one organisation, or '' when it has none. The list is cut from the end until it fits what the board accepts. */
export function registrationsHeader(org: string, registrations: WireRegistration[]): string {
	const list = wireEntries(org, registrations);
	while (list.length) {
		const value = Buffer.from(JSON.stringify(list)).toString('base64url');
		if (value.length <= MAX_HEADER_CHARS) return value;
		list.pop();
	}
	return '';
}

/** Gives a registration its branch from the repo (no git process), for the header and the report. */
export function withBranch(reg: Registration): WireRegistration {
	return { ...reg, branch: reg.repo && existsSync(reg.repo) ? readBranch(reg.repo) : null };
}

/**
 * Cleans the registration fields of a run report before it is sent: a registration that is not a plain name, and a folder name or branch that does not match the board's pattern,
 * are removed from the report (the rest of the report stays).
 */
export function sanitiseReport<
	T extends { registration?: string; repoName?: string; branch?: string }
>(report: T): T {
	const out = { ...report };
	if (out.registration !== undefined && !REGISTRATION_NAME.test(out.registration))
		delete out.registration;
	if (out.repoName !== undefined && !REPO.test(out.repoName)) delete out.repoName;
	if (out.branch !== undefined && !BRANCH.test(out.branch)) delete out.branch;
	return out;
}
