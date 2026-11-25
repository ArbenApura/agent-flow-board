// ITEM_GET NOTES: WHAT A PLAN LEARNED COMES BACK NEARLY WHOLE, THE RESUME AND BLOCKERS STAY SHORT (AFB-20261125-1527)

// IMPORTED TYPES
import type { ItemDetail } from '../../src/lib/server/ops/items';
// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { summarize } from '../../src/lib/server/mcp/tools';

// The smallest item detail summarize reads: no phases, no decisions, four note sections
const detail = (bodies: Record<string, string>) =>
	({
		item: {
			id: 'i1',
			ref: 'AFB-20261125-0001',
			title: 'A plan',
			tabName: null,
			status: 'COMPLETED',
			percent: 100,
			version: 1,
			visibility: 'public',
			createdAt: new Date(0),
			health: { drift: [] }
		},
		creator: null,
		family: { parents: {}, kids: {} },
		phases: [],
		decisions: [],
		sections: Object.entries(bodies).map(([slug, body]) => ({ slug, title: slug, body }))
	}) as unknown as ItemDetail;

describe('item_get notes', () => {
	const long = (n: number) => 'x'.repeat(n);

	it('returns a 4000-character lessons note whole with the fields option notes', () => {
		const out = summarize(detail({ lessons: long(4000), 'learned-from': long(3000) }), ['notes']);
		expect(out.lessons).toBe(long(4000));
		expect(out.learnedFrom).toBe(long(3000));
	});

	it('keeps the resume and blockers notes at 1200 characters, with the way to the rest', () => {
		const out = summarize(detail({ 'resume-here': long(2000), blockers: long(1300) }), ['notes']);
		expect(String(out.resume)).toMatch(
			/^x{1200}\.\.\. \(2000 characters, read all of it with item_doc section:resume-here\)$/
		);
		expect(String(out.blockers)).toContain('section:blockers');
	});

	it('cuts a lessons note past 6000 characters and names item_doc', () => {
		const out = summarize(detail({ lessons: long(7000) }), ['notes']);
		expect(String(out.lessons)).toMatch(/^x{6000}\.\.\. \(7000 characters/);
	});

	it('stays short without the notes option', () => {
		const out = summarize(detail({ lessons: long(4000) }));
		expect(String(out.lessons).startsWith(`${long(300)}...`)).toBe(true);
	});
});
