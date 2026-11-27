// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { orderOrgs, readMemory, rememberVisit, switchTarget, type KeyStore } from './orgSwitch';

// -- FUNCTIONS -- //

/** A storage that lives in a map, like localStorage in a browser. */
function memoryStore(): KeyStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v)
	};
}

/** A storage the browser blocks: every call throws. */
const blocked: KeyStore = {
	getItem: () => {
		throw new Error('blocked');
	},
	setItem: () => {
		throw new Error('blocked');
	}
};

const ORGS = [
	{ slug: 'zeta', name: 'Zeta' },
	{ slug: 'arbenger', name: 'Arbenger' },
	{ slug: 'mangoman', name: 'Mangoman' },
	{ slug: 'beta', name: 'Beta' }
];

describe('the organisation switcher order', () => {
	it('puts the current org first, then the recent ones, then the rest by name', () => {
		const order = orderOrgs(ORGS, 'arbenger', ['zeta', 'arbenger']);
		expect(order.map((o) => o.slug)).toEqual(['arbenger', 'zeta', 'beta', 'mangoman']);
	});

	it('never shows a remembered slug that is not one of the live orgs', () => {
		const order = orderOrgs(ORGS, 'beta', ['someone-elses-org', 'mangoman']);
		expect(order.map((o) => o.slug)).toEqual(['beta', 'mangoman', 'arbenger', 'zeta']);
	});
});

describe('where a switch lands', () => {
	it('goes to the project last opened in another org', () => {
		expect(switchTarget('mangoman', 'arbenger', { mangoman: 'MG' })).toBe('/mangoman/MG');
	});

	it('goes to the home of the current org, and of an org with no remembered project', () => {
		expect(switchTarget('arbenger', 'arbenger', { arbenger: 'AFB' })).toBe('/arbenger');
		expect(switchTarget('beta', 'arbenger', {})).toBe('/beta');
	});

	it('ignores a stored key that is not a project key', () => {
		expect(switchTarget('beta', 'arbenger', { beta: '../x' })).toBe('/beta');
		expect(switchTarget('beta', 'arbenger', { beta: '//evil.test' })).toBe('/beta');
	});
});

describe('what the browser remembers', () => {
	it('keeps the visit per person, newest first, with the last project', () => {
		const store = memoryStore();
		rememberVisit('u1', 'arbenger', 'AFB', store);
		rememberVisit('u1', 'mangoman', undefined, store);
		expect(readMemory('u1', store)).toEqual({
			recent: ['mangoman', 'arbenger'],
			last: { arbenger: 'AFB' }
		});
		// Another person on the same browser sees nothing of it
		expect(readMemory('u2', store)).toEqual({ recent: [], last: {} });
	});

	it('drops malformed or hostile stored values', () => {
		const store = memoryStore();
		store.data.set(
			'afb:org-switch:u1',
			JSON.stringify({
				recent: ['ok-org', 42, 'Bad/Slug'],
				last: { 'ok-org': 'a/b', other: 'AFB' }
			})
		);
		expect(readMemory('u1', store)).toEqual({ recent: ['ok-org'], last: { other: 'AFB' } });
		store.data.set('afb:org-switch:u1', 'not json');
		expect(readMemory('u1', store)).toEqual({ recent: [], last: {} });
	});

	it('works with storage that throws or is missing', () => {
		expect(() => rememberVisit('u1', 'arbenger', 'AFB', blocked)).not.toThrow();
		expect(readMemory('u1', blocked)).toEqual({ recent: [], last: {} });
		expect(readMemory('u1', null)).toEqual({ recent: [], last: {} });
	});
});
