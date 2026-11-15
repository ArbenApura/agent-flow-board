// READING A CHOSEN PICTURE FOR THE PICTURE EDITOR (AFB-20261115-0714): THE CHECKS, THEN THE DECODE
// The checks are pure and tested. The decode needs a browser (createImageBitmap) and turns the file the way the camera meant it.

// IMPORTED CONSTANTS
import { MAX_SOURCE_BYTES, PICTURE_MIN_SIDE } from '#lib/shared/pictures.js';

// -- TYPES -- //

export type SourceFile = { name: string; size: number; type: string };
export type SourceCheck =
	{ ok: true } | { ok: false; reason: 'empty' | 'too-large' | 'not-a-picture'; message: string };
/** A decoded picture, ready to draw, with the facts the editor shows. */
export type PictureSource = {
	image: CanvasImageSource;
	width: number;
	height: number;
	name: string;
	/** The size of the chosen file in bytes. */
	bytes: number;
	/** The pixel size of the file itself, before a very large picture was reduced for editing. */
	originalWidth: number;
	originalHeight: number;
	/** True when the short side is under PICTURE_MIN_SIDE, so the result may look soft. */
	small: boolean;
};

// -- CONSTANTS -- //

/** A picture is edited from a copy no larger than this on its long side. */
export const WORK_SIDE = 4096;
/** Some systems give a camera format (HEIC) no type at all, so the ending counts too. */
const PICTURE_ENDINGS = /\.(png|jpe?g|webp|gif|avif|bmp|heic|heif|tiff?)$/i;

// -- FUNCTIONS -- //

/** Checks a chosen file before it is read: not empty, at most 10 MB, a picture and not an SVG (which can carry scripts). */
export function checkSourceFile(file: SourceFile): SourceCheck {
	if (file.size <= 0) return { ok: false, reason: 'empty', message: 'That file is empty.' };
	if (file.size > MAX_SOURCE_BYTES)
		return {
			ok: false,
			reason: 'too-large',
			message: `The picture must be smaller than ${MAX_SOURCE_BYTES / (1024 * 1024)} MB.`
		};
	const svg = file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name);
	const picture = file.type.startsWith('image/') || (!file.type && PICTURE_ENDINGS.test(file.name));
	if (svg || !picture)
		return {
			ok: false,
			reason: 'not-a-picture',
			message: 'That file is not a picture the editor can open.'
		};
	return { ok: true };
}

/** A size for people: 8.7 MB, 412 KB. */
export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Whether a picture of this size is small enough to look soft once it fills the frame. */
export function isSmallPicture(width: number, height: number): boolean {
	return Math.min(width, height) < PICTURE_MIN_SIDE;
}

/**
 * Decodes a chosen file. The camera's turn (EXIF) is honoured, and a picture over WORK_SIDE on its long side is reduced to
 * that, so a 100 megapixel photo does not freeze a phone. Rejects with a plain message a person can read.
 */
export async function readPictureSource(file: File): Promise<PictureSource> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		// An engine that does not know the orientation option still reads the file, and turns it by itself
		try {
			bitmap = await createImageBitmap(file);
		} catch {
			throw new Error('We could not read that file.');
		}
	}
	const originalWidth = bitmap.width;
	const originalHeight = bitmap.height;
	let image: CanvasImageSource = bitmap;
	let width = originalWidth;
	let height = originalHeight;
	const longSide = Math.max(width, height);
	if (longSide > WORK_SIDE) {
		const ratio = WORK_SIDE / longSide;
		width = Math.max(1, Math.round(width * ratio));
		height = Math.max(1, Math.round(height * ratio));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			bitmap.close();
			throw new Error('We could not read that file.');
		}
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, 0, 0, width, height);
		bitmap.close();
		image = canvas;
	}
	return {
		image,
		width,
		height,
		name: file.name,
		bytes: file.size,
		originalWidth,
		originalHeight,
		small: isSmallPicture(originalWidth, originalHeight)
	};
}
