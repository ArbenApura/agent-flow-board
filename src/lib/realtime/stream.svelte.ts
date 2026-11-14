// THE PAGE SIDE OF THE LIVE STREAM: OPENS THE EVENT SOURCE, TELLS THE PAGE TO REFETCH ON A CHANGE, AND REPORTS WHEN LIVE UPDATES ARE LOST

// IMPORTED DEP-MODULES
import { SvelteSet } from 'svelte/reactivity';

// -- TYPES -- //
export type LiveState = { lost: boolean };

/** A live editing notice. `note` says new updates were stored (up to `seq` of `epoch`); `presence` carries one awareness message. */
export type NoteLiveNotice =
	| { kind: 'note'; note: string; epoch: number | null; seq: number }
	| { kind: 'presence'; note: string; epoch: number | null; data: string }
	/** The stream came back after a drop: notices may have been missed, so an open note reads again by number. */
	| { kind: 'reconnected' };

// -- STATES -- //

/** The listeners the note page registers. A live notice goes only to these and never to the page refresh. */
const noteListeners = new SvelteSet<(notice: NoteLiveNotice) => void>();

// -- CONSTANTS -- //

/** Several changes in a burst become one refetch. */
const DEBOUNCE_MS = 120;

// -- FUNCTIONS -- //

/** Registers the note page's listener for live editing notices. Returns the function that removes it. */
export function onNoteLive(listener: (notice: NoteLiveNotice) => void): () => void {
	noteListeners.add(listener);
	return () => noteListeners.delete(listener);
}

/** Parses one live notice; anything that is not the expected shape is dropped. */
function liveNotice(kind: 'note' | 'presence', raw: unknown): NoteLiveNotice | null {
	if (typeof raw !== 'string') return null;
	try {
		const d = JSON.parse(raw) as Record<string, unknown>;
		if (typeof d.note !== 'string') return null;
		const epoch = typeof d.epoch === 'number' ? d.epoch : null;
		if (kind === 'note')
			return typeof d.seq === 'number' ? { kind, note: d.note, epoch, seq: d.seq } : null;
		return typeof d.data === 'string' ? { kind, note: d.note, epoch, data: d.data } : null;
	} catch {
		return null;
	}
}

/**
 * Connects to a project stream. `onChange` runs once per burst of changes and after a reconnect (so a missed change is
 * never silently lost). It is told whether a change was announced (`true`, so cached data must not be used) or the stream only
 * opened (`false`, a cached answer may show while the network refreshes it). Returns the function that closes the stream.
 */
export function connectStream(
	url: string,
	state: LiveState,
	onChange: (announced: boolean) => void,
	source: typeof EventSource = EventSource
): () => void {
	let es: EventSource;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let dropped = false;
	let first = true;
	let attempt = 0;
	let closed = false;
	let announced = false;
	const soon = (isChange = true) => {
		announced ||= isChange;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const asked = announced;
			announced = false;
			onChange(asked);
		}, DEBOUNCE_MS);
	};
	const connect = () => {
		es = new source(url);
		es.addEventListener('open', () => {
			state.lost = false;
			attempt = 0;
			// The page was drawn before the stream opened, and a claim carries no event id to replay, so the first open refetches
			// once. After a drop the browser reconnects with Last-Event-ID and the server replays; a refetch covers the rest.
			if (dropped || first) {
				// Only the very first open may show cached data. After a drop a change may have been missed, so the network answers
				const missed = dropped;
				dropped = false;
				if (missed) for (const fn of noteListeners) fn({ kind: 'reconnected' });
				first = false;
				soon(missed);
			}
		});
		es.addEventListener('change', () => soon());
		es.addEventListener('refetch', () => soon());
		// Live editing notices never reach soon(): a live update reloads no page
		for (const kind of ['note', 'presence'] as const)
			es.addEventListener(kind, (e) => {
				const notice = liveNotice(kind, (e as MessageEvent).data);
				if (notice) for (const fn of noteListeners) fn(notice);
			});
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
