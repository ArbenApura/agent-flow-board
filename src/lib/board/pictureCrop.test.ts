// THE GEOMETRY OF THE PICTURE EDITOR (AFB-20261115-0714): THE FRAME STAYS COVERED AT FILL, ZOOM KEEPS THE POINT UNDER THE POINTER

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	baseAngle,
	clampView,
	coverScale,
	fillView,
	fitScale,
	fitView,
	flipView,
	initialView,
	isFit,
	maxScale,
	nextQuality,
	sliderToZoom,
	straightenOf,
	straightenView,
	toPictureSpace,
	turnView,
	zoomAbout,
	zoomPercent,
	zoomToSlider,
	type CropImage,
	type CropView
} from './pictureCrop';

// -- CONSTANTS -- //

const IMG: CropImage = { width: 1600, height: 1200 };
const F = 266;

// -- FUNCTIONS -- //

/** Every corner of the frame, as a picture point, lies inside the picture. */
function frameCovered(view: CropView, img = IMG, frame = F) {
	const half = frame / 2;
	for (const [x, y] of [
		[-half, -half],
		[half, -half],
		[-half, half],
		[half, half]
	]) {
		const { u, v } = toPictureSpace(view, x, y);
		if (Math.abs(u) > img.width / 2 + 0.01 || Math.abs(v) > img.height / 2 + 0.01) return false;
	}
	return true;
}

describe('scales', () => {
	it('fill is 100 percent and covers the frame at every angle', () => {
		for (const a of [0, 7.5, 30, 45, 90, 135, -20]) {
			const view = clampView({ ...initialView(IMG, F), a, k: coverScale(IMG, F, a) }, IMG, F);
			expect(zoomPercent(view, IMG, F)).toBe(100);
			expect(frameCovered(view)).toBe(true);
		}
	});

	it('fit puts the whole picture inside the frame and is below fill for a non square picture', () => {
		expect(fitScale(IMG, F, 0)).toBeCloseTo(F / 1600, 6);
		expect(fitScale(IMG, F, 0)).toBeLessThan(coverScale(IMG, F, 0));
		expect(maxScale(IMG, F, 0)).toBeCloseTo(coverScale(IMG, F, 0) * 8, 6);
	});

	it('reaches plus and minus 45 on the straighten value, and never jumps a quarter', () => {
		expect([baseAngle(45), straightenOf(45)]).toEqual([0, 45]);
		expect([baseAngle(-45), straightenOf(-45)]).toEqual([0, -45]);
		expect([baseAngle(135), straightenOf(135)]).toEqual([90, 45]);
		expect([baseAngle(-135), straightenOf(-135)]).toEqual([-90, -45]);
		expect([baseAngle(46), straightenOf(46)]).toEqual([90, -44]);
	});

	it('splits an angle into quarter turns and a straighten value', () => {
		expect(baseAngle(92)).toBe(90);
		expect(straightenOf(92)).toBe(2);
		expect(straightenOf(-93.3)).toBe(-3.5);
	});
});

describe('clampView', () => {
	it('keeps the frame covered at fill however far the picture is pulled', () => {
		for (const a of [0, 12, -33, 90, 100]) {
			const base = { k: coverScale(IMG, F, a) * 1.4, a, flip: false };
			for (const [tx, ty] of [
				[9999, 0],
				[0, -9999],
				[-500, 500],
				[30, 20]
			]) {
				const view = clampView({ ...base, tx, ty }, IMG, F);
				expect(frameCovered(view)).toBe(true);
			}
		}
	});

	it('keeps the picture inside the frame below fill', () => {
		const view = clampView({ k: fitScale(IMG, F, 0), tx: 400, ty: 400, a: 0, flip: false }, IMG, F);
		expect(view.tx).toBeCloseTo(0, 6);
		expect(Math.abs(view.ty)).toBeLessThanOrEqual((F - 1200 * view.k) / 2 + 0.001);
	});

	it('holds the scale between fit and the largest zoom', () => {
		const low = clampView({ k: 0.0001, tx: 0, ty: 0, a: 0, flip: false }, IMG, F);
		const high = clampView({ k: 999, tx: 0, ty: 0, a: 0, flip: false }, IMG, F);
		expect(low.k).toBeCloseTo(fitScale(IMG, F, 0), 6);
		expect(high.k).toBeCloseTo(maxScale(IMG, F, 0), 6);
	});
});

