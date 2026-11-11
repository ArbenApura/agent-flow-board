// @vitest-environment happy-dom
// SPIKE 4.1 (c) AND (d): A HAND WRITTEN PROVIDER WITH AWARENESS OVER A FAKE TRANSPORT, AND THE FIRST OPEN RULE

// -- DEP-MODULES -- //
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
// -- MODULES -- //
import { editorExtensions, markdownOfDoc } from './editorMarkdown.js';
import { LiveProvider, type LiveHandlers, type LiveTransport } from './liveProvider.js';
import { openDocument, type LiveSnapshot, type SeedApi } from './seed.js';

// -- FUNCTIONS -- //

/** A room that hands every message of one window to all the others. */
function room() {
	const members = new Set<LiveHandlers>();
	const join = (): LiveTransport => {
		let me: LiveHandlers | null = null;
		return {
			sendUpdate: (u) => members.forEach((m) => m !== me && m.update(u)),
			sendPresence: (p) => members.forEach((m) => m !== me && m.presence(p)),
			subscribe: (h) => {
				me = h;
				members.add(h);
				return () => members.delete(h);
			}
		};
	};
	return { join, size: () => members.size };
}

/** A server that keeps one epoch, its Markdown and its numbered updates, and applies the first open rule. */
function fakeServer(markdown: string) {
	const state = { epoch: 1, markdown, updates: [] as Uint8Array[], refused: 0 };
	const api: SeedApi = {
		load: async () => {
			const snap: LiveSnapshot = {
				epoch: state.epoch,
				markdown: state.markdown,
				updates: [...state.updates]
			};
			// Both windows read before either writes
			await new Promise((r) => setTimeout(r, 5));
			return snap;
		},
		seed: async (epoch, update) => {
			if (epoch !== state.epoch) {
				state.refused++;
				return { ok: false, reason: 'epoch' };
			}
			if (state.updates.length > 0) {
				state.refused++;
				return { ok: false, reason: 'taken' };
			}
			state.updates.push(update);
			return { ok: true };
		}
	};
	return { state, api };
}

function mount(ydoc: Y.Doc, transport: LiveTransport, name: string) {
	const provider = new LiveProvider(ydoc, transport);
	const editor = new Editor({
		element: document.createElement('div'),
		extensions: editorExtensions({ ydoc, provider, user: { name, color: 'currentColor' } })
	});
	return { provider, editor };
}

// -- TESTS -- //

describe('provider, awareness and the collaboration extensions over a fake transport (spike 4.1 c)', () => {
	it('carries typing and presence between two editors', async () => {
		const r = room();
		const a = mount(new Y.Doc(), r.join(), 'Ada');
		const b = mount(new Y.Doc(), r.join(), 'Bo');
		try {
			a.editor.commands.setContent('hello', { contentType: 'markdown' });
			// The editor writes into Yjs on its next tick
			await new Promise((res) => setTimeout(res, 20));
			expect(b.editor.getMarkdown().trim()).toBe('hello');
			// Presence: B hears A's user name
			a.provider.awareness.setLocalStateField('user', { name: 'Ada', color: 'currentColor' });
			const seen = [...b.provider.awareness.getStates().values()].map(
				(s) => (s as { user?: { name: string } }).user?.name
			);
			expect(seen).toContain('Ada');
			// The caret extension lists the same people for the "who is here" row
			const users = (b.editor.storage as unknown as Record<string, { users?: { name: string }[] }>)
				.collaborationCaret?.users;
			expect(users?.map((u) => u.name)).toContain('Ada');
			// Leaving removes the cursor
			a.provider.destroy();
			const left = [...b.provider.awareness.getStates().values()].map(
				(s) => (s as { user?: { name: string } }).user?.name
			);
			expect(left).not.toContain('Ada');
			expect(r.size()).toBe(1);
		} finally {
			a.editor.destroy();
			b.editor.destroy();
			b.provider.destroy();
		}
	});
});

describe('the first open rule (spike 4.1 d)', () => {
	const TEXT = '# Plan\n\n- one\n- two\n\nSome **bold** text.';

	it('keeps one copy of the text when two windows open at once', async () => {
		const { state, api } = fakeServer(TEXT);
		const [a, b] = await Promise.all([openDocument(api), openDocument(api)]);
		expect(a.seeded !== b.seeded).toBe(true);
		expect(state.updates.length).toBe(1);
		expect(state.refused).toBe(1);
		expect(markdownOfDoc(a.ydoc)).toBe(TEXT);
		expect(markdownOfDoc(b.ydoc)).toBe(TEXT);
		expect(Y.encodeStateAsUpdate(a.ydoc)).toEqual(Y.encodeStateAsUpdate(b.ydoc));
	});

	it('loads the winner when the note was seeded earlier', async () => {
		const { state, api } = fakeServer(TEXT);
		await openDocument(api);
		const late = await openDocument(api);
		expect(late.seeded).toBe(false);
		expect(state.updates.length).toBe(1);
		expect(markdownOfDoc(late.ydoc)).toBe(TEXT);
	});

	it('also holds after an epoch change', async () => {
		const { state, api } = fakeServer(TEXT);
		const first = await openDocument(api);
		// The text is replaced from outside: new epoch, the old updates are gone, a new Markdown
		state.epoch = 2;
		state.updates = [];
		state.markdown = '# Rewritten\n\nBy an agent.';
		const [a, b] = await Promise.all([openDocument(api), openDocument(api)]);
		expect(a.epoch).toBe(2);
		expect(b.epoch).toBe(2);
		expect(state.updates.length).toBe(1);
		expect(markdownOfDoc(a.ydoc)).toBe('# Rewritten\n\nBy an agent.');
		expect(markdownOfDoc(b.ydoc)).toBe('# Rewritten\n\nBy an agent.');
		// The window that was open on epoch 1 is told apart by its epoch and never writes into epoch 2
		expect(first.epoch).toBe(1);
	});

	it('survives an epoch change that lands between the read and the seed', async () => {
		const { state, api } = fakeServer(TEXT);
		const realSeed = api.seed;
		let bumped = false;
		api.seed = async (epoch, update) => {
			if (!bumped) {
				bumped = true;
				state.epoch = 2;
				state.markdown = 'Changed meanwhile.';
			}
			return realSeed(epoch, update);
		};
		const opened = await openDocument(api);
		expect(opened.epoch).toBe(2);
		expect(markdownOfDoc(opened.ydoc)).toBe('Changed meanwhile.');
		expect(state.updates.length).toBe(1);
	});
});
