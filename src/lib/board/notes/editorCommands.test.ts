// @vitest-environment happy-dom
// EVERY TOOLBAR COMMAND AND THE MARKDOWN IT WRITES, AND THE TEARDOWN OF THE EDITOR (AFB-20261111-0035, STEP 4.2)

// IMPORTED DEP-MODULES
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
// IMPORTED MODULES
import { applyLink, normalizeLinkUrl, toolById, type ToolId } from './editorCommands.js';
import { editorExtensions, seedUpdate, toMarkdown } from './editorMarkdown.js';

// -- FUNCTIONS -- //

const opened: Editor[] = [];

function open(markdown: string) {
	// The same way the screen opens a note: the seed goes into the Yjs document before the editor, so it is not an undo step
	const ydoc = new Y.Doc();
	Y.applyUpdate(ydoc, seedUpdate(markdown));
	const editor = new Editor({
		element: document.createElement('div'),
		extensions: editorExtensions({ ydoc })
	});
	opened.push(editor);
	return editor;
}

/** Runs a tool with the cursor at the start (or the whole text selected) and returns the Markdown. */
function use(id: ToolId, markdown: string, selectAll = false) {
	const editor = open(markdown);
	if (selectAll) editor.commands.selectAll();
	else editor.commands.focus('start');
	expect(toolById(id).run(editor)).toBe(true);
	return toMarkdown(editor);
}

afterEach(() => {
	while (opened.length) opened.pop()?.destroy();
});

// -- TESTS -- //

describe('toolbar commands write Markdown', () => {
	it('headings', () => {
		expect(use('h1', 'Title')).toBe('# Title');
		expect(use('h2', 'Title')).toBe('## Title');
		expect(use('h3', 'Title')).toBe('### Title');
		expect(use('h2', '## Title')).toBe('Title');
	});

	it('bold and italic', () => {
		expect(use('bold', 'word', true)).toBe('**word**');
		expect(use('italic', 'word', true)).toBe('*word*');
	});

	it('lists, checklist, quote and code', () => {
		expect(use('bullet', 'one')).toBe('- one');
		expect(use('ordered', 'one')).toBe('1. one');
		expect(use('task', 'one')).toBe('- [ ] one');
		expect(use('quote', 'one')).toBe('> one');
		expect(use('code', 'one')).toBe('```\none\n```');
	});

	it('a table with a header row', () => {
		const md = use('table', '');
		expect(md.split('\n')[0]).toMatch(/^\| +\| +\| +\|$/);
		expect(md.split('\n')[1]).toMatch(/^\| -+ \| -+ \| -+ \|$/);
		expect(md.split('\n')).toHaveLength(4);
	});

	it('undo and redo through Yjs', () => {
		const editor = open('start');
		editor.commands.focus('end');
		editor.commands.insertContent(' more');
		expect(toolById('undo').enabled?.(editor)).toBe(true);
		toolById('undo').run(editor);
		expect(toMarkdown(editor)).toBe('start');
		expect(toolById('redo').enabled?.(editor)).toBe(true);
		toolById('redo').run(editor);
		expect(toMarkdown(editor)).toBe('start more');
	});

	it('reports which tool is active under the cursor', () => {
		const editor = open('# Head\n\n- item');
		editor.commands.focus('start');
		expect(toolById('h1').active?.(editor)).toBe(true);
		expect(toolById('bullet').active?.(editor)).toBe(false);
	});
});

describe('markdown shortcuts while typing', () => {
	function type(editor: Editor, text: string) {
		for (const ch of text) {
			const { from, to } = editor.state.selection;
			const handled = editor.view.someProp('handleTextInput', (f) =>
				f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to))
			);
			if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
		}
	}

	it('turns "# " into a heading, "- " into a list and "[ ] " into a checklist', () => {
		const h = open('');
		h.commands.focus('start');
		type(h, '# Big');
		expect(toMarkdown(h)).toBe('# Big');
		const l = open('');
		l.commands.focus('start');
		type(l, '- one');
		expect(toMarkdown(l)).toBe('- one');
		const t = open('');
		t.commands.focus('start');
		type(t, '[ ] todo');
		expect(toMarkdown(t)).toBe('- [ ] todo');
	});

	it('turns **bold** into bold', () => {
		const e = open('');
		e.commands.focus('start');
		type(e, 'a **b** c');
		expect(toMarkdown(e)).toBe('a **b** c');
	});
});

describe('the link tool', () => {
	it('accepts web, mail and afb addresses, adds https to a bare domain, refuses the rest', () => {
		expect(normalizeLinkUrl('https://a.com/x')).toBe('https://a.com/x');
		expect(normalizeLinkUrl('example.com/path')).toBe('https://example.com/path');
		expect(normalizeLinkUrl('afb:note/N-12')).toBe('afb:note/N-12');
		expect(normalizeLinkUrl('afb:file/3f2c9a1e-0000-4000-8000-000000000001')).toBe(
			'afb:file/3f2c9a1e-0000-4000-8000-000000000001'
		);
		expect(normalizeLinkUrl('afb:N-12')).toBeNull();
		expect(normalizeLinkUrl('afb:file/abc')).toBeNull();
		expect(normalizeLinkUrl('mailto:a@b.co')).toBe('mailto:a@b.co');
		expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
		expect(normalizeLinkUrl('data:text/html,x')).toBeNull();
		expect(normalizeLinkUrl('two words')).toBeNull();
		expect(normalizeLinkUrl('  ')).toBeNull();
	});

	it('sets and removes a link on the selection', () => {
		const editor = open('see board');
		editor.commands.selectAll();
		expect(applyLink(editor, 'afb:note/N-12')).toBe(true);
		expect(toMarkdown(editor)).toBe('[see board](afb:note/N-12)');
		expect(applyLink(editor, 'javascript:x')).toBe(false);
		editor.commands.selectAll();
		applyLink(editor, '');
		expect(toMarkdown(editor)).toBe('see board');
	});
});

describe('teardown', () => {
	it('destroys the editor and frees the Yjs document', () => {
		const ydoc = new Y.Doc();
		const editor = new Editor({
			element: document.createElement('div'),
			extensions: editorExtensions({ ydoc })
		});
		editor.destroy();
		expect(editor.isDestroyed).toBe(true);
		ydoc.destroy();
		expect(() => ydoc.getText('x')).not.toThrow();
	});
});
