// THE CROP ENGINE OF THE PICTURE EDITOR (AFB-20261115-0714): PURE GEOMETRY, THEN THE RENDER TO A SMALL FILE
// The view is the picture's scale `k`, its offset `tx`, `ty` from the frame's centre (in frame pixels), its angle `a` in degrees
// (quarter turns plus the straighten value) and a left and right flip. The frame is a square of `F` pixels.

// IMPORTED CONSTANTS
import { PICTURE_OUTPUT_SIZE, PICTURE_TARGET_BYTES } from '#lib/shared/pictures.js';

// -- TYPES -- //

export type CropView = { k: number; tx: number; ty: number; a: number; flip: boolean };
/** The picture's size in its own pixels. */
export type CropImage = { width: number; height: number };

// -- CONSTANTS -- //

/** The most a picture can be zoomed in, as a multiple of the larger of its fill and fit scales. */
export const MAX_ZOOM_FACTOR = 8;
/** The straighten slider runs from minus to plus this many degrees. */
export const STRAIGHTEN_RANGE = 45;
/** The first quality tried and the lowest one, for the size loop. */
const QUALITY_START = 0.92;
const QUALITY_FLOOR = 0.5;
const QUALITY_STEP = 0.1;

// -- FUNCTIONS -- //

const rad = (deg: number) => (deg * Math.PI) / 180;

/** How far a square frame reaches along the picture's axes when the picture is turned by `a`: |cos a| + |sin a|. */
export function frameReach(a: number): number {
	const t = rad(a);
	return Math.abs(Math.cos(t)) + Math.abs(Math.sin(t));
}

/** The smallest scale at which the picture, turned by `a`, covers the whole frame (Fill, 100 percent). */
export function coverScale(img: CropImage, frame: number, a: number): number {
	return (frame * frameReach(a)) / Math.min(img.width, img.height);
}

/** The scale at which the whole turned picture sits inside the frame (Fit). */
export function fitScale(img: CropImage, frame: number, a: number): number {
	const t = rad(a);
	const c = Math.abs(Math.cos(t));
	const s = Math.abs(Math.sin(t));
	return frame / Math.max(img.width * c + img.height * s, img.width * s + img.height * c);
}

/** The largest scale the zoom reaches. */
export function maxScale(img: CropImage, frame: number, a: number): number {
	return Math.max(coverScale(img, frame, a), fitScale(img, frame, a)) * MAX_ZOOM_FACTOR;
}

/** The quarter turns part of an angle, in degrees (a multiple of 90). */
export function baseAngle(a: number): number {
	// A tie (exactly 45 degrees past a quarter) goes to the lower quarter, so the straighten slider reaches plus and minus 45
	const q = a / 90;
	// The `|| 0` turns a negative zero into zero
	return 90 * Math.sign(q) * Math.round(Math.abs(q) - 1e-9) || 0;
}

/** The straighten part of an angle, from minus 45 to plus 45, in steps of half a degree. */
export function straightenOf(a: number): number {
	return Math.round((a - baseAngle(a)) * 2) / 2;
}

/** The zoom as a percentage of Fill: 100 fills the frame exactly. */
export function zoomPercent(view: CropView, img: CropImage, frame: number): number {
	return Math.round((view.k / coverScale(img, frame, view.a)) * 100);
}

/** True while the picture is smaller than Fill, so padding shows inside the frame. */
export function isFit(view: CropView, img: CropImage, frame: number): boolean {
	return view.k < coverScale(img, frame, view.a) * 0.999;
}

