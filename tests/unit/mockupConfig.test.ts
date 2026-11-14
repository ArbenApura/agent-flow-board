// WHAT A MOCKUP OFFERS: THE SCREENS AN OPTION APPLIES TO AND THE MESSAGE THAT A CHOICE CHANGED NOTHING (AFB-20261112-2350)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	optionApplies,
	parseConfigMessage,
	parseUnresponsiveMessage,
	visibleOptions,
	type FrameConfig
} from '../../src/lib/board/mockups';

// -- CONSTANTS -- //

const FRAME = {};
const VALUES = [
	['x', 'X'],
	['y', 'Y']
];
const SCREENS = [
	['a', 'A'],
	['b', 'B']
];

// -- FUNCTIONS -- //

const opt = (key: string, extra: Record<string, unknown> = {}) => ({
	key,
	label: key,
	values: VALUES,
	...extra
});
const parse = (options: unknown[], screens: unknown = SCREENS) =>
	parseConfigMessage(
		{ type: 'afb-config', config: { screens, options }, current: {} },
		FRAME,
		FRAME
	);

describe('an option that applies to some screens', () => {
	it('parses exactly as before when no option has a screens list', () => {
		const got = parse([opt('role')]);
		expect(got?.config.options).toEqual([
			{
				key: 'role',
				label: 'role',
				values: [
					{ value: 'x', label: 'X' },
					{ value: 'y', label: 'Y' }
				]
			}
		]);
		expect(got?.config.options[0]).not.toHaveProperty('screens');
	});
	it('keeps a list of declared screens', () => {
		expect(parse([opt('role', { screens: ['a'] })])?.config.options[0].screens).toEqual(['a']);
		expect(parse([opt('role', { screens: ['a', 'b'] })])?.config.options[0].screens).toEqual([
			'a',
			'b'
		]);
	});
	it('reads an empty list as every screen', () => {
		expect(parse([opt('role', { screens: [] })])?.config.options[0]).not.toHaveProperty('screens');
	});
	it('refuses only the option whose list is bad', () => {
		const bad: unknown[] = [
			['nope'],
			['a', 'a'],
			'a',
			null,
			[1],
			['__proto__'],
			['constructor'],
			['A'],
			Array.from({ length: 13 }, () => 'a')
		];
		for (const screens of bad) {
			const got = parse([opt('role', { screens }), opt('flag')]);
			expect(
				got?.config.options.map((o) => o.key),
				JSON.stringify(screens)
			).toEqual(['flag']);
		}
	});
	it('still refuses a key the contract does not know, and an option without a screen list on a page with no screens', () => {
		expect(parse([{ ...opt('role'), extra: 1 }])).toBeNull();
		expect(parse([opt('role', { screens: ['a'] })], [])?.config.options).toEqual([]);
	});
});

describe('which options are drawn', () => {
	const config: FrameConfig = {
		screens: [
			{ value: 'a', label: 'A' },
			{ value: 'b', label: 'B' }
		],
		options: [
			{ key: 'role', label: 'Role', values: [], screens: ['a'] },
			{ key: 'flag', label: 'Flag', values: [] },
			{ key: 'view', label: 'View', values: [], screens: ['b'] }
		]
	};
	it('shows an option on its screens only, and an option with no list everywhere', () => {
		expect(visibleOptions(config, 'a').map((o) => o.key)).toEqual(['role', 'flag']);
		expect(visibleOptions(config, 'b').map((o) => o.key)).toEqual(['flag', 'view']);
	});
	it('shows everything while the screen on show is not known', () => {
		expect(visibleOptions(config, undefined).map((o) => o.key)).toEqual(['role', 'flag', 'view']);
		expect(optionApplies(config.options[0], undefined)).toBe(true);
	});
});

describe('the message that a choice changed nothing', () => {
	const say = (data: unknown, from: unknown = FRAME) => parseUnresponsiveMessage(data, from, FRAME);
	it('is read when it is exactly in shape and comes from the frame', () => {
		expect(say({ type: 'afb-unresponsive', key: 'role', reason: 'none' })).toEqual({
			key: 'role',
			reason: 'none'
		});
		expect(say({ type: 'afb-unresponsive', key: 'screen', reason: 'error' })).toEqual({
			key: 'screen',
			reason: 'error'
		});
	});
	it('is refused from anything else', () => {
		expect(say({ type: 'afb-unresponsive', key: 'role', reason: 'none' }, {})).toBeNull();
		expect(say({ type: 'afb-unresponsive', key: 'Role!', reason: 'none' })).toBeNull();
		expect(say({ type: 'afb-unresponsive', key: 'role', reason: 'because' })).toBeNull();
		expect(say({ type: 'afb-unresponsive', key: 'role', reason: 'none', extra: 1 })).toBeNull();
		expect(say({ type: 'afb-unresponsive', key: 5, reason: 'none' })).toBeNull();
		expect(say(null)).toBeNull();
		expect(say([])).toBeNull();
	});
});
