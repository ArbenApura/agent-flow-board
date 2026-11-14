// @vitest-environment happy-dom
// THE NETWORK PROVIDER OF A NOTE OVER A FAKE SERVER AND A FAKE STREAM (AFB-20261111-0035, 8.3 TO 8.6)
// Nothing here touches a network: the "server" is a list of numbered updates in memory, and a notice is a function call.
// What this proves is the provider's own logic (order, gaps, throttles, queues, stops). It does not prove the real stream.

// IMPORTED DEP-MODULES
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAwarenessUpdate, outdatedTimeout } from 'y-protocols/awareness';
import * as Y from 'yjs';
// IMPORTED MODULES
import { markdownOfDoc } from '../board/notes/editorMarkdown';
import {
	CHECKPOINT_MS,
	NoteProvider,
	POST_MS,
	PRESENCE_MS,
	TransportError,
	liveLine,
	openLiveNote,
	peersOf,
	toBase64,
	type FailureKind,
	type NoteTransport,
	type Peer,
	type PostReply
} from './noteProvider';
import type { NoteLiveNotice } from './stream.svelte';

// -- TYPES -- //

interface Client {
	transport: NoteTransport;
	listen: (fn: (n: NoteLiveNotice) => void) => () => void;
	/** The connection fails with this kind while set. */
	fail: FailureKind | null;
	/** Notices to this client are lost while set. */
	dropIn: boolean;
	/** Presence this client sends is lost while set. */
	dropOutPresence: boolean;
	fire: (n: NoteLiveNotice) => void;
}

// -- FUNCTIONS -- //

const NOTE = 'note-1';

/** One note on a server: an epoch, its Markdown, numbered updates and a checkpoint. */
class FakeServer {
	epoch = 1;
	markdown: string;
	updates: { seq: number; bytes: Uint8Array }[] = [];
	seq = 0;
	checkpointSeq = 0;
	body: string;
	postCalls: { seed: boolean; count: number }[] = [];
	checkpointCalls: { sequence: number; body: string }[] = [];
	presenceCalls = 0;
	clients: Client[] = [];

	constructor(markdown = '') {
		this.markdown = this.body = markdown;
	}

	/** A text typed in a scratch document, stored as the next update. */
	seedText(text: string) {
		const d = new Y.Doc();
		let bytes: Uint8Array = new Uint8Array();
		d.on('update', (u: Uint8Array) => (bytes = u));
		d.getText('t').insert(0, text);
		this.updates.push({ seq: ++this.seq, bytes });
	}

	/** The text from outside: a new epoch, no updates, a new Markdown. */
	replace(markdown: string) {
		this.epoch++;
		this.updates = [];
		this.seq = 0;
		this.checkpointSeq = 0;
		this.markdown = this.body = markdown;
	}

	private notify(n: NoteLiveNotice, from?: Client) {
		for (const c of this.clients) if (!c.dropIn && c !== from) c.fire(n);
	}

