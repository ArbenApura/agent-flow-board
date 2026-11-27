// IMPORTED TYPES
import type { OrgPalette } from '#lib/server/db/schema/core.js';
// IMPORTED CONSTANTS
import { ORG_SLUG as SLUG } from '#lib/shared/orgConnection.js';

// -- TYPES -- //

/** An organisation the person belongs to, as the org layout loads it. */
export type SwitchOrg = {
	id: string;
	name: string;
	slug: string;
	logo: string | null;
	palette: OrgPalette | null;
};

/** What this browser remembers for one person: the recently used org slugs, newest first, and the last project per org. */
type Memory = { recent: string[]; last: Record<string, string> };

/** The smallest part of the Web Storage API the helpers use, so a test can pass its own. */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;

// -- CONSTANTS -- //

const PREFIX = 'afb:org-switch:';
const RECENT_MAX = 12;
// The same pattern the project schema accepts (src/lib/server/db/zod.ts), so a stored value can never shape another path
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

// -- FUNCTIONS -- //

/** The browser storage, or null on the server or when the browser blocks it. */
function browserStore(): KeyStore | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Reads what this browser remembers for the person. Anything missing, blocked or malformed reads as nothing remembered. */
export function readMemory(userId: string, store: KeyStore | null = browserStore()): Memory {
	const empty: Memory = { recent: [], last: {} };
	if (!store) return empty;
	try {
		const raw = store.getItem(PREFIX + userId);
		if (!raw) return empty;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return empty;
		const { recent, last } = parsed as Partial<Memory>;
		return {
			recent: Array.isArray(recent)
				? recent.filter((s): s is string => typeof s === 'string' && SLUG.test(s))
				: [],
			last:
				last && typeof last === 'object'
					? Object.fromEntries(
							Object.entries(last).filter(
								([slug, key]) => SLUG.test(slug) && typeof key === 'string' && PROJECT_KEY.test(key)
							)
						)
					: {}
		};
	} catch {
		return empty;
	}
}

/**
 * Remembers that the person is in this org, and in this project of it when one is open. The org moves to the front of the
 * recent list. Storage that is blocked or full is ignored: the switcher then simply orders by name.
 */
export function rememberVisit(
	userId: string,
	slug: string,
	projectKey: string | undefined,
	store: KeyStore | null = browserStore()
) {
	if (!store || !SLUG.test(slug)) return;
	const memory = readMemory(userId, store);
	const recent = [slug, ...memory.recent.filter((s) => s !== slug)].slice(0, RECENT_MAX);
	const last = { ...memory.last };
	if (projectKey && PROJECT_KEY.test(projectKey)) last[slug] = projectKey;
	if (recent.join() === memory.recent.join() && last[slug] === memory.last[slug]) return;
	try {
		store.setItem(PREFIX + userId, JSON.stringify({ recent, last }));
	} catch {
		// The visit just is not kept
	}
}

/**
 * The orgs in switcher order: the current one first, then the ones used most recently in this browser, then the rest by name.
 * Only live orgs are returned; a remembered slug is a sort hint and is never shown on its own.
 */
export function orderOrgs<T extends { slug: string; name: string }>(
	orgs: T[],
	current: string,
	recent: string[]
): T[] {
	const rank = new Map(recent.map((s, i) => [s, i]));
	return [...orgs].sort((a, b) => {
		if (a.slug === current || b.slug === current) return a.slug === current ? -1 : 1;
		const ra = rank.get(a.slug) ?? Infinity;
		const rb = rank.get(b.slug) ?? Infinity;
		if (ra !== rb) return ra - rb;
		return a.name.localeCompare(b.name);
	});
}

/** Where a switch to this org lands: its home for the current org, else the project last opened there, else its home. */
export function switchTarget(slug: string, current: string, last: Record<string, string>) {
	const key = last[slug];
	return slug !== current && key && PROJECT_KEY.test(key) ? `/${slug}/${key}` : `/${slug}`;
}
