import { describe, expect, it } from 'vitest';
import { parseDevice } from './device';

const CHROME_WIN =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE_WIN = `${CHROME_WIN} Edg/130.0.0.0`;
const SAFARI_MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const SAFARI_IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID_PHONE =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const CHROME_ANDROID_TABLET =
	'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

describe('parseDevice', () => {
	it('names the browser and the system', () => {
		expect(parseDevice(CHROME_WIN)).toEqual({ kind: 'desktop', name: 'Chrome on Windows' });
		expect(parseDevice(SAFARI_MAC)).toEqual({ kind: 'desktop', name: 'Safari on macOS' });
		expect(parseDevice(FIREFOX_LINUX)).toEqual({ kind: 'desktop', name: 'Firefox on Linux' });
	});

	it('picks Edge before Chrome, which Edge also names', () => {
		expect(parseDevice(EDGE_WIN).name).toBe('Edge on Windows');
	});

	it('tells a phone from a tablet', () => {
		expect(parseDevice(SAFARI_IPHONE)).toEqual({ kind: 'phone', name: 'Safari on iPhone' });
		expect(parseDevice(CHROME_ANDROID_PHONE)).toEqual({
			kind: 'phone',
			name: 'Chrome on Android'
		});
		expect(parseDevice(CHROME_ANDROID_TABLET).kind).toBe('tablet');
	});

	it('falls back to a plain name for an empty or unknown agent', () => {
		expect(parseDevice('')).toEqual({ kind: 'desktop', name: 'A browser' });
		expect(parseDevice(null).name).toBe('A browser');
		expect(parseDevice('afb-cli/1.2.0').name).toBe('afb-cli');
		expect(parseDevice('x'.repeat(200)).name).toBe('A browser');
	});
});
