// THE GEOMETRY OF THE DEVICE FRAMES AROUND A MOCKUP: SCREEN SIZES, THE CHROME OF EACH DEVICE, THE SCALE TO A STAGE AND THE DEVICES A PROJECT OFFERS

// IMPORTED TYPES
import type { ScreenKey } from '#lib/board/mockups.js';
// IMPORTED CONSTANTS
import { ALL_SCREENS, SCREEN_WIDTH, screensOf } from '#lib/board/mockups.js';

// -- TYPES -- //

export type DeviceKind = 'browser' | 'tablet' | 'phone';
export type FrameSize = {
	kind: DeviceKind;
	/** The real viewport of the device: what the mockup is laid out in. */
	screenWidth: number;
	screenHeight: number;
	/** The whole frame, chrome and edge included. */
	width: number;
	height: number;
	/** Space between the frame's outer edge and the screen. */
	top: number;
	side: number;
	bottom: number;
};

// -- CONSTANTS -- //

export const SCREEN_HEIGHT: Record<ScreenKey, number> = {
	wide: 900,
	laptop: 800,
	tablet: 1100,
	phone: 840
};
export const DEVICE_KIND: Record<ScreenKey, DeviceKind> = {
	wide: 'browser',
	laptop: 'browser',
	tablet: 'tablet',
	phone: 'phone'
};
/** The title bar of a browser window. */
export const BROWSER_BAR = 40;
export const TABLET_BEZEL = 14;
export const PHONE_BEZEL = 12;
/** The 1 px line around every frame. */
export const FRAME_EDGE = 1;
/** A stage narrower than this shows the phone first. */
export const NARROW_STAGE = 480;

// -- FUNCTIONS -- //

/** The size of one device frame and where its screen sits. */
export function frameSize(screen: ScreenKey): FrameSize {
	const kind = DEVICE_KIND[screen];
	const screenWidth = SCREEN_WIDTH[screen];
	const screenHeight = SCREEN_HEIGHT[screen];
	const bezel = kind === 'tablet' ? TABLET_BEZEL : kind === 'phone' ? PHONE_BEZEL : 0;
	const top = FRAME_EDGE + (kind === 'browser' ? BROWSER_BAR : bezel);
	const side = FRAME_EDGE + bezel;
	const bottom = FRAME_EDGE + bezel;
	return {
		kind,
		screenWidth,
		screenHeight,
		width: screenWidth + side * 2,
		height: screenHeight + top + bottom,
		top,
		side,
		bottom
	};
}

/** How much the whole frame is shrunk to fit a stage `available` pixels wide. Never larger than life. */
export function fitScale(available: number, screen: ScreenKey): number {
	const width = frameSize(screen).width;
	if (!Number.isFinite(available) || available <= 0) return 1;
	return Math.min(1, Math.floor((available / width) * 1000) / 1000);
}

/** The devices a project offers, in the fixed order. Never empty. */
export const offeredDevices = (saved: string[] | null | undefined): ScreenKey[] => screensOf(saved);

/** True when the project offers more than one device, so a switch is worth showing. */
export const showsSwitch = (offered: ScreenKey[]): boolean => offered.length > 1;

/** The smallest a frame is drawn by default: below this the mockup is too small to read, so the next device down is shown. */
export const MIN_DEFAULT_SCALE = 0.6;
/** The order a device is tried in: the widest first, the phone last. */
const DEFAULT_ORDER: ScreenKey[] = ['wide', 'laptop', 'tablet', 'phone'];

/**
 * The device shown first: the widest one offered that fits the stage without shrinking below 60 percent (wide, then laptop, then
 * tablet, then phone). An unknown stage width starts on the widest, and a stage with room for none shows the smallest offered.
 */
export function firstDevice(offered: ScreenKey[], available: number): ScreenKey {
	const list = DEFAULT_ORDER.filter((s) => (offered.length ? offered : ALL_SCREENS).includes(s));
	if (!list.length) return ALL_SCREENS[0];
	if (!(available > 0)) return list[0];
	if (available < NARROW_STAGE && list.includes('phone')) return 'phone';
	return list.find((s) => fitScale(available, s) >= MIN_DEFAULT_SCALE) ?? list[list.length - 1];
}

/** The device to draw: the person's pick while the project still offers it, otherwise the first one. Never an effect, so no wrong frame is drawn first. */
export function effectiveDevice(
	picked: ScreenKey | undefined,
	offered: ScreenKey[],
	available: number
): ScreenKey {
	return picked && offered.includes(picked) ? picked : firstDevice(offered, available);
}
