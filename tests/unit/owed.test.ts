// OWED LIVE ACTIONS: THE CHECKBOX LINES OF THE OWED SECTION, OPEN ONES ONLY, BOUNDED (AFB-20261125-1527)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { parseOwed } from '../../src/lib/server/ops/owed';

describe('owed lines', () => {
	it('reads open lines of every kind and leaves ticked ones out', () => {
		const body = [
			'What this plan still owes:',
			'- [ ] migration: apply 0059 on the live database',
			'- [x] deploy: yarn deploy:vps',
			'* [ ] owner-check: look at the settings tab on a phone',
			'- [X] proof: done already',
			'- [ ] test-data: remove the demo pitfalls',
			'- [ ] someday: a kind the board does not know'
		].join('\r\n');
		expect(parseOwed(body)).toEqual([
			{ kind: 'migration', text: 'apply 0059 on the live database' },
			{ kind: 'owner-check', text: 'look at the settings tab on a phone' },
			{ kind: 'test-data', text: 'remove the demo pitfalls' },
			{ kind: 'other', text: 'a kind the board does not know' }
		]);
	});

	it('keeps a long line, cut, and a kind written in capitals', () => {
		const owed = parseOwed(`- [ ] Migration: ${'z '.repeat(300)}\n- [ ] PROOF: once more`);
		expect(owed.map((o) => o.kind)).toEqual(['migration', 'proof']);
		expect(owed[0].text.length).toBeLessThanOrEqual(301);
	});

	it('ignores prose and plain bullets, and stops at ten lines', () => {
		expect(parseOwed('Nothing is owed.\n- a plain bullet\n- [ ]no kind here')).toEqual([]);
		const many = Array.from({ length: 30 }, (_, i) => `- [ ] proof: item ${i}`).join('\n');
		expect(parseOwed(many)).toHaveLength(10);
		expect(parseOwed(null)).toEqual([]);
	});

	it('stays fast on hostile text', () => {
		const t0 = Date.now();
		parseOwed(`- [ ] proof: ${'['.repeat(100_000)}\n`.repeat(3));
		expect(Date.now() - t0).toBeLessThan(1_000);
	});
});
