// THE LINKS OF A NOTE: THE SECTIONS, WHAT CAN BE REMOVED, WHERE A LINK GOES, WHAT THE PICKER OFFERS AND THE CALLS

// -- DEP-MODULES -- //
import { describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import {
	addLink,
	canRemove,
	fetchLinkedNotes,
	fetchLinks,
	groupLinks,
	linkHref,
	noteHref,
	offerTargets,
	removeLink,
	searchTargets,
	staysInText,
	type Call,
	type NoteLink,
	type Target
} from './links.js';

// -- CONSTANTS -- //

const link = (over: Partial<NoteLink>): NoteLink => ({
	kind: 'item',
	id: 'i1',
	ref: 'AFB-1',
	title: 'A plan',
	sources: ['panel'],
	...over
});

// -- FUNCTIONS -- //

describe('groupLinks', () => {
	it('orders the sections plans, tasks, mockups, notes and leaves empty ones out', () => {
		const groups = groupLinks([
			link({ kind: 'note', id: 'n1', ref: 'N-1' }),
			link({ kind: 'mockup', id: 'm1', ref: null }),
			link({ kind: 'item' })
		]);
		expect(groups.map((g) => g.label)).toEqual(['Plans', 'Mockups', 'Notes it links to']);
	});

	it('is empty when there are no links', () => {
		expect(groupLinks([])).toEqual([]);
	});

	it('keeps the order of the links inside a section', () => {
		const groups = groupLinks([link({ id: 'a' }), link({ id: 'b' })]);
		expect(groups[0].links.map((l) => l.id)).toEqual(['a', 'b']);
	});
});

describe('canRemove', () => {
	it('allows a panel link, also one that is in the text too', () => {
		expect(canRemove(link({ sources: ['panel'] }))).toBe(true);
		expect(canRemove(link({ sources: ['panel', 'text'] }))).toBe(true);
		expect(staysInText(link({ sources: ['panel', 'text'] }))).toBe(true);
		expect(staysInText(link({ sources: ['panel'] }))).toBe(false);
	});

	it('refuses a link that is only in the text', () => {
		expect(canRemove(link({ sources: ['text'] }))).toBe(false);
	});
});

describe('linkHref', () => {
	it('points each kind at its page', () => {
		const base = '/arbenger/AFB';
		expect(linkHref(base, link({}))).toBe('/arbenger/AFB/AFB-1');
		expect(linkHref(base, link({ kind: 'task', id: 't-id', ref: 'T-4' }))).toBe(
			'/arbenger/AFB/tasks?task=t-id'
		);
		expect(linkHref(base, link({ kind: 'mockup', id: 'm-id', ref: null }))).toBe(
			'/arbenger/AFB/mockups/m-id'
		);
		expect(linkHref(base, link({ kind: 'note', id: 'n', ref: 'N-12' }))).toBe(
			'/arbenger/AFB/notes/N-12'
		);
		expect(noteHref(base, { ref: 'N-3' })).toBe('/arbenger/AFB/notes/N-3');
	});
});

describe('offerTargets', () => {
	const targets: Target[] = [
		{ kind: 'item', id: 'i1', ref: 'AFB-1', title: 'Plan' },
		{ kind: 'note', id: 'n1', ref: 'N-1', title: 'Self' },
		{ kind: 'note', id: 'n2', ref: 'N-2', title: 'Other' },
		{ kind: 'task', id: 't1', ref: 'T-1', title: 'Task' }
	];

	it('drops the note itself and what is already linked', () => {
		const got = offerTargets(targets, { selfId: 'n1', linked: [{ kind: 'item', id: 'i1' }] });
		expect(got.map((t) => t.id)).toEqual(['n2', 't1']);
	});

	it('keeps only the kinds asked for, in the order of the search', () => {
		expect(offerTargets(targets, { kinds: ['note'] }).map((t) => t.id)).toEqual(['n1', 'n2']);
	});

	it('does not mistake an id of another kind for a linked one', () => {
		const got = offerTargets(targets, { linked: [{ kind: 'task', id: 'n2' }] });
		expect(got).toHaveLength(4);
	});
});

describe('calls', () => {
	const fake = (answer: unknown = {}) => {
		const fn = vi.fn(async () => answer);
		return { fn, call: fn as unknown as Call };
	};

	it('reads the links and fills the lists that are missing', async () => {
		const { fn, call } = fake({ links: [link({})] });
		const got = await fetchLinks(call, 'o', 'AFB', 'N-1');
		expect(fn).toHaveBeenCalledWith('o', '/projects/AFB/notes/N-1/links');
		expect(got.links).toHaveLength(1);
		expect(got.mentionedBy).toEqual([]);
	});

	it('adds a link by reference, and a mockup by id', async () => {
		const { fn, call } = fake();
		await addLink(call, 'o', 'AFB', 'N-1', { kind: 'task', id: 'x', ref: 'T-4', title: 't' });
		expect(fn).toHaveBeenLastCalledWith('o', '/projects/AFB/notes/N-1/links', {
			method: 'POST',
			body: { targetKind: 'task', target: 'T-4' }
		});
		await addLink(call, 'o', 'AFB', 'N-1', { kind: 'mockup', id: 'mid', ref: null, title: 'm' });
		expect(fn).toHaveBeenLastCalledWith('o', '/projects/AFB/notes/N-1/links', {
			method: 'POST',
			body: { targetKind: 'mockup', target: 'mid' }
		});
	});

	it('removes a link with the kind and the name in the query', async () => {
		const { fn, call } = fake();
		await removeLink(call, 'o', 'AFB', 'N-1', { kind: 'item', id: 'i', ref: 'AFB-20261107-0346' });
		expect(fn).toHaveBeenCalledWith(
			'o',
			'/projects/AFB/notes/N-1/links?targetKind=item&target=AFB-20261107-0346',
			{ method: 'DELETE' }
		);
	});

	it('reads the notes linked to a target and searches the targets', async () => {
		const a = fake({ notes: [{ id: 'n', ref: 'N-1', title: 'T' }] });
		expect(
			await fetchLinkedNotes(a.call, 'o', 'AFB', { kind: 'item', name: 'AFB-1' })
		).toHaveLength(1);
		expect(a.fn).toHaveBeenCalledWith('o', '/projects/AFB/notes/linked-to?kind=item&target=AFB-1');
		const b = fake({});
		expect(await fetchLinkedNotes(b.call, 'o', 'AFB', { kind: 'mockup', name: 'x' })).toEqual([]);
		const c = fake({ targets: [] });
		await searchTargets(c.call, 'o', 'AFB', 'a b&c');
		expect(c.fn).toHaveBeenCalledWith('o', '/projects/AFB/notes/link-targets?q=a%20b%26c');
	});

	it('lets a failure through so the screen can show it', async () => {
		const call: Call = async () => {
			throw new Error('down');
		};
		await expect(fetchLinks(call, 'o', 'AFB', 'N-1')).rejects.toThrow('down');
	});
});