	client(): Client {
		const listeners = new Set<(n: NoteLiveNotice) => void>();
		const check = () => {
			if (c.fail) throw new TransportError(c.fail);
		};
		const c: Client = {
			fail: null,
			dropIn: false,
			dropOutPresence: false,
			fire: (n) => listeners.forEach((l) => l(n)),
			listen: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			transport: {
				read: async (after) => {
					check();
					return {
						epoch: this.epoch,
						markdown: this.markdown,
						last: this.seq,
						checkpointSeq: this.checkpointSeq,
						updates: this.updates
							.filter((u) => u.seq > after)
							.map((u) => ({ seq: u.seq, update: u.bytes }))
					};
				},
				post: async (epoch, updates, opts): Promise<PostReply> => {
					check();
					this.postCalls.push({ seed: !!opts?.seed, count: updates.length });
					if (epoch !== this.epoch) return { ok: false, reason: 'epoch', epoch: this.epoch };
					if (opts?.seed && this.seq > 0) return { ok: false, reason: 'taken', epoch: this.epoch };
					const seqs = updates.map((bytes) => {
						this.updates.push({ seq: ++this.seq, bytes });
						return this.seq;
					});
					// The sender hears its own notice as well, as on the real stream
					this.notify({ kind: 'note', note: NOTE, epoch: this.epoch, seq: this.seq });
					c.fire({ kind: 'note', note: NOTE, epoch: this.epoch, seq: this.seq });
					return { ok: true, epoch: this.epoch, seqs, last: this.seq };
				},
				checkpoint: async (req) => {
					check();
					this.checkpointCalls.push({ sequence: req.sequence, body: req.body });
					if (req.epoch !== this.epoch)
						return {
							ok: false,
							reason: 'epoch',
							epoch: this.epoch,
							checkpointSeq: this.checkpointSeq
						};
					if (req.sequence <= this.checkpointSeq)
						return {
							ok: false,
							reason: 'old',
							epoch: this.epoch,
							checkpointSeq: this.checkpointSeq
						};
					this.checkpointSeq = req.sequence;
					this.body = req.body;
					return { ok: true, epoch: this.epoch, sequence: req.sequence };
				},
				presence: async (data) => {
					check();
					this.presenceCalls++;
					if (c.dropOutPresence) return;
					const n: NoteLiveNotice = {
						kind: 'presence',
						note: NOTE,
						epoch: this.epoch,
						data: toBase64(data)
					};
					this.notify(n);
				}
			}
		};
		this.clients.push(c);
		return c;
	}
}

interface Joined {
	p: NoteProvider;
	doc: Y.Doc;
	client: Client;
	peers: Peer[][];
	statuses: string[];
	epochs: number[];
	gone: number;
	text: () => string;
	type: (at: number, s: string) => void;
}

