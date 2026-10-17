// THE OPTIMISTIC STATE OF A TICK: WHAT A CLICK ASKED FOR, SHOWN AT ONCE, UNTIL THE SERVER DATA SHOWS THE SAME VALUE

// -- TYPES -- //
type Entry = {
	to: string;
	/** Which click this value belongs to. Only the newest click of a key may change or clear it. */
	token: number;
	/** `saving` while the request is in flight, `held` once it has finished and the refetch is still catching up. */
	phase: 'saving' | 'held';
};

// -- CONSTANTS -- //

/** A held value that the server data never confirms (another change won) is dropped after this long. */
const HOLD_MS = 5000;

// -- FUNCTIONS -- //

/** One instance per screen. A click `start`s a key, the request's end `settle`s or `fail`s it, and new server data `confirm`s it. */
export function createOptimistic(holdMs = HOLD_MS) {
	const entries = $state<Record<string, Entry>>({});
	let counter = 0;

	/** Removes a key only when the given click still owns it, so an older click never undoes a newer one. */
	function drop(key: string, token: number) {
		if (entries[key]?.token === token) delete entries[key];
	}

	return {
		/** The state to draw: what the click asked for, or the server's own when nothing is pending. */
		stateOf: (key: string, server: string) => entries[key]?.to ?? server,
		/** True only while the request is in flight. */
		saving: (key: string) => entries[key]?.phase === 'saving',
		/** True while the request is in flight or the refetch has not caught up. */
		has: (key: string) => key in entries,
		/** A click asked for `to`. Returns the click's token. */
		start(key: string, to: string): number {
			const token = ++counter;
			entries[key] = { to, token, phase: 'saving' };
			return token;
		},
		/** The request succeeded: keep showing the value, without a spinner, until the server data shows it. */
		settle(key: string, token: number) {
			const entry = entries[key];
			if (entry?.token !== token) return;
			entry.phase = 'held';
			setTimeout(() => drop(key, token), holdMs);
		},
		/** The request failed: go back to the server's value, unless a newer click owns the key. */
		fail(key: string, token: number) {
			drop(key, token);
		},
		/** New server data arrived: a held value the data now shows is dropped. A value still in flight is never touched. */
		confirm(server: Record<string, string>) {
			for (const [key, entry] of Object.entries(entries))
				if (entry.phase === 'held' && server[key] === entry.to) delete entries[key];
		}
	};
}
