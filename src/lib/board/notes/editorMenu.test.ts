// @vitest-environment happy-dom
// THE SLASH MENU AND THE LINK MENU: WHAT OPENS THEM, THEIR ROWS AND KEYS, THE LINKS THEY WRITE, AND THE PLUGIN THAT REPORTS TYPING (AFB-20261111-0035, STEP 4.4)

// IMPORTED DEP-MODULES
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
// IMPORTED MODULES
import { editorExtensions, toMarkdown } from './editorMarkdown.js';
import {
	LinkSearch,
	SLASH_ITEMS,
	filterSlash,
	hrefOf,
	insertLink,
	keyAction,
	linkMarkdown,
	optionId,
	parseTrigger,
	runSlash,
	stepIndex,
	type LinkTarget
} from './editorMenu.js';
import { EditorMenu, dismissMenu, type MenuUpdate } from './editorMenuPlugin.js';

// -- FUNCTIONS -- //

const opened: Editor[] = [];

function open(markdown = '') {
	const updates: (MenuUpdate | null)[] = [];
	const keys: string[] = [];
	let swallow = false;
	const editor = new Editor({
		element: document.createElement('div'),
		extensions: [
			...editorExtensions({ ydoc: new Y.Doc() }),
			EditorMenu.configure({
				onUpdate: (u) => updates.push(u),
				onKey: (e) => {
					keys.push(e.key);
					return swallow;
				}
			})
		]
	});
	if (markdown)
		editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
	opened.push(editor);
	return {
		editor,
		updates,
		keys,
		swallow: (v: boolean) => (swallow = v),
		last: () => updates[updates.length - 1]
	};
}

const target = (over: Partial<LinkTarget> = {}): LinkTarget => ({
	kind: 'note',
	id: '3f2c9a1e-0000-4000-8000-000000000001',
	ref: 'N-12',
	title: 'Launch notes',
	...over
});

afterEach(() => {
	while (opened.length) opened.pop()?.destroy();
});

// -- TESTS -- //

describe('parseTrigger', () => {
	it('opens the slash menu at the start of a block and after a space', () => {
		expect(parseTrigger('/')).toEqual({ kind: 'slash', query: '', start: 0 });
		expect(parseTrigger('/he')).toEqual({ kind: 'slash', query: 'he', start: 0 });
		expect(parseTrigger('some text /tab')).toEqual({ kind: 'slash', query: 'tab', start: 10 });
	});

	it('does not open inside a path, a word or a url', () => {
		expect(parseTrigger('and/or')).toBeNull();
		expect(parseTrigger('see https://a.com/x')).toBeNull();
		expect(parseTrigger('a/b')).toBeNull();
	});

	it('closes the slash menu on a space', () => {
		expect(parseTrigger('/head ')).toBeNull();
		expect(parseTrigger('/head x')).toBeNull();
	});

	it('opens the link menu on an at sign or on [[', () => {
		expect(parseTrigger('@')).toEqual({ kind: 'link', query: '', start: 0 });
		expect(parseTrigger('see @launch')).toEqual({ kind: 'link', query: 'launch', start: 4 });
		expect(parseTrigger('see [[launch no')).toEqual({ kind: 'link', query: 'launch no', start: 4 });
	});

	it('never takes a mail address for a link menu', () => {
		expect(parseTrigger('mail me@home')).toBeNull();
	});

	it('closes the @ menu on a space and the [[ menu on a closing bracket', () => {
		expect(parseTrigger('@launch ')).toBeNull();
		expect(parseTrigger('[[launch]]')).toBeNull();
		expect(parseTrigger('[[launch]')).toBeNull();
	});
});

describe('slash rows', () => {
	it('lists every block with no word and filters by name or keyword', () => {
		expect(filterSlash('')).toHaveLength(SLASH_ITEMS.length);
		expect(filterSlash('head').map((i) => i.id)).toEqual(['h1', 'h2', 'h3']);
		expect(filterSlash('todo').map((i) => i.id)).toEqual(['task']);
		expect(filterSlash('image').map((i) => i.id)).toEqual(['picture']);
		expect(filterSlash('zzz')).toEqual([]);
	});

	it('puts names that start with the word before names that only contain it', () => {
		const ids = filterSlash('list').map((i) => i.id);
		expect(ids.slice(0, 3)).toEqual(['bullet', 'ordered', 'task']);
	});
});