/** A window opened on the server's current state. */
function join(server: FakeServer, id: string, name: string, title = 'Title'): Joined {
	const client = server.client();
	const doc = new Y.Doc();
	for (const u of server.updates) Y.applyUpdate(doc, u.bytes);
	const j: Joined = {
		doc,
		client,
		peers: [],
		statuses: [],
		epochs: [],
		gone: 0,
		text: () => doc.getText('t').toString(),
		type: (at, s) => doc.getText('t').insert(at, s),
		p: undefined as unknown as NoteProvider
	};
	j.p = new NoteProvider({
		noteId: NOTE,
		ydoc: doc,
		epoch: server.epoch,
		last: server.seq,
		checkpointSeq: server.checkpointSeq,
		transport: client.transport,
		listen: client.listen,
		markdown: () => doc.getText('t').toString(),
		title: () => title,
		user: { id, name },
		onStatus: (s) => j.statuses.push(s),
		onEpoch: (e) => j.epochs.push(e),
		onGone: () => j.gone++,
		onPeers: (p) => j.peers.push(p)
	});
	return j;
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('the note provider over a fake server', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('two providers converge, in both directions, with typing at the same moment', async () => {
		const s = new FakeServer('hello');
		s.seedText('hello');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		a.type(5, ' from A');
		b.type(0, 'B says: ');
		await tick(POST_MS + 50);
		expect(a.text()).toBe(b.text());
		expect(a.text()).toContain('from A');
		expect(a.text()).toContain('B says: ');
		a.type(a.text().length, '!');
		await tick(POST_MS + 50);
		expect(b.text()).toBe(a.text());
		a.p.destroy();
		b.p.destroy();
	});

	it('posts at most every 300 ms and merges a burst into one call', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		for (let i = 0; i < 5; i++) a.type(0, String(i));
		await tick(POST_MS - 10);
		expect(s.postCalls).toHaveLength(0);
		await tick(20);
		expect(s.postCalls).toEqual([{ seed: false, count: 1 }]);
		a.type(0, 'z');
		await tick(POST_MS - 10);
		expect(s.postCalls).toHaveLength(1);
		await tick(20);
		expect(s.postCalls).toHaveLength(2);
		a.p.destroy();
	});

	it('does not send an update that came from the server back to it', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		a.type(1, 'y');
		await tick(POST_MS + 200);
		// B applied the update from the server and posted nothing of its own
		expect(b.text()).toBe('xy');
		expect(s.postCalls).toEqual([{ seed: false, count: 1 }]);
		expect(s.updates).toHaveLength(2);
		expect(a.p.last).toBe(2);
		expect(b.p.last).toBe(2);
		b.p.destroy();
		a.p.destroy();
	});

	it('a dropped notice is recovered by the gap read of the next one', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		b.client.dropIn = true;
		a.type(1, 'A');
		await tick(POST_MS + 50);
		expect(b.text()).toBe('x');
		b.client.dropIn = false;
		a.type(2, 'B');
		await tick(POST_MS + 50);
		// The second notice names number 3 and B holds 1: it reads after 1 and gets both
		expect(b.text()).toBe(a.text());
		expect(b.p.last).toBe(3);
		a.p.destroy();
		b.p.destroy();
	});

	it('catches up by number after the stream reconnects, when the last notice was lost', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		b.client.dropIn = true;
		a.type(1, 'A');
		await tick(POST_MS + 50);
		expect(b.text()).toBe('x');
		b.client.dropIn = false;
		b.client.fire({ kind: 'reconnected' });
		await tick(10);
		expect(b.text()).toBe('xA');
		a.p.destroy();
		b.p.destroy();
	});

	it('ignores notices of other notes and of older epochs', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const read = vi.spyOn(a.client.transport, 'read');
		a.client.fire({ kind: 'note', note: 'other', epoch: 1, seq: 9 });
		a.client.fire({ kind: 'note', note: NOTE, epoch: 0, seq: 9 });
		await tick(10);
		expect(read).not.toHaveBeenCalled();
		a.p.destroy();
	});

	it('two windows opening the same untouched note end with one copy', async () => {
		const TEXT = '# Plan\n\n- one\n- two\n\nSome **bold** text.';
		const s = new FakeServer(TEXT);
		const open = async () => {
			const c = s.client();
			const made = await openLiveNote({
				noteId: NOTE,
				transport: c.transport,
				listen: c.listen,
				markdown: () => '',
				title: () => 'T',
				user: { id: 'u', name: 'U' }
			});
			return made;
		};
		const [a, b] = await Promise.all([open(), open()]);
		expect(s.updates).toHaveLength(1);
		expect(s.postCalls.filter((c) => c.seed)).toHaveLength(2);
		expect(a.opened.seeded !== b.opened.seeded).toBe(true);
		expect(markdownOfDoc(a.provider.ydoc)).toBe(TEXT);
		expect(markdownOfDoc(b.provider.ydoc)).toBe(TEXT);
		expect(Y.encodeStateAsUpdate(a.provider.ydoc)).toEqual(Y.encodeStateAsUpdate(b.provider.ydoc));
		a.provider.destroy();
		b.provider.destroy();
	});

	it('saves a checkpoint 2 seconds after the last change, only for a newer number, and not before the queue is sent', async () => {
		const s = new FakeServer();
		s.seedText('x');
		s.checkpointSeq = 1;
		const a = join(s, 'u1', 'Ada');
		a.type(1, 'y');
		await tick(POST_MS + 50);
		expect(s.checkpointCalls).toHaveLength(0);
		a.type(2, 'z');
		await tick(CHECKPOINT_MS - 100);
		expect(s.checkpointCalls).toHaveLength(0);
		await tick(POST_MS + 200);
		expect(s.checkpointCalls).toEqual([{ sequence: s.seq, body: 'xyz' }]);
		expect(s.body).toBe('xyz');
		expect(a.p.checkpointSeq).toBe(s.seq);
		await tick(10_000);
		expect(s.checkpointCalls).toHaveLength(1);
		expect(a.statuses.at(-1)).toBe('saved');
		a.p.destroy();
	});

	it('opening a note whose checkpoint is behind saves one', async () => {
		const s = new FakeServer();
		s.seedText('abc');
		s.markdown = s.body = 'old';
		const a = join(s, 'u1', 'Ada');
		await tick(CHECKPOINT_MS + 100);
		expect(s.checkpointCalls).toEqual([{ sequence: 1, body: 'abc' }]);
		a.p.destroy();
	});

	it('a checkpoint after a catch-up covers the numbers read, and a second window is told old', async () => {
		const s = new FakeServer();
		s.seedText('x');
		s.checkpointSeq = 1;
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		a.type(1, 'A');
		await tick(POST_MS + 50);
		// B read the update and both want a checkpoint of number 2; the server takes one
		await tick(CHECKPOINT_MS + 300);
		expect(s.checkpointSeq).toBe(2);
		expect(s.body).toBe('xA');
		expect(s.checkpointCalls.every((c) => c.sequence === 2)).toBe(true);
		expect(a.p.checkpointSeq).toBe(2);
		expect(b.p.checkpointSeq).toBe(2);
		a.p.destroy();
		b.p.destroy();
	});

	it('keeps changes while offline, shows it, and sends them in one go in order when back', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		a.client.fail = 'offline';
		a.type(1, '1');
		await tick(POST_MS + 50);
		a.type(2, '2');
		await tick(POST_MS + 50);
		a.type(3, '3');
		await tick(5000);
		expect(a.p.status).toBe('offline');
		expect(a.p.unsent).toBe(true);
		expect(s.updates).toHaveLength(1);
		expect(liveLine('offline')).toMatch(/kept/);
		a.client.fail = null;
		a.p.reconnect();
		await tick(POST_MS + 100);
		expect(a.p.unsent).toBe(false);
		expect(b.text()).toBe('x123');
		expect(a.statuses).toContain('offline');
		expect(a.p.status).not.toBe('offline');
		a.p.destroy();
		b.p.destroy();
	});

	it('picks up what others wrote while it was offline, before and with its own changes', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		a.client.fail = 'offline';
		a.client.dropIn = true;
		a.type(1, 'A');
		await tick(POST_MS + 50);
		b.type(1, 'B');
		await tick(POST_MS + 50);
		a.client.fail = null;
		a.client.dropIn = false;
		a.p.reconnect();
		await tick(2000);
		expect(a.text()).toBe(b.text());
		expect(a.text()).toContain('A');
		expect(a.text()).toContain('B');
		a.p.destroy();
		b.p.destroy();
	});

	it('refuses more typing for a note over its live limit, and says why', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		a.client.fail = 'full';
		a.type(1, 'a');
		await tick(POST_MS + 50);
		expect(a.p.status).toBe('full');
		expect(liveLine('full')).toMatch(/too much unsaved live text/);
		a.client.fail = null;
		const before = s.postCalls.length;
		a.type(2, 'b');
		await tick(5000);
		expect(s.postCalls.length).toBe(before);
		a.p.destroy();
	});

	it('stops for good when the person lost access, and sends nothing more', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		a.client.fail = 'gone';
		a.type(1, 'a');
		await tick(POST_MS + 50);
		expect(a.gone).toBe(1);
		expect(a.p.status).toBe('stopped');
		a.client.fail = null;
		const posts = s.postCalls.length;
		a.type(2, 'b');
		a.client.fire({ kind: 'note', note: NOTE, epoch: 1, seq: 99 });
		await tick(10_000);
		expect(s.postCalls.length).toBe(posts);
		expect(s.checkpointCalls).toHaveLength(0);
		a.p.destroy();
	});

	it('an update and a checkpoint of an old epoch are refused, and the provider stops and reports the new epoch', async () => {
		const s = new FakeServer('old');
		s.seedText('old');
		const a = join(s, 'u1', 'Ada');
		s.replace('from an agent');
		a.type(3, ' typed');
		await tick(POST_MS + 50);
		expect(a.epochs).toEqual([2]);
		expect(a.p.status).toBe('stopped');
		expect(s.updates).toHaveLength(0);
		// The text on screen is still there for the person to copy
		expect(a.text()).toBe('old typed');
		expect(s.body).toBe('from an agent');
		const b = join(s, 'u2', 'Bo');
		b.p.destroy();
		a.p.destroy();
	});

	it('a notice with a newer epoch stops the provider at once', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		a.client.fire({ kind: 'note', note: NOTE, epoch: 3, seq: 1 });
		expect(a.epochs).toEqual([3]);
		a.p.destroy();
	});

	it('two open windows end with one copy of the replaced text', async () => {
		const s = new FakeServer('first');
		s.seedText('first');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		a.type(5, ' and more');
		await tick(POST_MS + 50);
		s.replace('# New\n\nWritten by an agent.');
		// Both hear about the new epoch (the notice or the first refused call) and reopen under the first open rule
		a.client.fire({ kind: 'note', note: NOTE, epoch: 2, seq: 0 });
		b.client.fire({ kind: 'note', note: NOTE, epoch: 2, seq: 0 });
		expect(a.epochs).toEqual([2]);
		expect(b.epochs).toEqual([2]);
		const mine = a.text();
		expect(mine).toBe('first and more');
		a.p.destroy();
		b.p.destroy();
		const reopen = async () => {
			const c = s.client();
			return openLiveNote({
				noteId: NOTE,
				transport: c.transport,
				listen: c.listen,
				markdown: () => '',
				title: () => 'T',
				user: { id: 'u', name: 'U' }
			});
		};
		const [a2, b2] = await Promise.all([reopen(), reopen()]);
		expect(s.updates).toHaveLength(1);
		expect(markdownOfDoc(a2.provider.ydoc)).toBe('# New\n\nWritten by an agent.');
		expect(markdownOfDoc(b2.provider.ydoc)).toBe('# New\n\nWritten by an agent.');
		a2.provider.destroy();
		b2.provider.destroy();
	});

	it('leave posts what waits and tries the checkpoint with calls that outlive the page', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const post = vi.spyOn(a.client.transport, 'post');
		a.type(1, 'y');
		a.p.leave();
		expect(post).toHaveBeenCalledWith(1, expect.any(Array), { keepalive: true });
		await tick(10);
		expect(s.updates).toHaveLength(2);
		const cp = vi.spyOn(a.client.transport, 'checkpoint');
		a.p.leave();
		expect(cp).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2, body: 'xy' }), {
			keepalive: true
		});
		a.p.destroy();
	});
});

