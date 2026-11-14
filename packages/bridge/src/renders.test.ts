// THE RENDERS TAKEN AFTER A PUSH (AFB-20261114-0409, C.2): WHICH SCREENS A PAGE DECLARES, AND THE UPLOAD OF EACH RENDER

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { DEFAULT_RENDER_WIDTHS, screensOfPage } from './renders.js';

// -- FUNCTIONS -- //

describe('renders after a push', () => {
	it('reads the screens a page declares in its afb-config tag, in order', () => {
		const html = `<head><meta name="afb-config" content='{"screens": [["today", "Today"], ["consult", "Consultation"], ["x y", "Bad"]], "options": []}'></head>`;
		expect(screensOfPage(html)).toEqual(['today', 'consult']);
	});

	it('has no screens for a page that declares none or whose tag is not valid JSON', () => {
		expect(screensOfPage('<html></html>')).toEqual([]);
		expect(screensOfPage(`<meta name="afb-config" content='not json'>`)).toEqual([]);
		expect(screensOfPage(`<meta name="afb-config" content='{"options": []}'>`)).toEqual([]);
	});

	it('uses the four viewer widths unless told otherwise', () => {
		expect(DEFAULT_RENDER_WIDTHS).toEqual([408, 820, 1280, 1600]);
	});
});