/** Keeps the picture where it belongs: covering the frame at Fill or above, inside the frame below it. Returns a new view. */
export function clampView(view: CropView, img: CropImage, frame: number): CropView {
	const lo = fitScale(img, frame, view.a);
	const k = Math.max(lo, Math.min(maxScale(img, frame, view.a), view.k));
	let { tx, ty } = view;
	if (k >= coverScale(img, frame, view.a) * 0.9999) {
		// Work in the picture's own axes, where the frame's reach is exact
		const t = rad(view.a);
		const c = Math.cos(t);
		const s = Math.sin(t);
		const reach = (frame / 2) * frameReach(view.a);
		const mu = Math.max(0, (k * img.width) / 2 - reach);
		const mv = Math.max(0, (k * img.height) / 2 - reach);
		const u = Math.max(-mu, Math.min(mu, tx * c + ty * s));
		const v = Math.max(-mv, Math.min(mv, -tx * s + ty * c));
		tx = u * c - v * s;
		ty = u * s + v * c;
	} else {
		const t = rad(view.a);
		const c = Math.abs(Math.cos(t));
		const s = Math.abs(Math.sin(t));
		const w = k * (img.width * c + img.height * s);
		const h = k * (img.width * s + img.height * c);
		const mx = Math.abs(frame - w) / 2;
		const my = Math.abs(frame - h) / 2;
		tx = Math.max(-mx, Math.min(mx, tx));
		ty = Math.max(-my, Math.min(my, ty));
	}
	return { ...view, k, tx, ty };
}

/** The view a picture opens in: upright, filling the frame, centred. */
export function initialView(img: CropImage, frame: number): CropView {
	return { k: coverScale(img, frame, 0), tx: 0, ty: 0, a: 0, flip: false };
}

/** Zooms to `k`, keeping the point (px, py), measured from the frame's centre, still under the pointer. */
export function zoomAbout(
	view: CropView,
	img: CropImage,
	frame: number,
	k: number,
	px = 0,
	py = 0
): CropView {
	const next = Math.max(fitScale(img, frame, view.a), Math.min(maxScale(img, frame, view.a), k));
	const r = next / view.k;
	return clampView(
		{ ...view, k: next, tx: px - (px - view.tx) * r, ty: py - (py - view.ty) * r },
		img,
		frame
	);
}

/** Turns the picture a quarter to the right (1) or left (-1). The offset turns with it, so the same part stays in view. */
export function turnView(view: CropView, img: CropImage, frame: number, dir: 1 | -1): CropView {
	const tx = dir > 0 ? -view.ty : view.ty;
	const ty = dir > 0 ? view.tx : -view.tx;
	return clampView({ ...view, a: view.a + dir * 90, tx, ty }, img, frame);
}

/**
 * Flips the picture left and right on the screen, about the frame's centre. The picture is flipped before it is turned, so a
 * mirror on the screen is the flip toggled, the angle negated and the offset's x negated: M R(a) = R(-a) M.
 */
export function flipView(view: CropView, img: CropImage, frame: number): CropView {
	return clampView({ ...view, flip: !view.flip, a: -view.a, tx: -view.tx }, img, frame);
}

/** Sets the straighten value. A picture that was filling the frame keeps filling it. */
export function straightenView(
	view: CropView,
	img: CropImage,
	frame: number,
	degrees: number
): CropView {
	const filling = !isFit(view, img, frame);
	const a = baseAngle(view.a) + Math.max(-STRAIGHTEN_RANGE, Math.min(STRAIGHTEN_RANGE, degrees));
	// At Fit the whole turned picture must stay inside the frame, so the fit scale follows the new angle
	const atFit = Math.abs(view.k - fitScale(img, frame, view.a)) < 1e-6;
	const k = filling
		? Math.max(view.k, coverScale(img, frame, a))
		: atFit
			? fitScale(img, frame, a)
			: view.k;
	return clampView({ ...view, a, k }, img, frame);
}

/** The view for Fill: the picture covers the frame, with the offset kept where it can be. */
export function fillView(view: CropView, img: CropImage, frame: number): CropView {
	return clampView({ ...view, k: coverScale(img, frame, view.a) }, img, frame);
}

/** The view for Fit: the whole picture inside the frame, centred. */
export function fitView(view: CropView, img: CropImage, frame: number): CropView {
	return { ...view, k: fitScale(img, frame, view.a), tx: 0, ty: 0 };
}

/** The zoom slider's position from 0 to 1, on a log scale between Fit and the largest zoom. */
export function zoomToSlider(view: CropView, img: CropImage, frame: number): number {
	const lo = fitScale(img, frame, view.a);
	const hi = maxScale(img, frame, view.a);
	return Math.max(0, Math.min(1, Math.log(view.k / lo) / Math.log(hi / lo)));
}

