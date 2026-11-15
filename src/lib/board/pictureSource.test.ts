// THE CHECKS OF THE PICTURE EDITOR'S SOURCE FILE (AFB-20261115-0714)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { checkSourceFile, formatBytes, isSmallPicture } from './pictureSource';

describe('checkSourceFile', () => {
	const file = (over: Partial<{ name: string; size: number; type: string }> = {}) => ({
		name: 'photo.jpg',
		size: 8 * 1024 * 1024,
		type: 'image/jpeg',
		...over
	});

	it('takes a picture of up to 10 MB', () => {
		expect(checkSourceFile(file())).toEqual({ ok: true });
		expect(checkSourceFile(file({ size: 10 * 1024 * 1024 }))).toEqual({ ok: true });
	});

	it('refuses one over 10 MB with the plain message', () => {
		const r = checkSourceFile(file({ size: 10 * 1024 * 1024 + 1 }));
		expect(r).toMatchObject({ ok: false, reason: 'too-large' });
		expect(r.ok === false && r.message).toBe('The picture must be smaller than 10 MB.');
	});

	it('refuses an empty file, a document and an SVG', () => {
		expect(checkSourceFile(file({ size: 0 }))).toMatchObject({ reason: 'empty' });
		expect(checkSourceFile(file({ name: 'a.pdf', type: 'application/pdf' }))).toMatchObject({
			reason: 'not-a-picture'
		});
		expect(checkSourceFile(file({ name: 'logo.svg', type: 'image/svg+xml' }))).toMatchObject({
			reason: 'not-a-picture'
		});
		expect(checkSourceFile(file({ name: 'logo.svg', type: '' }))).toMatchObject({
			reason: 'not-a-picture'
		});
	});

	it('takes a camera file the system gave no type by its ending', () => {
		expect(checkSourceFile(file({ name: 'IMG_1.HEIC', type: '' }))).toEqual({ ok: true });
		expect(checkSourceFile(file({ name: 'notes.txt', type: '' }))).toMatchObject({
			reason: 'not-a-picture'
		});
	});
});

describe('formatBytes and isSmallPicture', () => {
	it('writes sizes for people', () => {
		expect(formatBytes(8.7 * 1024 * 1024)).toBe('8.7 MB');
		expect(formatBytes(412 * 1024)).toBe('412 KB');
		expect(formatBytes(10)).toBe('1 KB');
	});

	it('calls a picture small when its short side is under 256 px', () => {
		expect(isSmallPicture(240, 240)).toBe(true);
		expect(isSmallPicture(4000, 255)).toBe(true);
		expect(isSmallPicture(256, 4000)).toBe(false);
	});
});
