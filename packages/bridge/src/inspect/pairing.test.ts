// PAIRING CONTRACT AND NORMALISATION UNIT TESTS (STEP B.8, AFB-20261113-1008)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	applyStateDriverToUrl,
	colorsMatch,
	compareInspections,
	expandPxBox,
	normalizeColor,
	normalizeFontFamily,
	parseFreeRulesFromBrief,
	type InspectDump,
	type PairingManifest
} from './pairing.js';

// -- FUNCTIONS -- //

const dump = (
	target: 'mockup' | 'app',
	elements: InspectDump['elements'],
	unlistedRefs?: string[]
): InspectDump => ({
	target,
	screen: 'board',
	state: 'default',
	width: 1440,
	url: target === 'mockup' ? 'https://mockups.test/mf/1' : 'http://127.0.0.1:4173/',
	elements,
	unlistedRefs
});

const baseEl = (
	ref: string,
	selector: string,
	overrides: Partial<InspectDump['elements'][number]> = {}
) => ({
	ref,
	selector,
	present: true,
	visible: true,
	box: { x: 20, y: 40, w: 300, h: 48 },
	styles: {
		display: 'flex',
		borderRadius: '8px',
		backgroundColor: 'rgb(255, 255, 255)',
		color: 'rgb(17, 24, 39)',
		fontFamily: '"Poppins", sans-serif',
		fontSize: '16px',
		fontWeight: '600',
		padding: '12px 16px',
		gap: '8px',
		opacity: '1'
	},
	text: 'Save plan',
	...overrides
});

