// COMPOSING A MOCKUP FROM ITS PARTS, AND ITS CONTRACT (AFB-20261114-0409, D.2 AND D.5)

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { composeMockup, notesFromContract, renderPart } from '../../src/lib/server/mockups/compose';
import {
	contractProblems,
	freeRulesOf,
	parseContract
} from '../../src/lib/server/mockups/contract';
import { segmentMockupHtml } from '../../src/lib/server/mockups/segments';

// -- CONSTANTS -- //

const SKELETON = `<!doctype html><html><head><!--afb-part:head--><!--afb-kit--><!--afb-part:styles--><!--afb-generated--></head><body>
<div class="app"><nav data-ref="nav">Nav</nav><main><!--afb-part:screens--></main></div>
<!--afb-part:surfaces--><!--afb-part:fixtures--><!--afb-part:behavior--></body></html>`;

// -- FUNCTIONS -- //

describe('composing a mockup', () => {
	it('puts every part in its slot, wraps styles, motion, fixtures and behaviour, and leaves empty slots empty', () => {
		const { html, slots } = composeMockup(SKELETON, [
			{ kind: 'head', key: 'meta', content: '<meta charset="utf-8"><title>T</title>' },
			{ kind: 'style', key: 'page', content: '.a{color:red}' },
			{ kind: 'motion', key: 'motion', content: '@keyframes drop{from{opacity:0}}' },
			{ kind: 'screen', key: 'today', content: '<section data-ref="screen-today">Today</section>' },
			{
				kind: 'screen',
				key: 'consult',
				content: '<section data-ref="screen-consult">Consult</section>'
			},
			{ kind: 'surface', key: 'lab', content: '<template id="t-lab">Lab</template>' },
			{ kind: 'fixtures', key: 'rows', content: '{"n":3}' },
			{ kind: 'behavior', key: 'main', content: 'const x = "</script>";' },
			{ kind: 'contract', key: 'contract', content: '{}' }
		]);
		expect(slots).toContain('<!--afb-part:screens-->');
		expect(html).not.toContain('afb-part:');
		// The marker the board fills with the kit, and the one the bridge fills with generated style, are left alone
		expect(html).toContain('<!--afb-kit-->');
		expect(html).toContain('<!--afb-generated-->');
		expect(html.indexOf('screen-today')).toBeLessThan(html.indexOf('screen-consult'));
		expect(html).toContain('<style data-afb-part="motion:motion">');
		expect(html).toContain('<script type="application/json" id="fixtures-rows"');
		// A closing script tag inside behaviour cannot end the block early; the contract never goes into the page
		expect(html).not.toContain('"</script>"');
		expect(html).not.toContain('{}');
		// The composed page is cut into the parts a reader asks for
		const keys = segmentMockupHtml(html).segments.map((s) => s.key);
		expect(keys).toEqual(expect.arrayContaining(['screen:today', 'screen:consult', 'surface:lab']));
	});

	it('refuses a part with no slot by name, and leaves a slot with no parts empty', () => {
		expect(() =>
			composeMockup('<html><head></head><body><!--afb-part:screens--></body></html>', [
				{ kind: 'behavior', key: 'main', content: 'go()' }
			])
		).toThrow(/no <!--afb-part:behavior-->/);
		expect(composeMockup('<html><body><!--afb-part:screens--></body></html>', []).html).toBe(
			'<html><body></body></html>'
		);
	});

	it('renders each kind of part', () => {
		expect(renderPart({ kind: 'screen', key: 'a', content: '<p>x</p>' })).toBe('<p>x</p>');
		expect(renderPart({ kind: 'style', key: 'a', content: 'a{}' })).toContain(
			'data-afb-part="style:a"'
		);
		// The @apply source stays readable in the page but is never applied
		expect(renderPart({ kind: 'style', key: 'apply', content: 'a{@apply p-2;}' })).toContain(
			'<style media="not all" data-afb-part="style:apply">'
		);
	});
});

describe('the mockup contract', () => {
	const good = JSON.stringify({
		refs: [
			{ ref: 'nav', binding: 'keep' },
			{
				ref: 'cta',
				binding: 'free',
				property: 'borderRadius',
				reason: 'System modal radius applies'
			},
			{ ref: 'logo', binding: 'bound' }
		],
		pairs: [{ ref: 'nav', appSelector: 'nav.main' }],
		widths: [408, 1280],
		states: [{ name: 'loading', hook: 'query' }]
	});

	it('reads a valid contract and refuses a broken one in one sentence', () => {
		const c = parseContract(good);
		expect(c.refs).toHaveLength(3);
		expect(() => parseContract('nope')).toThrow(/not valid JSON/);
		expect(() => parseContract('{"refs":[{"ref":"a","binding":"maybe"}]}')).toThrow(/not valid/);
		expect(() => parseContract('{"widths":[10]}')).toThrow(/widths/);
	});

	it('finds refs the page does not have, and free lines with no reason', () => {
		const c = parseContract(good);
		const page = '<nav data-ref="nav"></nav><button data-ref="cta"></button>';
		expect(contractProblems(c, page).join(' ')).toMatch(
			/names 1 data-ref the page does not have \(logo\)/
		);
		expect(contractProblems(c, page + '<i data-ref="logo"></i>')).toEqual([]);
		const bare = parseContract('{"refs":[{"ref":"cta","binding":"free"}]}');
		expect(contractProblems(bare, page).join(' ')).toMatch(/no reason/);
	});

	it('gives compare its free rules and the notes their words', () => {
		const c = parseContract(good);
		expect(freeRulesOf(c)).toEqual([
			{ ref: 'cta', property: 'borderRadius', reason: 'System modal radius applies' }
		]);
		const notes = notesFromContract(c);
		expect(notes.keep).toContain('nav');
		expect(notes.free).toContain('cta (System modal radius applies)');
		expect(notesFromContract({})).toEqual({ keep: '', free: '' });
	});
});
