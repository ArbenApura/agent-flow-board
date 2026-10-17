// ITEM REFERENCES: THE STAMP FORM, THE OLD NUMBER FORM AND THE LEGACY HAPR BOARD ID (FLOW-20261017-0950)
// A new item is named <PROJECT KEY>-YYYYMMDD-HHMM in UTC, with -b, -c ... when the minute is taken in that project.
// Pure functions only, so the server, the importer, the rename script and the screens all agree.

// -- CONSTANTS -- //

/** The reference of a new item, for example HAPR-20261017-0950 or HAPR-20261017-0950-b. */
export const STAMP_REF = /^[A-Z][A-Z0-9]*-\d{8}-\d{4}(?:-[a-z])?$/;
/** The old reference, a project key and a number, for example HAPR-2. */
export const NUMBER_REF = /^[A-Z][A-Z0-9]*-[0-9]+$/;
/** The id the HAPR Board wrote, always in +08:00, for example FLOW-20261014-1047 or FLOW-20261014-1047-b. */
const LEGACY_ID = /^FLOW-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:-([a-z]))?$/;
/** The suffixes after the plain stamp, in order. */
const SUFFIXES = 'bcdefghijklmnopqrstuvwxyz';
/** The Board wrote its ids in +08:00. */
const LEGACY_OFFSET_MS = 8 * 60 * 60 * 1000;

// -- FUNCTIONS -- //

export const isStampRef = (value: string) => STAMP_REF.test(value);

/**
 * True for a reference the app writes: the stamp form or the old number form, nothing else. It is strict on purpose, because a
 * reference reaches shell commands, links and prompts. An alias is looked up by the server and never goes through this.
 */
export const isItemRef = (value: string) => STAMP_REF.test(value) || NUMBER_REF.test(value);

const two = (n: number) => String(n).padStart(2, '0');

/** YYYYMMDD-HHMM of a moment, in UTC. */
export function stampOf(at: Date): string {
	return `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}-${two(at.getUTCHours())}${two(at.getUTCMinutes())}`;
}

/**
 * The references to try for a moment, in order: the plain stamp, then -b to -z. A start suffix (a legacy id that already had one)
 * begins the list at that suffix, so the plain stamp is left to the item that has it.
 */
export function refCandidates(key: string, at: Date, startSuffix = ''): string[] {
	const base = `${key}-${stampOf(at)}`;
	const all = [base, ...[...SUFFIXES].map((s) => `${base}-${s}`)];
	const from = startSuffix ? all.indexOf(`${base}-${startSuffix}`) : 0;
	return all.slice(Math.max(0, from));
}

/**
 * The real moment of a legacy HAPR Board id, read as +08:00 and returned as UTC, with the suffix it carried. Null when the id has no
 * valid date and time (not a FLOW id, month 13, 25:00, 31 February), so the caller falls back to the creation time.
 */
export function legacyMoment(id: string): { at: Date; suffix: string } | null {
	const m = LEGACY_ID.exec(id);
	if (!m) return null;
	const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
	const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
	// A date that rolled over (31 February, hour 24, minute 60) is not a real moment
	if (
		wall.getUTCFullYear() !== year ||
		wall.getUTCMonth() !== month - 1 ||
		wall.getUTCDate() !== day ||
		wall.getUTCHours() !== hour ||
		wall.getUTCMinutes() !== minute
	)
		return null;
	return { at: new Date(wall.getTime() - LEGACY_OFFSET_MS), suffix: m[6] ?? '' };
}