describe('pairing contract (Step B.8)', () => {
	it('normalises computed rgb/hex/space colours and resolved token references identically', () => {
		const tokens = { '--surface': '#ffffff', '--ink': 'rgb(17, 24, 39)' };
		expect(normalizeColor('rgb(255 255 255 / 1)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(normalizeColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		expect(normalizeColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
		expect(colorsMatch('var(--surface)', 'rgb(255, 255, 255)', 0, 0.01, tokens).equal).toBe(true);
		expect(colorsMatch('var(--ink)', '#111827', 0, 0.01, tokens).equal).toBe(true);
		expect(colorsMatch('rgb(17, 24, 39)', 'rgb(18, 24, 39)', 0).equal).toBe(false);
		expect(normalizeFontFamily('  "Bricolage Grotesque", Poppins, sans-serif ')).toBe(
			'bricolage grotesque, poppins, sans-serif'
		);
		expect(expandPxBox('12px')).toEqual([12, 12, 12, 12]);
	});

	it('drives query/hash states and refuses manual states cleanly without pretending URLs work', () => {
		expect(
			applyStateDriverToUrl('http://127.0.0.1:4173/plan', 'board', {
				state: 'empty',
				mode: 'query'
			})
		).toEqual({
			url: 'http://127.0.0.1:4173/plan?screen=board&state=empty',
			manualRequired: false,
			mode: 'query'
		});
		expect(
			applyStateDriverToUrl('http://127.0.0.1:4173/plan', 'board', {
				state: 'offline',
				mode: 'hash',
				param: 'state',
				value: 'offline'
			})
		).toEqual({
			url: 'http://127.0.0.1:4173/plan#screen=board&state=offline',
			manualRequired: false,
			mode: 'hash'
		});
		expect(
			applyStateDriverToUrl('http://127.0.0.1:4173/plan', 'board', {
				state: '2fa-challenge',
				mode: 'manual',
				instructions: 'Confirm device code in authenticator.'
			}).manualRequired
		).toBe(true);
	});

	it('never reports unpaired, missing or hidden elements as a pass, placing every gap into notCompared', () => {
		const mDump = dump('mockup', [baseEl('cta', '[data-ref="cta"]')], ['cta', 'extra-badge']);
		const aDump = dump('app', [baseEl('cta', 'button.save')]);
		const manifest: PairingManifest = {
			pairs: [{ ref: 'cta', appSelector: 'button.save' }]
		};
		const res = compareInspections(mDump, aDump, manifest);
		expect(res.passed).toBe(false);
		expect(res.mismatches).toEqual([]);
		expect(res.notCompared).toEqual([
			expect.objectContaining({ ref: 'extra-badge', reason: 'unmapped-mockup-ref' })
		]);

		// Empty manifest also lands in notCompared and fails
		expect(compareInspections(mDump, aDump, { pairs: [] }).passed).toBe(false);
	});

	it('enforces tight defaults (2px pos/size, 1px radius/padding, exact colour/font/text) and honours structured Free rules & overrides', () => {
		const mEl = baseEl('cta', '[data-ref="cta"]');
		// Within 2px pos & 1px radius -> passes; >2px fails; wrong colour fails unless waived
		const withinTolApp = baseEl('cta', 'button.save', {
			box: { x: 22, y: 38, w: 298, h: 50 },
			styles: {
				...mEl.styles,
				borderRadius: '9px 7px 8px 8px',
				padding: '13px 15px',
				fontWeight: '600'
			}
		});
		const clean = compareInspections(dump('mockup', [mEl]), dump('app', [withinTolApp]), {
			pairs: [{ ref: 'cta', appSelector: 'button.save' }]
		});
		expect(clean.passed).toBe(true);

		const driftedApp = baseEl('cta', 'button.save', {
			box: { x: 25, y: 40, w: 300, h: 48 },
			styles: { ...mEl.styles, color: 'rgb(200, 0, 0)', borderRadius: '11px' },
			text: 'Publish plan'
		});
		const failed = compareInspections(dump('mockup', [mEl]), dump('app', [driftedApp]), {
			pairs: [{ ref: 'cta', appSelector: 'button.save' }]
		});
		expect(failed.passed).toBe(false);
		expect(failed.mismatches.map((m) => m.property)).toEqual([
			'color',
			'text',
			'x',
			'borderRadius'
		]);

		const briefFree = parseFreeRulesFromBrief(`
### Free
- hero-art | backgroundColor, color | Illustration colours are free
- data-ref="cta" | borderRadius | System modal radius applies
`);
		expect(briefFree).toHaveLength(3);

		const waived = compareInspections(dump('mockup', [mEl]), dump('app', [driftedApp]), {
			pairs: [{ ref: 'cta', appSelector: 'button.save' }],
			free: briefFree,
			overrides: [
				{ ref: 'cta', property: 'color', reason: 'Status badge uses live semantic token' },
				{ ref: 'cta', property: 'text', reason: 'Copy updated in plan decision 2' },
				{ ref: 'cta', property: 'x', tolerancePx: 5, reason: 'Dynamic nav offset approved' }
			]
		});
		expect(waived.passed).toBe(true);
		expect(waived.waived).toHaveLength(4);
	});

	it('compares motion: transition and animation durations, easing and presence, never colours of time (AFB-20261114-0409, C.3)', () => {
		const motion = (over: Record<string, string>) => ({
			transitionProperty: 'transform, opacity',
			transitionDuration: '0.28s, 0.18s',
			transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1), ease-out',
			transitionDelay: '0s, 0s',
			animationName: 'none',
			animationDuration: '0s',
			animationIterationCount: '1',
			...over
		});
		const mEl = baseEl('card', '[data-ref="card"]', {
			styles: { ...baseEl('c', 's').styles, ...motion({}) }
		});
		const pair = { pairs: [{ ref: 'card', appSelector: '.card' }] };
		const run = (over: Record<string, string>) =>
			compareInspections(
				dump('mockup', [mEl]),
				dump('app', [baseEl('card', '.card', { styles: { ...mEl.styles, ...over } })]),
				pair
			);
		// The same motion in another unit and spelling is the same motion; a few milliseconds are inside the tolerance
		expect(
			run({
				transitionDuration: '280ms, 180ms',
				transitionTimingFunction: 'cubic-bezier(0.2,0,0,1), ease-out'
			}).passed
		).toBe(true);
		expect(run({ transitionDuration: '0.29s, 0.18s' }).passed).toBe(true);
		// A different duration, easing or a missing transition is a mismatch
		expect(run({ transitionDuration: '0.5s, 0.18s' }).mismatches.map((m) => m.property)).toEqual([
			'transitionDuration'
		]);
		expect(
			run({ transitionTimingFunction: 'linear, ease-out' }).mismatches.map((m) => m.property)
		).toEqual(['transitionTimingFunction']);
		expect(run({ transitionDuration: '0s, 0s' }).mismatches.map((m) => m.property)).toContain(
			'transitionDuration'
		);
		// With no transition on either side the property list does not matter
		const still = (over: Record<string, string>) => ({
			...mEl.styles,
			transitionDuration: '0s',
			transitionProperty: 'all',
			...over
		});
		expect(
			compareInspections(
				dump('mockup', [{ ...mEl, styles: still({}) }]),
				dump('app', [baseEl('card', '.card', { styles: still({ transitionProperty: 'color' }) })]),
				pair
			).passed
		).toBe(true);
		// An animation that runs on one side only, or for another time, is a mismatch
		expect(
			run({ animationName: 'drop', animationDuration: '0.3s' })
				.mismatches.map((m) => m.property)
				.sort()
		).toEqual(['animationDuration', 'animationName']);
		// Motion can be waived like any other property
		const freed = compareInspections(
			dump('mockup', [mEl]),
			dump('app', [
				baseEl('card', '.card', { styles: { ...mEl.styles, transitionDuration: '0.5s, 0.18s' } })
			]),
			{
				...pair,
				free: [
					{ ref: 'card', property: 'transitionDuration', reason: 'Real Tailwind duration scale' }
				]
			}
		);
		expect(freed.passed).toBe(true);
		expect(freed.waived).toHaveLength(1);
	});
});
