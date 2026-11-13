// THE SCRIPT THE BOARD ADDS TO A MOCKUP: THE SCREENS AN OPTION APPLIES TO AND THE CHECK THAT A CHOICE CHANGED SOMETHING (AFB-20261112-2350)
// The script text is run in a node vm with a stub page, so what it posts to the board is what is asserted, not a search of its source.

// -- DEP-MODULES -- //
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { PIN_SCRIPT, PUBLIC_SCRIPT } from '../../src/lib/server/mockups/pinScript';

// -- TYPES -- //

type Posted = Record<string, unknown>;
type Stub = {
	style: Record<string, unknown>;
	attrs: Record<string, string>;
	[k: string]: unknown;
};

// -- CONSTANTS -- //

const SCRIPTS = [
	['the member script', PIN_SCRIPT],
	['the public script', PUBLIC_SCRIPT]
] as const;
const VALUES = '[["x","X"],["y","Y"]]';
const SCREENS = '[["a","A"],["b","B"]]';

// -- FUNCTIONS -- //

function element(): Stub {
	const e: Stub = {
		style: {},
		attrs: {},
		textContent: '',
		tagName: 'DIV',
		scrollHeight: 100,
		scrollWidth: 100,
		clientWidth: 100,
		clientHeight: 100,
		setAttribute(k: string, v: unknown) {
			e.attrs[k] = String(v);
		},
		getAttribute(k: string) {
			return k in e.attrs ? e.attrs[k] : null;
		},
		appendChild: (c: unknown) => c,
		addEventListener: () => undefined,
		contains: (x: unknown) => x === e,
		getElementsByTagName: () => []
	};
	return e;
}

/** Runs one of the scripts against a stub page that declares `meta`, and lets a test fire the board's messages and the timers. */
function boot(
	script: string,
	meta: string | null,
	opts: { afbSet?: () => void; restyle?: boolean; mutate?: boolean } = {}
) {
	const posts: Posted[] = [];
	const handlers: Record<string, (e: unknown) => void> = {};
	const timers: (() => void)[] = [];
	const root = element();
	const body = element();
	body.getElementsByTagName = () => [element(), element()];
	let tick = 0;
	const parent = { postMessage: (m: Posted) => posts.push(m) };
	const doc = {
		documentElement: root,
		body,
		createElement: () => element(),
		querySelector: (s: string) =>
			meta !== null && s.includes('afb-config') ? { getAttribute: () => meta } : null,
		addEventListener: () => undefined
	};
	class Observer {
		observe() {}
		disconnect() {}
		takeRecords() {
			return opts.mutate ? [{ type: 'childList', target: body, attributeName: null }] : [];
		}
	}
	const sandbox: Record<string, unknown> = {
		document: doc,
		parent,
		addEventListener: (type: string, h: (e: unknown) => void) => {
			handlers[type] = h;
		},
		getComputedStyle: () => ({
			display: 'block',
			visibility: 'visible',
			opacity: '1',
			color: opts.restyle ? `c${tick++}` : 'c',
			backgroundColor: 'b',
			height: '10px',
			colorScheme: 'normal'
		}),
		MutationObserver: Observer,
		setTimeout: (f: () => void) => timers.push(f),
		requestAnimationFrame: (f: () => void) => {
			f();
			return 1;
		},
		innerWidth: 800,
		innerHeight: 600
	};
	sandbox.window = sandbox;
	if (opts.afbSet) sandbox.afbSet = opts.afbSet;
	vm.runInNewContext(script.replace(/^<script>/, '').replace(/<\/script>$/, ''), sandbox);
	handlers.load({});
	return {
		posts,
		root,
		choose: (key: string, value: string) =>
			handlers.message({ source: parent, data: { type: 'afb-set', key, value } }),
		flush: () => {
			while (timers.length) timers.shift()?.();
		}
	};
}

const config = (options: string, screens = SCREENS) =>
	JSON.stringify({ screens: JSON.parse(screens), options: JSON.parse(options) });
const option = (key: string, extra: Record<string, unknown> = {}) => ({
	key,
	label: key,
	values: JSON.parse(VALUES),
	...extra
});
const configPost = (posts: Posted[]) =>
	posts.find((p) => p.type === 'afb-config') as
		{ config: { options: { key: string; screens?: string[] }[] } } | undefined;

describe.each(SCRIPTS)('%s: the screens an option applies to', (_name, script) => {
	it('reports the screens of an option, and nothing for an option without them', () => {
		const run = boot(
			script,
			config(
				JSON.stringify([
					option('role', { screens: ['a'] }),
					option('flag'),
					option('view', { screens: [] })
				])
			)
		);
		const options = configPost(run.posts)?.config.options ?? [];
		expect(options.map((o) => o.key)).toEqual(['role', 'flag', 'view']);
		expect(options[0].screens).toEqual(['a']);
		// No list, or an empty one, means every screen: the key is left out
		expect(options[1].screens).toBeUndefined();
		expect(options[2].screens).toBeUndefined();
	});
	it('refuses only the option whose list is bad, and keeps the rest', () => {
		const bad: unknown[] = [
			['nope'],
			['a', 'a'],
			'a',
			[1],
			['__proto__'],
			['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a']
		];
		const options = bad.map((s, i) => option(`bad${i}`, { screens: s }));
		const run = boot(
			script,
			// The script reads at most six options, so the good one comes first
			config(JSON.stringify([option('good', { screens: ['b'] }), ...options]))
		);
		expect((configPost(run.posts)?.config.options ?? []).map((o) => o.key)).toEqual(['good']);
	});
});

describe.each(SCRIPTS)('%s: a choice that changes nothing', (_name, script) => {
	const meta = config(JSON.stringify([option('role')]));
	it('says so when nothing in the page changed', () => {
		const run = boot(script, meta);
		run.choose('role', 'y');
		expect(run.root.attrs['data-role']).toBe('y');
		run.flush();
		expect(run.posts).toContainEqual({ type: 'afb-unresponsive', key: 'role', reason: 'none' });
	});
	it('stays quiet when a computed style changed', () => {
		const run = boot(script, meta, { restyle: true });
		run.choose('role', 'y');
		run.flush();
		expect(run.posts.some((p) => p.type === 'afb-unresponsive')).toBe(false);
	});
	it('stays quiet when the page changed its own markup', () => {
		const run = boot(script, meta, { mutate: true });
		run.choose('role', 'y');
		run.flush();
		expect(run.posts.some((p) => p.type === 'afb-unresponsive')).toBe(false);
	});
	it('names a hook of the page that threw, which was silent before', () => {
		const run = boot(script, meta, {
			afbSet: () => {
				throw new Error('boom');
			},
			restyle: true
		});
		run.choose('role', 'y');
		run.flush();
		expect(run.posts).toContainEqual({ type: 'afb-unresponsive', key: 'role', reason: 'error' });
	});
	it('answers only the last of two quick choices', () => {
		const run = boot(script, meta);
		run.choose('role', 'y');
		run.choose('role', 'x');
		run.flush();
		expect(run.posts.filter((p) => p.type === 'afb-unresponsive')).toHaveLength(1);
	});
	it('ignores a value the page did not declare', () => {
		const run = boot(script, meta);
		run.choose('role', 'zzz');
		run.flush();
		expect(run.root.attrs['data-role']).toBeUndefined();
		expect(run.posts.some((p) => p.type === 'afb-unresponsive')).toBe(false);
	});
});
