// THE HAND WRITTEN YJS PROVIDER OF A NOTE (AFB-20261111-0035, STEP 4.1)
// No library provider: this one only moves bytes between a Yjs document, an awareness object and a transport the page supplies
// (later the note's live endpoints). It knows nothing about the network, so the tests run it over a fake transport.

// IMPORTED MODULES
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates
} from 'y-protocols/awareness';
import * as Y from 'yjs';

// -- TYPES -- //

export interface LiveHandlers {
	/** A Yjs update another window made. */
	update: (update: Uint8Array) => void;
	/** An awareness update from another window. */
	presence: (data: Uint8Array) => void;
}

/** What the provider needs from the outside world. */
export interface LiveTransport {
	sendUpdate: (update: Uint8Array) => void;
	sendPresence: (data: Uint8Array) => void;
	/** Starts listening; the returned function stops it. */
	subscribe: (handlers: LiveHandlers) => () => void;
}

// -- CONSTANTS -- //

/** The origin put on updates that came from the transport, so they are not sent back. */
const REMOTE = Symbol('remote');

// -- FUNCTIONS -- //

export class LiveProvider {
	readonly awareness: Awareness;
	private readonly stop: () => void;
	private destroyed = false;

	constructor(
		private readonly ydoc: Y.Doc,
		private readonly transport: LiveTransport
	) {
		this.awareness = new Awareness(ydoc);
		ydoc.on('update', this.onDocUpdate);
		this.awareness.on('update', this.onAwarenessUpdate);
		this.stop = transport.subscribe({
			update: (u) => {
				if (!this.destroyed) Y.applyUpdate(this.ydoc, u, REMOTE);
			},
			presence: (p) => {
				if (!this.destroyed) applyAwarenessUpdate(this.awareness, p, REMOTE);
			}
		});
	}

	private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE || this.destroyed) return;
		this.transport.sendUpdate(update);
	};

	private readonly onAwarenessUpdate = (
		change: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown
	) => {
		if (origin === REMOTE || this.destroyed) return;
		const ids = [...change.added, ...change.updated, ...change.removed];
		this.transport.sendPresence(encodeAwarenessUpdate(this.awareness, ids));
	};

	/** Stops listening, tells the others this window left, and frees the awareness timers. */
	destroy() {
		if (this.destroyed) return;
		// The goodbye goes out first, while the provider can still send
		removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'destroy');
		this.destroyed = true;
		this.stop();
		this.ydoc.off('update', this.onDocUpdate);
		this.awareness.off('update', this.onAwarenessUpdate);
		this.awareness.destroy();
	}
}