describe('large changes, sizes and a freshly opened note', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('splits a queue of large updates into posts under the limit and delivers all of it', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		for (let i = 0; i < 3; i++) a.type(0, String(i).repeat(150 * 1024));
		await tick(POST_MS + 50);
		expect(s.postCalls).toEqual([{ seed: false, count: 3 }]);
		expect(s.updates).toHaveLength(4);
		expect(Math.max(...s.updates.map((u) => u.bytes.byteLength))).toBeLessThan(256 * 1024);
		expect(a.p.unsent).toBe(false);
		a.p.destroy();
	});

	it('a change the server can never take stops the retries and says so', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		a.client.fail = 'size';
		a.type(0, 'y');
		await tick(POST_MS + 50);
		expect(a.p.status).toBe('toolarge');
		const calls = s.postCalls.length;
		await tick(60_000);
		expect(s.postCalls.length).toBe(calls);
		expect(liveLine('toolarge')).not.toContain('Could not reach');
		a.p.destroy();
	});

	it('refuses a single update over the server limit instead of retrying it', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		a.type(0, 'z'.repeat(300 * 1024));
		await tick(POST_MS + 50);
		expect(a.p.status).toBe('toolarge');
		expect(s.postCalls).toHaveLength(0);
		a.p.destroy();
	});

	it('a note too large to seed is not opened, and nothing is written', async () => {
		const s = new FakeServer('x'.repeat(300 * 1024));
		const c = s.client();
		await expect(
			openLiveNote({
				noteId: NOTE,
				transport: c.transport,
				listen: c.listen,
				markdown: () => '',
				title: () => undefined,
				user: { id: 'u', name: 'U' }
			})
		).rejects.toThrow(/too long to open/);
		expect(s.updates).toHaveLength(0);
	});

	it('opening a note does not rewrite its body; the first local edit does', async () => {
		const s = new FakeServer('# Hello');
		const c = s.client();
		const made = await openLiveNote({
			noteId: NOTE,
			transport: c.transport,
			listen: c.listen,
			markdown: () => 'edited',
			title: () => undefined,
			user: { id: 'u', name: 'U' }
		});
		expect(made.opened.seeded).toBe(true);
		await tick(CHECKPOINT_MS * 3);
		expect(s.checkpointCalls).toHaveLength(0);
		expect(made.provider.status).toBe('saved');
		made.provider.ydoc.getText('t').insert(0, 'a');
		await tick(POST_MS + CHECKPOINT_MS + 100);
		expect(s.checkpointCalls).toHaveLength(1);
		made.provider.destroy();
	});

	it('a checkpoint carries a title only when the page gives one', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const cp = vi.spyOn(a.client.transport, 'checkpoint');
		a.p['o'].title = () => undefined;
		a.type(1, 'y');
		await tick(POST_MS + CHECKPOINT_MS + 100);
		expect(cp).toHaveBeenCalledTimes(1);
		expect(cp.mock.calls[0][0]).not.toHaveProperty('title');
		a.p.destroy();
	});
});

