// A SIGN IN OLDER THAN THE FRESH AGE (ONE DAY) IS REFUSED BY BETTER AUTH FOR THE SESSION LIST. THE SETTINGS PAGE MUST STILL OPEN.

// -- CONSTANTS -- //

/** The Better Auth error code for a session that is too old for a sensitive call. */
const NOT_FRESH = 'SESSION_NOT_FRESH';

// -- FUNCTIONS -- //

/** True only for the not fresh refusal. Matches the code, never the message text, so no other error looks like it. */
export function isNotFresh(e: unknown): boolean {
	const body = (e as { body?: { code?: unknown } } | null | undefined)?.body;
	return body?.code === NOT_FRESH;
}

/** Runs a call that needs a fresh session. An old session gives an empty list and `stale`; any other error is thrown again. */
export async function listOrStale<T>(
	list: () => Promise<T[]>
): Promise<{ rows: T[]; stale: boolean }> {
	try {
		return { rows: await list(), stale: false };
	} catch (e) {
		if (isNotFresh(e)) return { rows: [], stale: true };
		throw e;
	}
}