describe('keys', () => {
	it('moves, wraps, picks and closes', () => {
		expect(keyAction({ key: 'ArrowDown' }, 3)).toBe('next');
		expect(keyAction({ key: 'ArrowUp' }, 3)).toBe('prev');
		expect(keyAction({ key: 'Enter' }, 3)).toBe('pick');
		expect(keyAction({ key: 'Tab' }, 3)).toBe('pick');
		expect(keyAction({ key: 'Escape' }, 0)).toBe('close');
		expect(stepIndex(0, 3, -1)).toBe(2);
		expect(stepIndex(2, 3, 1)).toBe(0);
		expect(stepIndex(0, 0, 1)).toBe(0);
	});

	it('leaves Enter, Tab and the arrows to the editor when there is no row, and shortcuts always', () => {
		expect(keyAction({ key: 'Enter' }, 0)).toBeNull();
		expect(keyAction({ key: 'ArrowDown' }, 0)).toBeNull();
		expect(keyAction({ key: 'Enter', shiftKey: true }, 3)).toBeNull();
		expect(keyAction({ key: 'Enter', ctrlKey: true }, 3)).toBeNull();
		expect(keyAction({ key: 'a' }, 3)).toBeNull();
	});

	it('names an option by menu and place', () => {
		expect(optionId('m', 2)).toBe('m-opt-2');
	});
});

describe('link text', () => {
	it('writes the address of each kind in the form the renderer knows', () => {
		expect(hrefOf(target())).toBe('afb:note/N-12');
		expect(hrefOf(target({ kind: 'task', ref: 'T-4' }))).toBe('afb:task/T-4');
		expect(hrefOf(target({ kind: 'item', ref: 'AFB-20261111-0035' }))).toBe(
			'afb:item/AFB-20261111-0035'
		);
		expect(hrefOf(target({ kind: 'mockup', ref: null }))).toBe(
			'afb:mockup/3f2c9a1e-0000-4000-8000-000000000001'
		);
	});

	it('writes the title as the text and escapes brackets in it', () => {
		expect(linkMarkdown(target())).toBe('[Launch notes](afb:note/N-12)');
		expect(linkMarkdown(target({ title: 'Plan [draft]' }))).toBe(
			'[Plan \\[draft\\]](afb:note/N-12)'
		);
		expect(linkMarkdown(target({ title: '' }))).toBe('[N-12](afb:note/N-12)');
	});
});

describe('the plugin reports what is typed and the editor keeps the typing', () => {
	it('opens on a slash and follows every letter typed after it', () => {
		const { editor, last } = open();
		editor.commands.insertContent('/');
		expect(last()).toMatchObject({ kind: 'slash', query: '' });
		editor.commands.insertContent('h');
		editor.commands.insertContent('e');
		// The letters went into the editor text and the query follows them
		expect(editor.getText()).toBe('/he');
		expect(last()).toMatchObject({ kind: 'slash', query: 'he' });
	});

	it('closes on a space and on leaving the trigger', () => {
		const { editor, last } = open();
		editor.commands.insertContent('/he');
		editor.commands.insertContent(' ');
		expect(last()).toBeNull();
	});

	it('stays closed after Escape until the trigger is gone', () => {
		const { editor, last, updates } = open();
		editor.commands.insertContent('/he');
		const trigger = last();
		expect(trigger).not.toBeNull();
		dismissMenu(editor, trigger?.from ?? null);
		editor.commands.insertContent('a');
		expect(last()).toBeNull();
		const before = updates.length;
		editor.commands.insertContent('b');
		expect(updates.length).toBe(before);
		// A space ends the trigger; a new slash opens a menu again
		editor.commands.insertContent(' /');
		expect(last()).toMatchObject({ kind: 'slash', query: '' });
	});

	it('opens a link menu on @ and on [[', () => {
		const a = open();
		a.editor.commands.insertContent('see @lau');
		expect(a.last()).toMatchObject({ kind: 'link', query: 'lau' });
		const b = open();
		b.editor.commands.insertContent('see [[launch no');
		expect(b.last()).toMatchObject({ kind: 'link', query: 'launch no' });
	});

	it('does not open inside a code block', () => {
		const { editor, last } = open('```\n\n```');
		editor.commands.focus('start');
		editor.commands.insertContent('/he');
		// Nothing was ever reported, so there is no menu to show
		expect(last() ?? null).toBeNull();
	});

	it('hands keys to the menu first and lets the editor have them when the menu does not', () => {
		const { editor, keys, swallow } = open();
		editor.commands.insertContent('/');
		const press = () =>
			editor.view.someProp('handleKeyDown', (f) =>
				f(editor.view, new KeyboardEvent('keydown', { key: 'ArrowDown' }))
			);
		swallow(true);
		expect(press()).toBe(true);
		swallow(false);
		expect(press()).not.toBe(true);
		expect(keys).toContain('ArrowDown');
	});
});

