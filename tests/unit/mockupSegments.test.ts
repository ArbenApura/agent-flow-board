// THE PARTS OF A MOCKUP PAGE AND ITS MACHINE OUTPUT (AFB-20261114-0409, B.2 AND B.3)

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	diffSegments,
	rangeChars,
	segmentMockupHtml,
	subtractRanges
} from '../../src/lib/server/mockups/segments';

// -- CONSTANTS -- //

const PAYLOAD = 'A'.repeat(900);
const SPRITE = `<svg width="0" height="0" aria-hidden="true"><defs>${['a', 'b', 'c', 'd']
	.map(
		(n) =>
			`<symbol id="i-${n}" viewBox="0 0 24 24"><path d="${'M0 0h24v24H0z'.repeat(60)}"/></symbol>`
	)
	.join('')}</defs></svg>`;
const page = (extra = '') => `<!doctype html><html data-screen="today"><head><meta charset="utf-8">
<!--afb-kit-->
<style>.card{padding:8px}</style>
<style data-afb-generated>.flex{display:flex}</style>
</head><body>${SPRITE}
<div class="app"><nav data-ref="nav">Nav</nav>
<section class="screen" data-ref="screen-today"><div>Today <section>inner</section></div></section>
<section class="screen" data-ref="screen-consult">Consult</section></div>
<template id="t-lab"><div>Lab sheet</div></template>
<img class="logo" src="data:image/webp;base64,${PAYLOAD}" alt="Dokoli">${extra}
<script>const go = () => 1;</script></body></html>`;

// -- FUNCTIONS -- //

describe('mockup segments', () => {
	it('cuts a page into parts that cover it once, with stable keys', () => {
		const html = page();
		const { segments } = segmentMockupHtml(html);
		expect(segments[0].start).toBe(0);
		expect(segments[segments.length - 1].end).toBe(html.length);
		for (let i = 1; i < segments.length; i++) expect(segments[i].start).toBe(segments[i - 1].end);
		const keys = segments.map((s) => s.key);
		expect(keys).toEqual(
			expect.arrayContaining([
				'screen:today',
				'screen:consult',
				'surface:lab',
				'behavior:1',
				'style:1'
			])
		);
		expect(new Set(keys).size).toBe(keys.length);
		// A nested section is part of its screen, never a screen of its own
		const today = segments.find((s) => s.key === 'screen:today')!;
		expect(html.slice(today.start, today.end)).toContain('inner');
		expect(html.slice(today.start, today.end).endsWith('</section>')).toBe(true);
	});

	it('lists pictures, the icon sprite and generated style as machine output', () => {
		const html = page();
		const { excluded } = segmentMockupHtml(html);
		const covered = rangeChars(excluded);
		expect(covered).toBeGreaterThan(PAYLOAD.length + SPRITE.length);
		const at = html.indexOf(PAYLOAD);
		expect(excluded.some(([a, b]) => a <= at && b >= at + PAYLOAD.length)).toBe(true);
		const sprite = html.indexOf('<svg width="0"');
		expect(excluded.some(([a, b]) => a <= sprite && b >= sprite + SPRITE.length)).toBe(true);
		const gen = html.indexOf('<style data-afb-generated');
		expect(excluded.some(([a, b]) => a <= gen && b > gen)).toBe(true);
		// Authored style, script and markup are never excluded
		const authored = html.indexOf('.card{padding');
		expect(excluded.some(([a, b]) => a <= authored && b > authored)).toBe(false);
	});

	it('reads generated style that holds keyframes, because motion buried there would be lost', () => {
		const html = `<html><head><style data-afb-generated>.flex{display:flex}</style><style data-afb-generated>@keyframes drop{from{opacity:0}}</style></head><body></body></html>`;
		const { excluded, segments } = segmentMockupHtml(html);
		const keyframes = html.indexOf('@keyframes');
		const flex = html.indexOf('.flex');
		expect(excluded.some(([a, b]) => a <= flex && b > flex)).toBe(true);
		expect(excluded.some(([a, b]) => a <= keyframes && b > keyframes)).toBe(false);
		// And it is a style part, so the inventory finds the motion in it
		expect(
			segments.some((s) => s.kind === 'style' && html.slice(s.start, s.end).includes('@keyframes'))
		).toBe(true);
	});

	it('keeps every key unique, also when a name repeats next to a name that already ends in a number', () => {
		const html = `<section data-ref="screen-today">a</section><section data-ref="screen-today-2">b</section><section data-ref="screen-today">c</section>`;
		const keys = segmentMockupHtml(html).segments.map((s) => s.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toEqual(expect.arrayContaining(['screen:today', 'screen:today-2']));
	});

	it('keeps small inline data and a hidden svg that is not a sprite as authored source', () => {
		const html = `<html><body><svg aria-hidden="true"><path d="M0 0"/></svg><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></body></html>`;
		expect(segmentMockupHtml(html).excluded).toEqual([]);
	});

	it('says which parts changed between two versions', () => {
		const a = segmentMockupHtml(page()).segments;
		const b = segmentMockupHtml(page().replace('Consult', 'Consultation')).segments;
		expect(diffSegments(a, b)).toMatchObject({
			changed: ['screen:consult'],
			added: [],
			removed: []
		});
		const c = segmentMockupHtml(
			page().replace('</body>', '<template id="t-rx">Rx</template></body>')
		).segments;
		expect(diffSegments(a, c).added).toContain('surface:rx');
	});

	it('subtracts ranges', () => {
		expect(
			subtractRanges(0, 10, [
				[2, 4],
				[8, 20]
			])
		).toEqual([
			[0, 2],
			[4, 8]
		]);
		expect(subtractRanges(0, 10, [[0, 10]])).toEqual([]);
	});
});
