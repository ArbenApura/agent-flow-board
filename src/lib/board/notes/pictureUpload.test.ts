// @vitest-environment happy-dom
// THE PICTURE UPLOAD CLIENT: THE CHECK BEFORE SENDING, THE PLAIN ERROR LINES AND THE ADDRESS MAPPING (AFB-20261111-0035, STEP 4.5)

// -- DEP-MODULES -- //
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
// -- MODULES -- //
import { ApiError } from '#lib/board/api.js';
import { NOTE_LIMITS } from '#lib/shared/notes.js';
import { editorExtensions, markdownOfDoc, toMarkdown } from './editorMarkdown.js';
import {
	checkPicture,
	displaySrc,
	picturesOf,
	storedSrc,
	uploadErrorLine,
	uploadPicture
} from './pictureUpload.js';

// -- CONSTANTS -- //

const ID = '3f2c9a1e-0000-4000-8000-000000000001';
const URL = `/api/v1/orgs/acme/notes/files/${ID}`;

// -- FUNCTIONS -- //

const file = (name: string, type: string, bytes = 10) =>
	new File([new Uint8Array(bytes)], name, { type });

const opened: Editor[] = [];
afterEach(() => {
	while (opened.length) opened.pop()?.destroy();
});

// -- TESTS -- //

describe('checkPicture', () => {
	it('lets the four picture types through', () => {
		for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
			expect(checkPicture({ size: 100, type })).toBeNull();
	});

	it('refuses a file over 25 MB and one that is not a picture', () => {
		expect(checkPicture({ size: NOTE_LIMITS.pictureBytes + 1, type: 'image/png' })).toBe(
			'That picture is larger than 25 MB.'
		);
		expect(checkPicture({ size: NOTE_LIMITS.pictureBytes, type: 'image/png' })).toBeNull();
		expect(checkPicture({ size: 10, type: 'application/pdf' })).toBe(
			'Use a PNG, JPEG, WebP or GIF picture.'
		);
		expect(checkPicture({ size: 10, type: 'image/svg+xml' })).toBe(
			'Use a PNG, JPEG, WebP or GIF picture.'
		);
		expect(checkPicture({ size: 0, type: 'image/png' })).toBe('That picture is empty.');
	});

	it('leaves a file with no reported type to the server, which reads the first bytes', () => {
		expect(checkPicture({ size: 10, type: '' })).toBeNull();
	});
});

describe('uploadErrorLine', () => {
	it('says what went wrong in plain words', () => {
		expect(uploadErrorLine(new ApiError(413, 'ERROR', 'x'))).toBe(
			'That picture is larger than 25 MB.'
		);
		expect(uploadErrorLine(new ApiError(429, 'RATE_LIMITED', 'x'))).toBe(
			'Two pictures are already uploading. Wait for one to finish.'
		);
		expect(
			uploadErrorLine(new ApiError(400, 'INVALID', 'Use a PNG, JPEG, WebP or GIF picture.'))
		).toBe('Use a PNG, JPEG, WebP or GIF picture.');
		expect(uploadErrorLine(new ApiError(403, 'FORBIDDEN', 'x'))).toBe(
			'You can no longer add pictures to this note.'
		);
		expect(uploadErrorLine(new ApiError(500, 'ERROR', 'boom'))).toBe(
			'The picture could not be uploaded. Try again.'
		);
		expect(uploadErrorLine(new TypeError('Failed to fetch'))).toBe(
			'The picture could not be uploaded. Check your connection and try again.'
		);
	});
});

describe('uploadPicture', () => {
	it('sends nothing for a refused file', async () => {
		const send = vi.fn();
		const out = await uploadPicture(file('notes.pdf', 'application/pdf'), send);
		expect(out).toEqual({ ok: false, line: 'Use a PNG, JPEG, WebP or GIF picture.' });
		expect(send).not.toHaveBeenCalled();
	});

	it('returns the id of a stored picture', async () => {
		const send = vi.fn(async () => ({ id: ID, mime: 'image/png', size: 10, markdown: '' }));
		const out = await uploadPicture(file('a.png', 'image/png'), send);
		expect(out).toEqual({ ok: true, id: ID });
		expect(send).toHaveBeenCalledOnce();
	});

	it('turns a failure into a line', async () => {
		const out = await uploadPicture(file('a.png', 'image/png'), async () => {
			throw new ApiError(429, 'RATE_LIMITED', 'x');
		});
		expect(out).toEqual({
			ok: false,
			line: 'Two pictures are already uploading. Wait for one to finish.'
		});
	});
});

describe('picturesOf', () => {
	it('takes picture files of a paste with no text, and nothing from a paste with text', () => {
		const files = [file('a.png', 'image/png'), file('b.pdf', 'application/pdf')];
		expect(picturesOf(files, { hasText: false }).map((f) => f.name)).toEqual(['a.png']);
		expect(picturesOf(files, { hasText: true })).toEqual([]);
		expect(picturesOf(null, { hasText: false })).toEqual([]);
	});
});

describe('picture addresses', () => {
	it('shows a stored picture from its real address and leaves other addresses alone', () => {
		expect(displaySrc(`afb:file/${ID}`, 'acme')).toBe(URL);
		expect(displaySrc('https://example.com/a.png', 'acme')).toBe('https://example.com/a.png');
		expect(displaySrc(`afb:file/${ID}`, undefined)).toBe(`afb:file/${ID}`);
	});

	it('turns the real address back into the stored one', () => {
		expect(storedSrc(URL)).toBe(`afb:file/${ID}`);
		expect(storedSrc(`https://afb.example.com${URL}`)).toBe(`afb:file/${ID}`);
		expect(storedSrc('https://example.com/a.png')).toBe('https://example.com/a.png');
		expect(storedSrc(null)).toBeNull();
	});

	it('shows the real address in the editor and keeps afb:file/<id> in the Markdown', () => {
		const ydoc = new Y.Doc();
		const editor = new Editor({
			element: document.createElement('div'),
			extensions: editorExtensions({ ydoc, org: 'acme' })
		});
		opened.push(editor);
		const md = `![a sketch](afb:file/${ID})`;
		editor.commands.setContent(md, { contentType: 'markdown', emitUpdate: false });
		const img = editor.view.dom.querySelector('img');
		expect(img?.getAttribute('src')).toBe(URL);
		expect(toMarkdown(editor)).toBe(md);
		expect(markdownOfDoc(ydoc)).toBe(md);
	});

	it('reads a pasted picture element back as afb:file/<id>', () => {
		const editor = new Editor({
			element: document.createElement('div'),
			extensions: editorExtensions({ ydoc: new Y.Doc(), org: 'acme' })
		});
		opened.push(editor);
		editor.commands.setContent(`<p><img src="${URL}" alt="x"></p>`, { emitUpdate: false });
		expect(toMarkdown(editor)).toBe(`![x](afb:file/${ID})`);
	});
});
