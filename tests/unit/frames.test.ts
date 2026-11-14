// THE GEOMETRY OF THE DEVICE FRAMES: SIZES, THE SCALE TO A STAGE, AND WHICH DEVICE IS SHOWN

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	effectiveDevice,
	firstDevice,
	fitScale,
	frameSize,
	offeredDevices,
	showsSwitch
} from '../../src/lib/board/frames';

// -- FUNCTIONS -- //

describe('frameSize', () => {
	it('keeps the real screen sizes of the four devices', () => {
		expect(frameSize('wide')).toMatchObject({ screenWidth: 1600, screenHeight: 900 });
		expect(frameSize('laptop')).toMatchObject({ screenWidth: 1280, screenHeight: 800 });
		expect(frameSize('tablet')).toMatchObject({ screenWidth: 820, screenHeight: 1100 });
		expect(frameSize('phone')).toMatchObject({ screenWidth: 408, screenHeight: 840 });
	});
	it('adds a browser bar to a wide and a laptop screen and a bezel to a tablet and a phone', () => {
		expect(frameSize('laptop')).toMatchObject({
			kind: 'browser',
			top: 41,
			side: 1,
			bottom: 1,
			width: 1282,
			height: 842
		});
		expect(frameSize('tablet')).toMatchObject({
			kind: 'tablet',
			top: 15,
			side: 15,
			width: 850,
			height: 1130
		});
		expect(frameSize('phone')).toMatchObject({
			kind: 'phone',
			top: 13,
			side: 13,
			width: 434,
			height: 866
		});
	});
});

describe('fitScale', () => {
	it('shrinks the whole frame to the stage and never enlarges it', () => {
		expect(fitScale(1282, 'laptop')).toBe(1);
		expect(fitScale(5000, 'laptop')).toBe(1);
		expect(fitScale(641, 'laptop')).toBe(0.5);
		expect(fitScale(217, 'phone')).toBe(0.5);
	});
	it('falls back to life size when the stage width is not known yet', () => {
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(fitScale(bad, 'wide')).toBe(1);
		}
	});
	it('rounds down, so the frame is never one pixel too wide for its stage', () => {
		const s = fitScale(1000, 'wide');
		expect(s * frameSize('wide').width).toBeLessThanOrEqual(1000);
	});
});

describe('devices a project offers', () => {
	it('keeps the fixed order and falls back to all four when none is saved', () => {
		expect(offeredDevices(['phone', 'wide'])).toEqual(['wide', 'phone']);
		expect(offeredDevices([])).toEqual(['wide', 'laptop', 'tablet', 'phone']);
		expect(offeredDevices(null)).toEqual(['wide', 'laptop', 'tablet', 'phone']);
	});
	it('shows no switch for a phone only project', () => {
		expect(showsSwitch(offeredDevices(['phone']))).toBe(false);
		expect(showsSwitch(offeredDevices(['phone', 'tablet']))).toBe(true);
	});
});

describe('which device is shown', () => {
	const all = offeredDevices(null);
	it('starts on the widest device that fits at 60 percent or more: wide, laptop, tablet, phone', () => {
		expect(firstDevice(all, 1200)).toBe('wide');
		expect(firstDevice(all, 900)).toBe('laptop');
		expect(firstDevice(all, 600)).toBe('tablet');
		expect(firstDevice(all, 520)).toBe('tablet');
		expect(firstDevice(all, 500)).toBe('phone');
	});
	it('skips a device the project does not offer', () => {
		expect(firstDevice(['laptop', 'phone'], 1500)).toBe('laptop');
		expect(firstDevice(['tablet', 'phone'], 1500)).toBe('tablet');
		expect(firstDevice(['laptop', 'tablet'], 600)).toBe('tablet');
	});
	it('starts on the phone on a stage narrower than 480', () => {
		expect(firstDevice(all, 479)).toBe('phone');
		expect(firstDevice(['laptop'], 300)).toBe('laptop');
	});
	it('does not treat an unknown stage width as narrow', () => {
		expect(firstDevice(all, 0)).toBe('wide');
	});
	it('keeps the pick while it is offered and never draws a device the project turned off', () => {
		expect(effectiveDevice('tablet', all, 1200)).toBe('tablet');
		expect(effectiveDevice('tablet', ['phone'], 1200)).toBe('phone');
		expect(effectiveDevice(undefined, ['phone'], 1200)).toBe('phone');
		expect(effectiveDevice(undefined, all, 300)).toBe('phone');
	});
});