/** The scale for a slider position from 0 to 1. */
export function sliderToZoom(position: number, img: CropImage, frame: number, a: number): number {
	const lo = fitScale(img, frame, a);
	const hi = maxScale(img, frame, a);
	return lo * Math.pow(hi / lo, Math.max(0, Math.min(1, position)));
}

/** A picture point (in frame pixels from the frame's centre) as it lies in the picture's own pixels from its centre. */
export function toPictureSpace(view: CropView, px: number, py: number): { u: number; v: number } {
	const t = rad(view.a);
	const x = px - view.tx;
	const y = py - view.ty;
	const u = (x * Math.cos(t) + y * Math.sin(t)) / view.k;
	const v = (-x * Math.sin(t) + y * Math.cos(t)) / view.k;
	return { u: view.flip ? -u : u, v };
}

/** Draws the view into a square canvas of `size` pixels, where the frame fills the canvas (`size / frame` is the scale). */
export function paintView(
	ctx: CanvasRenderingContext2D,
	image: CanvasImageSource,
	img: CropImage,
	view: CropView,
	size: number,
	frame: number
): void {
	const m = size / frame;
	ctx.save();
	ctx.clearRect(0, 0, size, size);
	ctx.imageSmoothingQuality = 'high';
	ctx.translate(size / 2 + view.tx * m, size / 2 + view.ty * m);
	ctx.rotate(rad(view.a));
	ctx.scale((view.flip ? -1 : 1) * view.k * m, view.k * m);
	ctx.drawImage(image, -img.width / 2, -img.height / 2);
	ctx.restore();
}

/** The next quality to try after `q`, or null once the floor is passed. */
export function nextQuality(q: number): number | null {
	const next = Math.round((q - QUALITY_STEP) * 100) / 100;
	return next < QUALITY_FLOOR ? null : next;
}

/**
 * Encodes a canvas as WebP, stepping the quality down until the file is under the target size. Where the browser cannot write
 * WebP it hands back a PNG, which is the best it can do. Resolves to null when the canvas cannot be encoded at all.
 */
export async function encodeUnder(
	canvas: HTMLCanvasElement,
	targetBytes = PICTURE_TARGET_BYTES
): Promise<Blob | null> {
	const encode = (type: string, q: number) =>
		new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));
	let q: number | null = QUALITY_START;
	let last: Blob | null = null;
	while (q !== null) {
		last = await encode('image/webp', q);
		if (!last) return last;
		// A browser that cannot write WebP hands back a PNG: a big one is tried again as a JPEG, which steps down in size too
		if (last.type !== 'image/webp') {
			if (last.size <= targetBytes) return last;
			return (await encodeJpegUnder(encode, targetBytes)) ?? last;
		}
		if (last.size <= targetBytes) return last;
		q = nextQuality(q);
	}
	return last;
}

/** Steps a JPEG down in quality until it is under the target. Returns the smallest one tried, or null when JPEG cannot be written. */
async function encodeJpegUnder(
	encode: (type: string, q: number) => Promise<Blob | null>,
	targetBytes: number
): Promise<Blob | null> {
	let best: Blob | null = null;
	for (let q: number | null = QUALITY_START; q !== null; q = nextQuality(q)) {
		const b = await encode('image/jpeg', q);
		if (!b || b.type !== 'image/jpeg') return best;
		best = b;
		if (b.size <= targetBytes) return b;
	}
	return best;
}

/** Renders the view as the file that is saved: a square of PICTURE_OUTPUT_SIZE pixels, under the target size. */
export async function renderCrop(
	image: CanvasImageSource,
	img: CropImage,
	view: CropView,
	frame: number,
	name = 'picture'
): Promise<File | null> {
	const canvas = document.createElement('canvas');
	canvas.width = PICTURE_OUTPUT_SIZE;
	canvas.height = PICTURE_OUTPUT_SIZE;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	paintView(ctx, image, img, view, PICTURE_OUTPUT_SIZE, frame);
	const blob = await encodeUnder(canvas);
	if (!blob) return null;
	const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
	return new File([blob], `${name.replace(/\.[^.]+$/, '') || 'picture'}.${ext}`, {
		type: blob.type
	});
}
