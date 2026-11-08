// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { guardContext, lintCheck, pageForCheck, unwrap } from './guard.js';
import type { RouteLike } from './guard.js';

// -- CONSTANTS -- //

const ORIGIN = 'http://127.0.0.1:4173';

// -- FUNCTIONS -- //

/** A route that records what the guard did with it. */
function fakeRoute(url: string, method = 'GET', type = 'fetch') {
	const calls: string[] = [];
	const route: RouteLike = {
		request: () => ({ url: () => url, method: () => method, resourceType: () => type }),
		continue: async () => void calls.push('continue'),
		abort: async () => void calls.push('abort'),
		fulfill: async (o) => void calls.push(`fulfill ${o.status}`)
	};
	return { route, calls };
}

async function setup(options: { allowWrites?: boolean; extraHosts?: string[] } = {}) {
	let handler: (route: RouteLike) => void | Promise<void> = () => {};
	const blocked: string[] = [];
	const counts = await guardContext(
		{ route: async (_pattern, h) => void (handler = h) },
		{ origin: ORIGIN, onBlocked: (m) => void blocked.push(m), ...options }
	);
	const run = async (url: string, method?: string, type?: string) => {
		const r = fakeRoute(url, method, type);
		await handler(r.route);
		return r.calls;
	};
	return { counts, blocked, run };
}

describe('guardContext', () => {
	it('lets reads of the app through', async () => {
		const { run, counts } = await setup();
		expect(await run(`${ORIGIN}/a`)).toEqual(['continue']);
		expect(await run(`${ORIGIN}/a`, 'HEAD')).toEqual(['continue']);
		expect(counts).toEqual({ writes: 0, outside: 0 });
	});

	it('lets data and blob urls through', async () => {
		const { run } = await setup();
		expect(await run('data:text/plain,hi')).toEqual(['continue']);
		expect(await run('blob:http://x/1')).toEqual(['continue']);
	});

	it('aborts a request outside the origin and counts it', async () => {
		const { run, counts, blocked } = await setup();
		expect(await run('https://evil.example.com/steal')).toEqual(['abort']);
		expect(counts.outside).toBe(1);
		expect(blocked[0]).toContain('evil.example.com');
	});

	it('lets an extra host through', async () => {
		const { run, counts } = await setup({ extraHosts: ['cdn.example.com'] });
		expect(await run('https://cdn.example.com/x.js')).toEqual(['continue']);
		expect(counts.outside).toBe(0);
	});

	it('stops a write: a form post is answered with 204, a fetch is aborted', async () => {
		const { run, counts } = await setup();
		expect(await run(`${ORIGIN}/save`, 'POST', 'document')).toEqual(['fulfill 204']);
		expect(await run(`${ORIGIN}/api`, 'DELETE', 'fetch')).toEqual(['abort']);
		expect(counts.writes).toBe(2);
	});

	it('lets writes through when allowed', async () => {
		const { run, counts } = await setup({ allowWrites: true });
		expect(await run(`${ORIGIN}/save`, 'POST')).toEqual(['continue']);
		expect(counts.writes).toBe(0);
	});
});

// -- PAGE FACADE -- //

class Locator {
	constructor(private readonly secret: string) {}
	async text() {
		return this.secret;
	}
	page() {
		return 'the real page';
	}
	_expect() {
		return 'expect ok';
	}
	_internal() {
		return 'internal';
	}
}
class Page {
	opened: string[] = [];
	context() {
		return 'the context';
	}
	async goto(url: string) {
		this.opened.push(url);
		return 'ok';
	}
	locator() {
		return new Locator('hello');
	}
	async evaluate() {
		return { plain: 'data' };
	}
	async storageState() {
		return { cookies: ['x'] };
	}
}

describe('pageForCheck', () => {
	const make = () => {
		const real = new Page();
		return { real, page: pageForCheck(real, { origin: ORIGIN, extraHosts: ['cdn.example.com'] }) };
	};

	it('hides the context, the cookies and the routes', () => {
		const { page } = make();
		expect(() => page.context()).toThrow(/not available to a check/);
		expect(() => page.storageState()).toThrow(/not available to a check/);
	});

	it('does not lead back through a locator', async () => {
		const { page } = make();
		const loc = page.locator();
		expect(await loc.text()).toBe('hello');
		expect(() => loc.page()).toThrow(/not available to a check/);
		expect((loc as unknown as { _internal?: unknown })._internal).toBeUndefined();
	});

	it('hands over plain data as it is', async () => {
		const { page } = make();
		expect(await page.evaluate()).toEqual({ plain: 'data' });
	});

	it('allows a goto to a path, the origin and an extra host', async () => {
		const { page, real } = make();
		await page.goto('/home');
		await page.goto(`${ORIGIN}/x`);
		await page.goto('https://cdn.example.com/a');
		expect(real.opened).toEqual(['/home', `${ORIGIN}/x`, 'https://cdn.example.com/a']);
	});

	it('refuses a goto outside the app, a file url and a protocol-relative url', () => {
		const { page } = make();
		expect(() => page.goto('https://evil.example.com')).toThrow(/not the app under test/);
		expect(() => page.goto('file:///etc/passwd')).toThrow(/not the app under test/);
		expect(() => page.goto('//evil.example.com/x')).toThrow(/not an address/);
		expect(() => page.goto('nonsense')).toThrow(/not an address/);
	});

	it('unwrap gives the real object back', () => {
		const { page, real } = make();
		expect(unwrap(page)).toBe(real);
		expect(unwrap('plain')).toBe('plain');
	});
});

describe('lintCheck', () => {
	const bad: [string, string][] = [
		["import { exec } from 'node:child_process';", 'child_process'],
		["import fs from 'node:fs';", 'the file system'],
		["import fs from 'fs';", 'the file system'],
		["import os from 'os';", 'a module of Node other than path and url'],
		["const x = require('fs');", 'require()'],
		['const t = process.env.AFB_TOKEN;', 'process'],
		["await fetch('https://evil.example.com');", 'fetch()'],
		['const m = await import(name);', 'a dynamic import of a name that is not a relative file'],
		["await import('node:fs');", 'a dynamic import of a name that is not a relative file'],
		["eval('1')", 'a way around the checks'],
		["new Function('return 1')", 'a way around the checks'],
		['const c = page.context();', 'a way back to the browser context']
	];
	it.each(bad)('flags %s', (source, label) => {
		expect(lintCheck(source)).toContain(label);
	});

	it('passes a plain check', () => {
		const source = `import path from 'node:path';
import { pathToFileURL } from 'node:url';
const helper = await import('./helper.mjs');
export default async function ({ page, step, expect, baseUrl }) {
	await step('Open the board', async () => {
		await page.goto('/');
		await expect(page.getByRole('heading')).toBeVisible();
	});
}`;
		expect(lintCheck(source)).toEqual([]);
	});
});
