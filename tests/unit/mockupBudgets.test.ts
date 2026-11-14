// WHAT A MOCKUP PAGE COSTS TO READ AND THE BUDGET WARNINGS (AFB-20261114-0409, B.4)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { lintMockupBudgets, readCostOf } from '../../src/lib/server/mockups/budgets';

// -- CONSTANTS -- //

const PICTURE = `<img alt="" src="data:image/webp;base64,${'A'.repeat(3000)}">`;

// -- FUNCTIONS -- //

describe('mockup read cost and budgets', () => {
	it('counts only the authored source as the cost of reading', () => {
		const html = `<html><body>${PICTURE}<p>${'text '.repeat(2000)}</p></body></html>`;
		const cost = readCostOf(html);
		expect(cost.excludedChars).toBe(3000);
		expect(cost.authoredChars).toBe(html.length - 3000);
		expect(cost.readCalls).toBe(Math.ceil(cost.authoredChars / 12_000));
		expect(cost.estimatedTokens).toBe(Math.round(cost.authoredChars / 4));
	});

	it('warns about embedded pictures, own CSS next to a kit, heavy script, buried keyframes and repeated markup', () => {
		const rows = Array.from(
			{ length: 80 },
			(_, i) =>
				`<li class="row"><span class="name">Patient ${i}</span><span class="time">09:${i}</span><button type="button" class="btn">Open</button></li>`
		).join('');
		const html = `<html><head><style>${'.a{color:red}'.repeat(2500)}</style><style data-afb-generated>@keyframes drop{from{opacity:0}to{opacity:1}}</style></head><body>${PICTURE}<ul>${rows}</ul><script>${'var a=1;'.repeat(6000)}</script></body></html>`;
		const text = lintMockupBudgets(html, true).join('\n');
		expect(text).toMatch(/picture is embedded/);
		expect(text).toMatch(/its own CSS although the project has a kit/);
		expect(text).toMatch(/page script is/);
		expect(text).toMatch(/Keyframes are inside generated CSS/);
		expect(text).toMatch(/Markup repeats heavily/);
		// With no kit the CSS has nowhere else to live
		expect(lintMockupBudgets(html, false).join('\n')).not.toMatch(/its own CSS/);
	});

	it('has nothing to say about a small, clean page', () => {
		expect(
			lintMockupBudgets(
				'<html><head><style>.a{color:red}</style></head><body><main data-ref="screen-a">Hello</main></body></html>',
				true
			)
		).toEqual([]);
	});
});
