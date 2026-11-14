// @vitest-environment happy-dom
// SPIKE 4.1 (a) AND (b): MARKDOWN IN, THE SAME MARKDOWN OUT, ON A LOCAL YJS DOCUMENT WITH YJS UNDO

// IMPORTED DEP-MODULES
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
// IMPORTED MODULES
import {
	editorExtensions,
	loadMarkdown,
	markdownOfDoc,
	seedUpdate,
	toMarkdown
} from './editorMarkdown.js';

// -- FUNCTIONS -- //

function open(markdown: string) {
	const ydoc = new Y.Doc();
	const editor = new Editor({
		element: document.createElement('div'),
		extensions: editorExtensions({ ydoc })
	});
	loadMarkdown(editor, markdown);
	return { ydoc, editor };
}

const CASES: Record<string, string> = {
	headings: '# One\n\n## Two\n\n### Three\n\nText under it.',
	'bold and italic': 'Some **bold** and *italic* and ~~gone~~ words.',
	'bullet list': '- one\n- two\n- three',
	'numbered list': '1. one\n2. two\n3. three',
	'nested lists': '- one\n  - inner a\n  - inner b\n    - deeper\n- two',
	quote: '> a quoted line\n>\n> and another',
	'code block': '```ts\nconst a = 1;\n\nconst b = 2;\n```',
	'inline code': 'Run `yarn check` now.',
	table: '| Name | Role |\n| ---- | ---- |\n| Ada  | Lead |\n| Bo   | Dev  |',
	checklist: '- [ ] open\n- [x] done\n  - [ ] nested open',
	link: 'See [the board](https://afb.arbenger.com/arbenger/AFB) now.',
	'afb link': 'Read [the plan](afb:item/AFB-20261111-0035) and [the note](afb:note/N-12).',
	'afb picture': '![a sketch](afb:file/3f2c9a1e-0000-4000-8000-000000000001)',
	'mixed page':
		'# Plan\n\nIntro with **bold** and a [link](afb:note/N-3).\n\n- [ ] first\n- [x] second\n\n> note\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |'
};

// -- TESTS -- //

describe('markdown to editor and back (spike 4.1 a)', () => {
	for (const [name, md] of Object.entries(CASES)) {
		it(`keeps ${name}`, () => {
			const { editor, ydoc } = open(md);
			try {
				expect(toMarkdown(editor)).toBe(md);
				// The same text read again from the Yjs document alone
				expect(markdownOfDoc(ydoc)).toBe(md);
			} finally {
				editor.destroy();
			}
		});
	}

	it('never draws a javascript: link as a live link', () => {
		const { editor } = open('[x](javascript:alert(1))');
		try {
			expect(editor.getHTML()).not.toContain('javascript:');
		} finally {
			editor.destroy();
		}
	});
});

describe('the editor on a local Yjs document (spike 4.1 b)', () => {
	it('writes into the Yjs document and undoes through Yjs', () => {
		const { editor, ydoc } = open('first');
		try {
			// A seeded load is not undoable history of a person, so start from a clean undo stack
			editor.commands.focus('end');
			editor.commands.insertContent(' second');
			expect(toMarkdown(editor)).toBe('first second');
			expect(Y.encodeStateAsUpdate(ydoc).length).toBeGreaterThan(0);
			editor.commands.undo();
			expect(toMarkdown(editor)).not.toContain('second');
			editor.commands.redo();
			expect(toMarkdown(editor)).toBe('first second');
		} finally {
			editor.destroy();
		}
	});

	it('builds a seed update that holds the text', () => {
		const update = seedUpdate('# Hello\n\n- a\n- b');
		const doc = new Y.Doc();
		Y.applyUpdate(doc, update);
		expect(markdownOfDoc(doc)).toBe('# Hello\n\n- a\n- b');
	});
});