describe('zoom, turn, flip, straighten', () => {
	it('zooming about a point keeps that point of the picture under it', () => {
		const start = clampView({ ...initialView(IMG, F), k: coverScale(IMG, F, 0) * 2 }, IMG, F);
		const px = 40;
		const py = -30;
		const before = toPictureSpace(start, px, py);
		const next = zoomAbout(start, IMG, F, start.k * 1.5, px, py);
		const after = toPictureSpace(next, px, py);
		expect(after.u).toBeCloseTo(before.u, 4);
		expect(after.v).toBeCloseTo(before.v, 4);
	});

	it('a quarter turn right then left comes back, and the frame stays covered', () => {
		const start = clampView(
			{ k: coverScale(IMG, F, 0) * 1.8, tx: 25, ty: -10, a: 0, flip: false },
			IMG,
			F
		);
		const turned = turnView(start, IMG, F, 1);
		expect(turned.a).toBe(90);
		expect(frameCovered(turned)).toBe(true);
		const back = turnView(turned, IMG, F, -1);
		expect(back.a).toBe(0);
		expect(back.tx).toBeCloseTo(start.tx, 6);
		expect(back.ty).toBeCloseTo(start.ty, 6);
	});

	it('a quarter turn right moves the offset (25, -10) to (10, 25) and left to (-10, -25)', () => {
		// A tall picture at a high zoom, so the clamp leaves the offset alone
		const big: CropImage = { width: 4000, height: 4000 };
		const start: CropView = { k: 2, tx: 25, ty: -10, a: 0, flip: false };
		const right = turnView(start, big, F, 1);
		expect([right.tx, right.ty]).toEqual([10, 25]);
		const left = turnView(start, big, F, -1);
		expect([left.tx, left.ty]).toEqual([-10, -25]);
	});

	it('straightening a picture at Fit keeps the whole turned picture inside the frame', () => {
		const fit = fitView(initialView(IMG, F), IMG, F);
		const view = straightenView(fit, IMG, F, 20);
		expect(view.k).toBeCloseTo(fitScale(IMG, F, view.a), 6);
		expect(isFit(view, IMG, F)).toBe(true);
	});

	it('flip mirrors the screen left and right at every angle, not only upright', () => {
		for (const a of [0, 30, 90, 120, -45, 180]) {
			const start: CropView = {
				k: coverScale(IMG, F, a) * 3,
				tx: 12,
				ty: -7,
				a,
				flip: false
			};
			const flipped = flipView(start, IMG, F);
			expect(flipped.flip).toBe(true);
			for (const [x, y] of [
				[40, 25],
				[-30, 60],
				[0, -50]
			]) {
				// What the screen showed at (-x, y) is now at (x, y)
				const was = toPictureSpace(start, -x, y);
				const now = toPictureSpace(flipped, x, y);
				expect(now.u).toBeCloseTo(was.u, 4);
				expect(now.v).toBeCloseTo(was.v, 4);
			}
		}
	});

	it('flip mirrors the offset and flipping twice is the identity', () => {
		const start = clampView(
			{ ...initialView(IMG, F), k: coverScale(IMG, F, 0) * 2, tx: 30 },
			IMG,
			F
		);
		const flipped = flipView(start, IMG, F);
		expect(flipped.flip).toBe(true);
		expect(flipped.tx).toBeCloseTo(-start.tx, 6);
		expect(flipView(flipped, IMG, F).tx).toBeCloseTo(start.tx, 6);
	});

	it('straightening a picture that fills the frame keeps it filling the frame', () => {
		const view = straightenView(initialView(IMG, F), IMG, F, 17.5);
		expect(straightenOf(view.a)).toBe(17.5);
		expect(isFit(view, IMG, F)).toBe(false);
		expect(frameCovered(view)).toBe(true);
	});

	it('fit and fill switch between the two scales', () => {
		const fit = fitView(initialView(IMG, F), IMG, F);
		expect(isFit(fit, IMG, F)).toBe(true);
		const fill = fillView(fit, IMG, F);
		expect(isFit(fill, IMG, F)).toBe(false);
		expect(zoomPercent(fill, IMG, F)).toBe(100);
	});
});

describe('the zoom slider and the size loop', () => {
	it('the slider position and the scale map to each other', () => {
		const view = clampView({ ...initialView(IMG, F), k: coverScale(IMG, F, 0) * 2 }, IMG, F);
		const pos = zoomToSlider(view, IMG, F);
		expect(sliderToZoom(pos, IMG, F, 0)).toBeCloseTo(view.k, 6);
		expect(zoomToSlider({ ...view, k: fitScale(IMG, F, 0) }, IMG, F)).toBeCloseTo(0, 6);
		expect(sliderToZoom(1, IMG, F, 0)).toBeCloseTo(maxScale(IMG, F, 0), 6);
	});

	it('steps the quality down from 0.92 to 0.52 and then stops', () => {
		const seen: number[] = [];
		for (let q: number | null = 0.92; q !== null; q = nextQuality(q)) seen.push(q);
		expect(seen).toEqual([0.92, 0.82, 0.72, 0.62, 0.52]);
	});
});
