// WHEN A MOCKUP CARD MAY LOAD ITS PICTURE: ONLY WHILE ITS ADDRESS HAS LIFE LEFT, KEEPING THE ADDRESS IT LOADED WITH, AND ONLY A FEW LIVE PREVIEWS AT ONCE

// -- CONSTANTS -- //

/** A card loads only when its address still works for at least this many seconds. */
export const MIN_SECONDS_LEFT = 30;
/** At most this many live preview frames exist at once. The farthest from the screen goes back to the placeholder. */
export const MAX_LIVE_FRAMES = 12;

// -- FUNCTIONS -- //

/** The part of a signed address before its expiry and signature, which names the file. */
export const fileKey = (address: string): string => address.split('?')[0];

/** The expiry of a signed address in epoch seconds, or null when it carries none. */
export function expiryOf(address: string): number | null {
	const query = address.split('?')[1] ?? '';
	const raw = new URLSearchParams(query).get('exp');
	if (!raw || !/^\d+$/.test(raw)) return null;
	return Number(raw);
}

/** Whole seconds an address still works for. An address with no expiry never lapses. */
export function secondsLeft(address: string, nowMs: number): number {
	const exp = expiryOf(address);
	return exp === null ? Number.POSITIVE_INFINITY : exp - Math.floor(nowMs / 1000);
}

/** True when an address has enough life left to start loading. */
export const mayLoad = (address: string, nowMs: number): boolean =>
	secondsLeft(address, nowMs) >= MIN_SECONDS_LEFT;

/**
 * The address a card shows: the one it loaded with while the part before the question mark is the same, because every page load
 * signs the address again and a new string for the same file is not a new file.
 */
export function addressToShow(shown: string | null, incoming: string): string {
	return shown !== null && fileKey(shown) === fileKey(incoming) ? shown : incoming;
}

/**
 * Decides whether a card may start a live frame. `loaded` holds the distance from the middle of the screen of every live frame.
 * When all slots are used, a nearer card takes the place of the farthest one and the farthest is returned to unload.
 */
export function planSlot(
	loaded: ReadonlyMap<string, number>,
	id: string,
	distance: number,
	max = MAX_LIVE_FRAMES
): { grant: boolean; evict: string | null } {
	if (loaded.has(id) || loaded.size < max) return { grant: true, evict: null };
	let farthest: string | null = null;
	let far = -1;
	for (const [other, d] of loaded) {
		if (d > far) {
			far = d;
			farthest = other;
		}
	}
	return farthest !== null && far > distance
		? { grant: true, evict: farthest }
		: { grant: false, evict: null };
}
