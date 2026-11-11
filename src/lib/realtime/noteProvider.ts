// THE NETWORK PROVIDER OF A NOTE (AFB-20261111-0035, 8.3 TO 8.6)
// It joins the hand written LiveProvider (a Yjs document plus awareness) to the note's live endpoints. Local changes are merged
// and posted at most every 300 ms, in order, and kept when the network fails. A note notice names the number of the newest
// update, and the provider reads what it does not hold by number, so a lost notice is repaired by the next one or by a
// reconnect. The Markdown checkpoint follows 2 seconds after the last change. It knows nothing about fetch or the page: a
// transport and a listener are handed in, so the tests run two providers over a fake server.

// -- TYPES -- //
import type { NoteLiveNotice } from './stream.svelte';
import type { LiveSnapshot, OpenedDocument, SeedApi } from '../board/notes/seed';
// -- DEP-MODULES -- //
import { encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
// -- MODULES -- //
import { LiveProvider, type LiveHandlers } from '../board/notes/liveProvider';
import { openDocument } from '../board/notes/seed';
import { NOTE_LIMITS } from '../shared/notes';

// -- TYPES -- //

/** Why a call to the server failed, in the only terms the provider acts on. */
export type FailureKind = 'offline' | 'gone' | 'full' | 'size' | 'other';

export class TransportError extends Error {
	constructor(
		readonly kind: FailureKind,
		message = 'The live editing call failed.'
	) {
		super(message);
		this.name = 'TransportError';
	}
}

export interface ReadReply {
	epoch: number;
	markdown: string;
	last: number;
	checkpointSeq: number;
	updates: { seq: number; update: Uint8Array }[];
}

export type PostReply =
	| { ok: true; epoch: number; seqs: number[]; last: number }
	| { ok: false; reason: 'epoch'; epoch: number }
	| { ok: false; reason: 'taken'; epoch: number };

export type CheckpointReply =
	| { ok: true; epoch: number; sequence: number }
	| { ok: false; reason: 'epoch' | 'old'; epoch: number; checkpointSeq: number };

export interface Send {
	/** The call is made while the page closes and must outlive it. */
	keepalive?: boolean;
}

/** What the provider needs from the network. Every method throws a TransportError when it fails. */
export interface NoteTransport {
	read: (after: number) => Promise<ReadReply>;
	post: (
		epoch: number,
		updates: Uint8Array[],
		opts?: Send & { seed?: boolean }
	) => Promise<PostReply>;
	checkpoint: (
		req: { epoch: number; sequence: number; title?: string; body: string },
		opts?: Send
	) => Promise<CheckpointReply>;
	presence: (data: Uint8Array, opts?: Send) => Promise<void>;
}

/** What the person sees under the editor. `full` and `stopped` end the typing. */
export type LiveStatus =
	'saved' | 'pending' | 'saving' | 'offline' | 'error' | 'full' | 'toolarge' | 'stopped';

export interface Peer {
	/** The person's user id, so two windows of one person are one avatar. */
	id: string;
	name: string;
	/** The version of the person's picture, so the avatar can be read. Left out when they have none. */
	v?: number;
}

export interface ProviderOptions {
	noteId: string;
	ydoc: Y.Doc;
	epoch: number;
	/** The number of the last update the document holds. */
	last: number;
	/** The number of the last update the stored Markdown covers. */
	checkpointSeq: number;
	transport: NoteTransport;
	/** Registers for the page stream's live notices; returns the function that stops listening. */
	listen: (fn: (notice: NoteLiveNotice) => void) => () => void;
	/** The Markdown of the document right now. */
	markdown: (ydoc: Y.Doc) => string;
	/** The title to save with a checkpoint, or undefined when this window did not change it (a rename elsewhere stays). */
	title: () => string | undefined;
	/** True when this window built the note's first live update from the stored text. It is not checkpointed until edited. */
	seeded?: boolean;
	user: Peer;
	onStatus?: (status: LiveStatus) => void;
	/** Someone changed the text from outside (an agent, the API, a restore): the epoch moved on. The provider has stopped. */
	onEpoch?: (epoch: number) => void;
	/** The note is trashed or no longer open to this person. The provider has stopped. */
	onGone?: () => void;
	/** The people who have the note open besides this person, changed whenever someone joins or leaves. */
	onPeers?: (peers: Peer[]) => void;
}

// -- CONSTANTS -- //

/** The most bytes one post of merged updates is built from, well under what the server takes in one update. */
const CHUNK_BYTES = 200 * 1024;
/** The most updates one call carries (the server's limit is 50). */
const MAX_CHUNKS_PER_CALL = 50;
/** The most often local changes are posted. */
export const POST_MS = 300;
/** Quiet time after the last change before the Markdown checkpoint. */
export const CHECKPOINT_MS = 2000;
/** The most often this window's cursor is sent. */
export const PRESENCE_MS = 2000;
/** A failed call is tried again after these waits; the last one repeats. */
const RETRY_MS = [1000, 2000, 5000, 10_000];
/** The name in a presence message is cut here, so a message stays far under 1 KB. */
const NAME_MAX = 60;

/** The one token every remote cursor uses. No colour is picked at run time. */
export const CARET_COLOUR = 'var(--ink)';

// -- FUNCTIONS -- //

export const toBase64 = (bytes: Uint8Array): string => {
	let out = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(out);
};

export const fromBase64 = (text: string): Uint8Array => {
	const raw = atob(text);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
};

/** The people other than `selfId` found in an awareness state map, one per person, by name. */
export function peersOf(states: Map<number, unknown>, selfId: string): Peer[] {
	const byId = new Map<string, Peer>();
	for (const state of states.values()) {
		const user = (state as { user?: { id?: unknown; name?: unknown; v?: unknown } } | null)?.user;
		if (!user || typeof user.id !== 'string' || typeof user.name !== 'string') continue;
		if (user.id === selfId) continue;
		byId.set(user.id, {
			id: user.id,
			name: user.name,
			...(typeof user.v === 'number' ? { v: user.v } : {})
		});
	}
	return [...byId.values()].sort(
		(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
	);
}

/** The words under the editor for a status. */
export function liveLine(status: LiveStatus): string {
	switch (status) {
		case 'saved':
			return 'Saved';
		case 'pending':
		case 'saving':
			return 'Saving...';
		case 'offline':
			return 'Offline. Your changes are kept and will be sent when you are back';
		case 'error':
			return 'Could not reach the server, trying again';
		case 'full':
			return 'This note holds too much unsaved live text to take more typing. Reload the page and try again';
		case 'toolarge':
			return 'This change is too large to save, so typing is paused. Copy what you need elsewhere, then reload the page';
		case 'stopped':
			return 'This note changed. Reload the page to go on';
	}
}

export class NoteProvider {
	readonly ydoc: Y.Doc;
	readonly live: LiveProvider;
	status: LiveStatus = 'saved';
	epoch: number;
	/** The number of the last update this window holds. */
	last: number;
	checkpointSeq: number;

	private readonly o: ProviderOptions;
	private readonly unlisten: () => void;
	private deliver: LiveHandlers | null = null;
	private queue: Uint8Array[] = [];
	private posting = false;
	private pulling = false;
	private pullAgain = false;
	private checkpointing = false;
	private postTimer: ReturnType<typeof setTimeout> | null = null;
	private cpTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private presenceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPresence = 0;
	private presenceDirty = false;
	private attempt = 0;
	private stopped = false;
	private disposed = false;
	private leaving = false;
	private edited = false;

	constructor(o: ProviderOptions) {
		this.o = o;
		this.ydoc = o.ydoc;
		this.epoch = o.epoch;
		this.last = o.last;
		this.checkpointSeq = o.checkpointSeq;
		this.live = new LiveProvider(o.ydoc, {
			sendUpdate: (u) => this.enqueue(u),
			sendPresence: (data) => this.presenceChanged(data),
			subscribe: (h) => {
				this.deliver = h;
				return () => (this.deliver = null);
			}
		});
		// A person who joins is announced to the others, and someone new who appears is answered once
		this.live.awareness.on('update', this.onAwareness);
		this.live.awareness.on('change', this.onPeople);
		this.ydoc.on('update', this.onAnyUpdate);
		this.unlisten = o.listen((n) => this.onNotice(n));
		this.live.awareness.setLocalStateField('user', {
			id: o.user.id,
			name: o.user.name.slice(0, NAME_MAX),
			...(o.user.v ? { v: o.user.v } : {}),
			color: CARET_COLOUR
		});
		// A note opened with a checkpoint that lags behind its updates is brought up to date
		if (this.checkpointSeq < this.last && !this.cleanSeed) this.scheduleCheckpoint();
	}

	/** A seed nobody has typed in yet: the stored text is already what it shows, so opening a note never rewrites it. */
	private get cleanSeed() {
		return !!this.o.seeded && !this.edited;
	}

	// -- STATUS -- //

	private set(status: LiveStatus) {
		if (this.status === status) return;
		this.status = status;
		this.o.onStatus?.(status);
	}

	/** A call went through: the connection is fine again. */
	private ok() {
		this.attempt = 0;
		if (this.status === 'offline' || this.status === 'error') this.set('saved');
	}

	/** Works the status out from what is waiting. A stopped or full provider keeps that status. */
	private settle() {
		if (this.stopped || this.blocked || this.disposed) return;
		if (this.posting || this.checkpointing) return this.set('saving');
		if (this.status === 'offline' || this.status === 'error') return;
		if (
			this.queue.length > 0 ||
			this.postTimer ||
			this.cpTimer ||
			(this.checkpointSeq < this.last && !this.cleanSeed)
		)
			return this.set('pending');
		this.set('saved');
	}

	/** True while the document holds text the server has not taken. */
	get unsent() {
		return this.queue.length > 0;
	}

	// -- LOCAL CHANGES -- //

	private readonly onAnyUpdate = () => {
		if (!this.stopped && !this.disposed) this.scheduleCheckpoint();
	};

	private enqueue(update: Uint8Array) {
		if (this.stopped || this.disposed || this.blocked) return;
		this.edited = true;
		this.queue.push(update);
		if (!this.postTimer && !this.posting && !this.retryTimer)
			this.postTimer = setTimeout(() => {
				this.postTimer = null;
				void this.flush();
			}, POST_MS);
		this.settle();
	}

	/** True once the note takes no more typing: its live text is full, or a change is too large to ever be accepted. */
	private get blocked() {
		return this.status === 'full' || this.status === 'toolarge';
	}

	/**
	 * Groups the waiting updates into posts of at most CHUNK_BYTES (merged per group, never one huge merge), at most one
	 * call's worth. Null when one post still passes what the server takes: that change can never be sent.
	 */
	private takeChunks(): { chunks: Uint8Array[]; count: number } | null {
		const chunks: Uint8Array[] = [];
		let group: Uint8Array[] = [];
		let size = 0;
		let count = 0;
		const close = () => {
			if (group.length > 0) chunks.push(group.length === 1 ? group[0] : Y.mergeUpdates(group));
			group = [];
			size = 0;
		};
		for (const u of this.queue) {
			if (size > 0 && size + u.byteLength > CHUNK_BYTES) {
				if (chunks.length + 1 >= MAX_CHUNKS_PER_CALL) break;
				close();
			}
			group.push(u);
			size += u.byteLength;
			count++;
		}
		close();
		return chunks.some((c) => c.byteLength > NOTE_LIMITS.updateBytes) ? null : { chunks, count };
	}

	/** Posts everything waiting, in chunks. A failure leaves the queue as it is, so nothing is lost or reordered. */
	async flush() {
		if (this.posting || this.stopped || this.disposed || this.queue.length === 0) return;
		if (this.blocked) return;
		const taken = this.takeChunks();
		if (!taken) return this.set('toolarge');
		const { chunks, count } = taken;
		this.posting = true;
		this.settle();
		try {
			const reply = await this.o.transport.post(this.epoch, chunks);
			this.posting = false;
			if (this.disposed) return;
			if (!reply.ok) {
				if (reply.reason === 'epoch') return this.changedEpoch(reply.epoch);
				// 'taken' answers a seed only, which is never offered here
				return this.failed(new TransportError('other'));
			}
			this.queue.splice(0, count);
			this.attempt = 0;
			this.ok();
			// The numbers taken follow the ones held: no one else wrote in between. Otherwise the gap is read
			if (reply.seqs[0] === this.last + 1) this.last = reply.last;
			else void this.pull();
			this.afterWork();
		} catch (e) {
			this.posting = false;
			this.failed(e);
		}
	}

	/** After a call finished: more waiting changes go out, and a wanted checkpoint is tried. */
	private afterWork() {
		if (this.queue.length > 0 && !this.postTimer)
			this.postTimer = setTimeout(() => {
				this.postTimer = null;
				void this.flush();
			}, POST_MS);
		this.settle();
	}

	private failed(error: unknown) {
		const kind = error instanceof TransportError ? error.kind : 'other';
		if (kind === 'gone') {
			this.stop();
			this.o.onGone?.();
			return;
		}
		if (kind === 'full') {
			// The queue is kept, nothing more is accepted: the page makes the text read only and says why
			this.set('full');
			return;
		}
		if (kind === 'size') {
			// The server refuses the content itself, so trying again can never work: no retry, the page locks the text
			this.set('toolarge');
			return;
		}
		this.set(kind === 'offline' ? 'offline' : 'error');
		this.retrySoon();
	}

	private retrySoon() {
		if (this.retryTimer || this.stopped || this.disposed) return;
		const ms = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.resume();
		}, ms);
	}

	/** Everything that waits is tried again: the unsent changes, the numbers missed, the checkpoint. */
	private async resume() {
		if (this.stopped || this.disposed) return;
		await this.pull();
		await this.flush();
		if (this.status !== 'offline' && this.status !== 'error') this.scheduleCheckpoint(0);
	}

	/** The network is back (the browser's online event, or the stream reopened after a drop). */
	reconnect() {
		if (this.stopped || this.disposed) return;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.attempt = 0;
		this.presenceDirty = true;
		this.sendPresenceNow();
		void this.resume();
	}

	// -- REMOTE CHANGES -- //

	private onNotice(n: NoteLiveNotice) {
		if (this.stopped || this.disposed) return;
		if (n.kind === 'reconnected') return this.reconnect();
		if (n.note !== this.o.noteId) return;
		if (n.epoch !== null && n.epoch > this.epoch) return this.changedEpoch(n.epoch);
		if (n.epoch !== null && n.epoch < this.epoch) return;
		if (n.kind === 'note') {
			if (n.seq > this.last) void this.pull();
			return;
		}
		try {
			this.deliver?.presence(fromBase64(n.data));
		} catch {
			// A presence message that does not decode is dropped
		}
	}

	/** Reads the updates after the last held number and applies them in order. One read runs at a time; a notice during it asks for one more. */
	async pull() {
		if (this.stopped || this.disposed) return;
		if (this.pulling) {
			this.pullAgain = true;
			return;
		}
		this.pulling = true;
		try {
			do {
				this.pullAgain = false;
				const reply = await this.o.transport.read(this.last);
				if (this.disposed || this.stopped) return;
				if (reply.epoch > this.epoch) return this.changedEpoch(reply.epoch);
				if (reply.epoch < this.epoch) return;
				for (const u of reply.updates) this.deliver?.update(u.update);
				this.last = Math.max(this.last, reply.last);
				this.checkpointSeq = Math.max(this.checkpointSeq, reply.checkpointSeq);
				this.ok();
			} while (this.pullAgain);
			this.afterWork();
		} catch (e) {
			this.failed(e);
		} finally {
			this.pulling = false;
		}
	}

	private changedEpoch(epoch: number) {
		if (this.stopped) return;
		this.stop();
		this.o.onEpoch?.(epoch);
	}

	// -- CHECKPOINT -- //

	private scheduleCheckpoint(ms = CHECKPOINT_MS) {
		if (this.stopped || this.disposed) return;
		if (this.cpTimer) clearTimeout(this.cpTimer);
		this.cpTimer = setTimeout(() => {
			this.cpTimer = null;
			void this.checkpoint();
		}, ms);
		this.settle();
	}

	/** Saves the Markdown as the note's body, when nothing is waiting to be sent and the stored text lags behind. */
	async checkpoint(opts: Send = {}) {
		if (this.stopped || this.disposed || this.checkpointing) return;
		if (this.queue.length > 0 || this.posting || this.pulling) {
			// What is waiting goes first; the checkpoint is asked again when it is done
			this.scheduleCheckpoint(CHECKPOINT_MS);
			return;
		}
		if (this.last <= this.checkpointSeq || this.cleanSeed) return this.settle();
		const sequence = this.last;
		const body = this.o.markdown(this.ydoc);
		// A body over the limit is never accepted: typing stops with a plain message instead of retrying forever
		if (body.length > NOTE_LIMITS.body) return this.set('toolarge');
		this.checkpointing = true;
		this.settle();
		try {
			const title = this.o.title();
			const reply = await this.o.transport.checkpoint(
				{ epoch: this.epoch, sequence, ...(title ? { title } : {}), body },
				opts
			);
			this.checkpointing = false;
			if (this.disposed) return;
			if (reply.ok) this.checkpointSeq = Math.max(this.checkpointSeq, reply.sequence);
			else if (reply.reason === 'epoch') return this.changedEpoch(reply.epoch);
			else this.checkpointSeq = Math.max(this.checkpointSeq, reply.checkpointSeq);
			this.attempt = 0;
			this.ok();
			// More was typed while it went out
			if (this.last > this.checkpointSeq) this.scheduleCheckpoint();
			this.settle();
		} catch (e) {
			this.checkpointing = false;
			this.failed(e);
		}
	}

	// -- PRESENCE -- //

	private readonly onAwareness = (
		change: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown
	) => {
		// Someone new appeared: they do not know this window yet, so it is announced again (the throttle keeps it to one message)
		if (origin !== 'local' && change.added.length > 0 && !this.leaving) {
			this.presenceDirty = true;
			this.sendPresenceSoon();
		}
	};

	private peersKey = '';
	private readonly onPeople = () => {
		const peers = peersOf(this.live.awareness.getStates(), this.o.user.id);
		// A cursor moving is a change too; only a different set of people is reported
		const key = JSON.stringify(peers);
		if (key === this.peersKey) return;
		this.peersKey = key;
		this.o.onPeers?.(peers);
	};

	/** Called by the LiveProvider whenever this window's awareness changes. A goodbye goes out at once; the rest is throttled. */
	private presenceChanged(data: Uint8Array) {
		if (this.leaving) {
			if (data.byteLength <= NOTE_LIMITS.presenceBytes)
				void this.o.transport.presence(data, { keepalive: true }).catch(() => {});
			return;
		}
		if (this.stopped || this.disposed) return;
		this.presenceDirty = true;
		this.sendPresenceSoon();
	}

	private sendPresenceSoon() {
		if (this.presenceTimer) return;
		const wait = Math.max(0, this.lastPresence + PRESENCE_MS - Date.now());
		this.presenceTimer = setTimeout(() => {
			this.presenceTimer = null;
			this.sendPresenceNow();
		}, wait);
	}

	private sendPresenceNow() {
		if (!this.presenceDirty || this.stopped || this.disposed) return;
		this.presenceDirty = false;
		this.lastPresence = Date.now();
		const data = encodeAwarenessUpdate(this.live.awareness, [this.ydoc.clientID]);
		// A message over the limit is dropped rather than refused by the server
		if (data.byteLength > NOTE_LIMITS.presenceBytes) return;
		void this.o.transport.presence(data).catch(() => {
			// Presence is best effort; the next move sends it again
		});
	}

	// -- ENDING -- //

	/** Stops all network work. The document and its text stay, so the page can read them. */
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		for (const t of [this.postTimer, this.cpTimer, this.retryTimer, this.presenceTimer])
			if (t) clearTimeout(t);
		this.postTimer = this.cpTimer = this.retryTimer = this.presenceTimer = null;
		this.set('stopped');
	}

	/**
	 * The page is closing: what waits is posted and the checkpoint is tried, both as calls that outlive the page. Best
	 * effort. A checkpoint that did not make it is made by the next window that opens the note.
	 */
	leave() {
		if (this.stopped || this.disposed) return;
		if (this.queue.length > 0 && !this.posting) {
			// A copy goes out and the queue stays until the server answers: a failed call loses nothing, and a page that stays
			// (a cancelled unload) keeps its timers and sends the same text again later, which Yjs takes without harm
			const taken = this.takeChunks();
			if (!taken) return;
			const { chunks, count } = taken;
			this.posting = true;
			void this.o.transport
				.post(this.epoch, chunks, { keepalive: true })
				.then((reply) => {
					this.posting = false;
					if (this.disposed) return;
					if (reply.ok) {
						this.queue.splice(0, count);
						if (reply.seqs[0] === this.last + 1) this.last = reply.last;
						this.settle();
					}
					this.afterWork();
				})
				.catch(() => {
					this.posting = false;
				});
			return;
		}
		if (!this.posting && this.last > this.checkpointSeq && !this.cleanSeed) {
			const body = this.o.markdown(this.ydoc);
			const title = this.o.title();
			if (body.length > NOTE_LIMITS.body) return;
			void this.o.transport
				.checkpoint(
					{ epoch: this.epoch, sequence: this.last, ...(title ? { title } : {}), body },
					{ keepalive: true }
				)
				.catch(() => {});
		}
	}

	/** Lets go of the document: tells the others this window left, stops listening and frees the timers. */
	destroy() {
		if (this.disposed) return;
		this.leaving = true;
		this.live.awareness.off('update', this.onAwareness);
		this.live.awareness.off('change', this.onPeople);
		this.live.destroy();
		this.disposed = true;
		this.stopped = true;
		this.unlisten();
		this.ydoc.off('update', this.onAnyUpdate);
		for (const t of [this.postTimer, this.cpTimer, this.retryTimer, this.presenceTimer])
			if (t) clearTimeout(t);
	}
}

// -- OPENING -- //

/** The first open rule's two calls, over a transport. */
export function seedApi(transport: NoteTransport): SeedApi {
	return {
		load: async (): Promise<LiveSnapshot> => {
			const r = await transport.read(0);
			return {
				epoch: r.epoch,
				markdown: r.markdown,
				updates: r.updates.map((u) => u.update),
				last: r.last,
				checkpointSeq: r.checkpointSeq
			};
		},
		seed: async (epoch, update) => {
			const r = await transport.post(epoch, [update], { seed: true });
			return r.ok ? { ok: true } : { ok: false, reason: r.reason };
		}
	};
}

/** Opens a note's live document under the first open rule and starts a provider on it. */
export async function openLiveNote(
	o: Omit<ProviderOptions, 'ydoc' | 'epoch' | 'last' | 'checkpointSeq'>
): Promise<{ provider: NoteProvider; opened: OpenedDocument }> {
	const opened = await openDocument(seedApi(o.transport));
	const provider = new NoteProvider({
		...o,
		seeded: opened.seeded,
		ydoc: opened.ydoc,
		epoch: opened.epoch,
		last: opened.last,
		checkpointSeq: opened.checkpointSeq
	});
	return { provider, opened };
}
