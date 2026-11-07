// A SMALL PER ADDRESS LIMIT FOR THE PUBLIC MOCKUP ROUTES, SO AN ADDRESS CANNOT BE GUESSED AT SPEED

// -- CONSTANTS -- //

export const PUBLIC_LIMIT = 120;
export const PUBLIC_WINDOW_MS = 60_000;
const MAX_ADDRESSES = 10_000;

// -- STATES -- //

const buckets = new Map<string, { start: number; count: number }>();

// -- FUNCTIONS -- //

/** Counts one request for this address and says whether it may go on. Old windows are dropped, and the table is bounded. */
export function publicRateAllowed(address: string, now = Date.now()): boolean {
	const b = buckets.get(address);
	if (!b || now - b.start >= PUBLIC_WINDOW_MS) {
		if (buckets.size >= MAX_ADDRESSES) {
			for (const [k, v] of buckets) if (now - v.start >= PUBLIC_WINDOW_MS) buckets.delete(k);
			if (buckets.size >= MAX_ADDRESSES) buckets.clear();
		}
		buckets.set(address, { start: now, count: 1 });
		return true;
	}
	b.count++;
	return b.count <= PUBLIC_LIMIT;
}

/** For tests. */
export const resetPublicRate = () => buckets.clear();
