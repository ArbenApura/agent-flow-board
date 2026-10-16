// KEEPS A SETTINGS FIELD IN STEP WITH ITS SAVED VALUE WITHOUT THROWING AWAY WHAT SOMEONE IS STILL TYPING IN ANOTHER SECTION (ADR-015)
// Every section saves on its own. When one section saves, the page data is read again, and only the fields whose saved value
// really changed are replaced. A field that was edited but not saved keeps the edit.

// -- FUNCTIONS -- //

/** A follower for one page. Call `follow(key, saved, set)` from an effect with each field's saved value. */
export function createFollower() {
	const seen = new Map<string, string>();
	return function follow<T>(key: string, saved: T, set: (value: T) => void) {
		const now = JSON.stringify(saved);
		if (seen.get(key) === now) return;
		seen.set(key, now);
		set(saved);
	};
}

/** Data with its keys sorted at every depth, so the same data compares equal however the database ordered its keys. */
function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === 'object')
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
		);
	return v;
}

/** The text of data in a form that does not depend on key order. */
export const canon = (v: unknown): string => JSON.stringify(sortKeys(v));
