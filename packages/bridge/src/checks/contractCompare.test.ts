// A MOCKUP CONTRACT GIVES COMPARE ITS PAIRING, FREE LINES AND STATES (AFB-20261114-0409, D.5)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { fetchMockupContract, manifestFromContract } from './compare.js';

// -- FUNCTIONS -- //

describe('the contract of a mockup in compare', () => {
	const contract = {
		refs: [
			{ ref: 'nav', binding: 'keep' },
			{ ref: 'cta', binding: 'free', property: 'borderRadius', reason: 'System radius' },
			{ ref: 'hero', binding: 'free', reason: 'Illustration is free' }
		],
		pairs: [{ ref: 'nav', appSelector: 'nav.main' }],
		states: [
			{ name: 'loading', hook: 'query' },
			{ name: 'offline', hook: 'manual' }
		]
	};

	it('turns pairs, free lines and states into a manifest', () => {
		const m = manifestFromContract(contract);
		expect(m.pairs).toEqual([{ ref: 'nav', appSelector: 'nav.main' }]);
		expect(m.free).toEqual([
			{ ref: 'cta', property: 'borderRadius', reason: 'System radius' },
			{ ref: 'hero', property: '*', reason: 'Illustration is free' }
		]);
		expect(m.stateDrivers).toEqual([
			{ state: 'loading', mode: 'query' },
			{ state: 'offline', mode: 'manual' }
		]);
	});

	it('lets what the person passed win: their pairs replace the contract pairs and their free rules are added', () => {
		const m = manifestFromContract(contract, {
			pairs: [{ ref: 'nav', appSelector: 'aside nav' }],
			free: [{ ref: 'logo', property: 'color', reason: 'Brand blue differs' }]
		});
		expect(m.pairs).toEqual([{ ref: 'nav', appSelector: 'aside nav' }]);
		expect(m.free).toHaveLength(3);
		expect(m.free?.[0].ref).toBe('logo');
	});

	it('reads the contract from the board and treats a missing one, or a failure, as no contract', async () => {
		const base = {
			server: 'https://board.test',
			org: 'acme',
			token: 't',
			mockup: 'm-1@2',
			log: () => undefined
		};
		let url = '';
		const ok = await fetchMockupContract({
			...base,
			fetch: async (u) => {
				url = u;
				return new Response(JSON.stringify({ version: 2, contract }), { status: 200 });
			}
		});
		expect(url).toBe('https://board.test/api/v1/orgs/acme/mockups/m-1/contract?version=2');
		expect(ok?.pairs).toHaveLength(1);
		expect(
			await fetchMockupContract({
				...base,
				fetch: async () => new Response('null', { status: 200 })
			})
		).toBeNull();
		expect(
			await fetchMockupContract({ ...base, fetch: async () => new Response('no', { status: 404 }) })
		).toBeNull();
	});
});
