// THE PAGE SIDE OF THE LIVE STREAM: OPENS THE EVENT SOURCE, TELLS THE PAGE TO REFETCH ON A CHANGE, AND REPORTS WHEN LIVE UPDATES ARE LOST

// -- TYPES -- //
export type LiveState = { lost: boolean };

// -- CONSTANTS -- //

/** Several changes in a burst become one refetch. */
const DEBOUNCE_MS = 120;

// -- FUNCTIONS -- //

/**
 * Connects to a project stream. `onChange` runs once per burst of changes and after a reconnect (so a missed change is
 * never silently lost). Returns the function that closes the stream.
 */
export function connectStream(
	url: string,
	state: LiveState,
	onChange: () => void,
	source: typeof EventSource = EventSource
): () => void {
	let es: EventSource;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let dropped = false;
	let first = true;
	let attempt = 0;
	let closed = false;
	const soon = () => {
		clearTimeout(timer);
		timer = setTimeout(onChange, DEBOUNCE_MS);
	};
	const connect = () => {
		es = new source(url);
		es.addEventListener('open', () => {
			state.lost = false;
			attempt = 0;
			// The page was drawn before the stream opened, and a claim carries no event id to replay, so the first open refetches
			// once. After a drop the browser reconnects with Last-Event-ID and the server replays; a refetch covers the rest.
			if (dropped || first) {
				dropped = false;
				first = false;
				soon();
			}
		});
		es.addEventListener('change', soon);
		es.addEventListener('refetch', soon);
		es.addEventListener('error', () => {
			dropped = true;
			state.lost = true;
			// A browser reconnects by itself after a dropped network, but gives up for good on a refused or redirected stream (a
			// proxy answering 502 during an update, a session that ended). Then a new one is opened after a growing wait.
			if (!closed && es.readyState === 2) {
				es.close();
				retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
			}
		});
	};
	connect();
	return () => {
		closed = true;
		clearTimeout(timer);
		clearTimeout(retry);
		es.close();
	};
}