describe('leaving with a failing call', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('keeps the queue when the call fails, and a later flush sends it', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		a.type(1, 'y');
		expect(a.p.unsent).toBe(true);
		a.client.fail = 'offline';
		a.p.leave();
		await tick(10);
		expect(a.p.unsent).toBe(true);
		expect(s.updates).toHaveLength(1);
		a.client.fail = null;
		await a.p.flush();
		expect(s.updates).toHaveLength(2);
		expect(a.p.unsent).toBe(false);
		a.p.destroy();
	});
});

describe('presence', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('shows who has the note open, one avatar per person, and removes them on leaving', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		const b2 = join(s, 'u2', 'Bo');
		await tick(100);
		expect(a.peers.at(-1)).toEqual([{ id: 'u2', name: 'Bo' }]);
		expect(b.peers.at(-1)).toEqual([{ id: 'u1', name: 'Ada' }]);
		b2.p.destroy();
		await tick(100);
		// One window of Bo is still there
		expect(a.peers.at(-1)).toEqual([{ id: 'u2', name: 'Bo' }]);
		b.p.destroy();
		await tick(100);
		expect(a.peers.at(-1)).toEqual([]);
		a.p.destroy();
	});

	it('sends the cursor at most every 2 seconds while it moves', async () => {
		const s = new FakeServer();
		s.seedText('abcdef');
		const a = join(s, 'u1', 'Ada');
		await tick(100);
		const joined = s.presenceCalls;
		expect(joined).toBeGreaterThanOrEqual(1);
		for (let i = 0; i < 10; i++) {
			a.p.live.awareness.setLocalStateField('cursor', { anchor: i, head: i });
			await tick(100);
		}
		// A second of moving: nothing more than the one message the throttle allows
		expect(s.presenceCalls - joined).toBeLessThanOrEqual(1);
		await tick(PRESENCE_MS + 100);
		const later = s.presenceCalls;
		for (let i = 0; i < 40; i++) {
			a.p.live.awareness.setLocalStateField('cursor', { anchor: i, head: i });
			await tick(100);
		}
		// Four seconds of moving, never more than one message in two seconds
		expect(s.presenceCalls - later).toBeLessThanOrEqual(3);
		a.p.destroy();
	});

	it('a window that goes quiet is gone for the others 30 seconds after its last message', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const b = join(s, 'u2', 'Bo');
		await tick(500);
		expect(b.peers.at(-1)).toEqual([{ id: 'u1', name: 'Ada' }]);
		// Ada's messages stop arriving (a crashed tab): Bo hears nothing more
		a.client.dropOutPresence = true;
		const awareness = b.p.live.awareness;
		expect(outdatedTimeout).toBe(30_000);
		// y-protocols reads the real clock (lib0 keeps the original Date.now), so the clock of Ada's last message is moved back
		const meta = awareness.meta.get(a.doc.clientID);
		expect(meta).toBeDefined();
		if (meta) meta.lastUpdated -= 29_000;
		await tick(6000);
		expect(b.peers.at(-1)).toEqual([{ id: 'u1', name: 'Ada' }]);
		if (meta) meta.lastUpdated -= 2000;
		await tick(6000);
		expect(b.peers.at(-1)).toEqual([]);
		a.p.destroy();
		b.p.destroy();
	});

	it('keeps a message far under 1 KB and uses one token colour', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const long = 'N'.repeat(500);
		const a = join(s, 'u1', long);
		const sizes: number[] = [];
		const orig = a.client.transport.presence;
		a.client.transport.presence = async (d, o) => {
			sizes.push(d.byteLength);
			return orig(d, o);
		};
		a.p.live.awareness.setLocalStateField('cursor', { anchor: 1, head: 1 });
		await tick(PRESENCE_MS + 100);
		expect(sizes.length).toBeGreaterThan(0);
		for (const n of sizes) expect(n).toBeLessThan(1024);
		const me = a.p.live.awareness.getLocalState() as { user: { color: string; name: string } };
		expect(me.user.color).toBe('var(--ink)');
		expect(me.user.name.length).toBe(60);
		a.p.destroy();
	});

	it('presence of another note or another epoch is not applied', async () => {
		const s = new FakeServer();
		s.seedText('x');
		const a = join(s, 'u1', 'Ada');
		const other = join(new FakeServer('y'), 'u9', 'Zed');
		await tick(200);
		const data = toBase64(
			// Zed's own join message, taken from his provider's awareness
			encodeAwarenessUpdate(other.p.live.awareness, [other.doc.clientID])
		);
		a.client.fire({ kind: 'presence', note: 'elsewhere', epoch: 1, data });
		a.client.fire({ kind: 'presence', note: NOTE, epoch: 0, data });
		await tick(100);
		expect(peersOf(a.p.live.awareness.getStates(), 'u1')).toEqual([]);
		a.client.fire({ kind: 'presence', note: NOTE, epoch: 1, data });
		await tick(100);
		expect(peersOf(a.p.live.awareness.getStates(), 'u1')).toEqual([{ id: 'u9', name: 'Zed' }]);
		a.p.destroy();
		other.p.destroy();
	});
});

describe('peersOf', () => {
	it('lists each other person once and skips the person themself', () => {
		const states = new Map<number, unknown>([
			[1, { user: { id: 'me', name: 'Me' } }],
			[2, { user: { id: 'u2', name: 'Bo' } }],
			[3, { user: { id: 'u2', name: 'Bo' } }],
			[4, { user: { id: 'u3', name: 'Ada' } }],
			[5, {}],
			[6, null]
		]);
		expect(peersOf(states, 'me')).toEqual([
			{ id: 'u3', name: 'Ada' },
			{ id: 'u2', name: 'Bo' }
		]);
	});
});