describe('picking', () => {
	it('inserts the link with the title as its text, in Markdown', () => {
		const { editor, last } = open();
		editor.commands.insertContent('See @lau');
		const t = last();
		expect(t).not.toBeNull();
		insertLink(editor, { from: t!.from, to: t!.to }, target());
		expect(toMarkdown(editor)).toBe('See [Launch notes](afb:note/N-12)');
		// The cursor is after the link, outside it, so more typing is plain text
		editor.commands.insertContent('and more');
		expect(toMarkdown(editor)).toBe('See [Launch notes](afb:note/N-12) and more');
	});

	it('writes each kind', () => {
		const cases: [LinkTarget, string][] = [
			[target({ kind: 'task', ref: 'T-4', title: 'Fix it' }), '[Fix it](afb:task/T-4)'],
			[
				target({ kind: 'item', ref: 'AFB-20261111-0035', title: 'The plan' }),
				'[The plan](afb:item/AFB-20261111-0035)'
			],
			[
				target({ kind: 'mockup', ref: null, title: 'Board mockup' }),
				'[Board mockup](afb:mockup/3f2c9a1e-0000-4000-8000-000000000001)'
			]
		];
		for (const [t, md] of cases) {
			const { editor, last } = open();
			editor.commands.insertContent('[[x');
			const trig = last();
			insertLink(editor, { from: trig!.from, to: trig!.to }, t);
			expect(toMarkdown(editor)).toBe(md);
		}
	});

	it('replaces the slash and the word with the block', () => {
		const picks: [Parameters<typeof runSlash>[1], string][] = [
			['h2', '## Title'],
			['bullet', '- Title'],
			['task', '- [ ] Title'],
			['quote', '> Title'],
			['code', '```\nTitle\n```']
		];
		for (const [id, md] of picks) {
			const { editor, last } = open();
			editor.commands.insertContent('Title');
			editor.commands.focus('start');
			editor.commands.insertContent('/he');
			const t = last();
			expect(t).not.toBeNull();
			runSlash(editor, id, { from: t!.from, to: t!.to }, { pickPicture: () => {} });
			expect(toMarkdown(editor)).toBe(md);
		}
	});

	it('inserts a table and a divider, and hands the picture row to the picker', () => {
		const { editor, last } = open();
		editor.commands.insertContent('/');
		const t = last()!;
		runSlash(editor, 'divider', { from: t.from, to: t.to }, { pickPicture: () => {} });
		expect(toMarkdown(editor)).toContain('---');

		const b = open();
		b.editor.commands.insertContent('/');
		const u = b.last()!;
		runSlash(b.editor, 'table', { from: u.from, to: u.to }, { pickPicture: () => {} });
		expect(toMarkdown(b.editor)).toContain('| --- |');

		const c = open();
		c.editor.commands.insertContent('/pic');
		const v = c.last()!;
		const picker = vi.fn();
		runSlash(c.editor, 'picture', { from: v.from, to: v.to }, { pickPicture: picker });
		expect(picker).toHaveBeenCalledOnce();
		expect(c.editor.getText()).toBe('');
	});
});

describe('link search', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('waits for the typing to stop and asks once for the last word', async () => {
		const load = vi.fn(async (q: string) => [target({ title: q })]);
		const got: unknown[] = [];
		const search = new LinkSearch(load, (r) => got.push(r), 200);
		search.ask('l');
		search.ask('la');
		search.ask('lau');
		await vi.advanceTimersByTimeAsync(199);
		expect(load).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(load).toHaveBeenCalledOnce();
		expect(load).toHaveBeenCalledWith('lau');
		expect(got).toHaveLength(1);
	});

	it('asks at once when told to, and ignores a slow answer to an old word', async () => {
		const resolvers: Record<string, (t: LinkTarget[]) => void> = {};
		const load = (q: string) => new Promise<LinkTarget[]>((res) => (resolvers[q] = res));
		const got: { query: string }[] = [];
		const search = new LinkSearch(load, (r) => 'query' in r && got.push(r), 200);
		search.ask('a', true);
		search.ask('ab', true);
		resolvers['ab']([target({ title: 'new' })]);
		resolvers['a']([target({ title: 'old' })]);
		await vi.advanceTimersByTimeAsync(0);
		expect(got.map((g) => g.query)).toEqual(['ab']);
	});

	it('reports a failed search and drops everything after cancel', async () => {
		const got: unknown[] = [];
		const failing = new LinkSearch(
			async () => {
				throw new Error('down');
			},
			(r) => got.push(r),
			0
		);
		failing.ask('x');
		await vi.advanceTimersByTimeAsync(0);
		expect(got).toEqual([{ error: true }]);

		const later: unknown[] = [];
		const s = new LinkSearch(
			async () => [],
			(r) => later.push(r),
			200
		);
		s.ask('x');
		s.cancel();
		await vi.advanceTimersByTimeAsync(500);
		expect(later).toEqual([]);
	});
});
