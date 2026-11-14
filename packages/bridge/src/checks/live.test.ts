// TESTS OF LIVE-SITE SETTINGS AND THE NO-WRITES RULE.

// IMPORTED DEP-MODULES
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { guardContext } from './guard.js';
import type { RouteLike } from './guard.js';
import { isLiveSite, liveSiteGuardOptions, liveSiteProblems } from './live.js';

// -- CONSTANTS -- //

const here = dirname(fileURLToPath(import.meta.url));

// -- FUNCTIONS -- //

describe('liveSiteProblems', () => {
	it('accepts https and http addresses and exact host names', () => {
		expect(liveSiteProblems({ url: 'https://app.example.com' })).toEqual([]);
		expect(
			liveSiteProblems({
				url: 'http://demo.example.com/x',
				extraHosts: ['cdn.example.com', 'API.example.org']
			})
		).toEqual([]);
		expect(liveSiteProblems({ url: 'http://127.0.0.1:4173' })).toEqual([]);
	});
	it.each([
		'ftp://a.example.com',
		'file:///etc/passwd',
		'javascript:alert(1)',
		'not a url',
		'https://u:p@a.example.com'
	])('refuses the address %s', (url) => {
		expect(liveSiteProblems({ url }).length).toBeGreaterThan(0);
	});
	it.each([
		'http://127.0.0.1:5180',
		'http://localhost:5190/',
		'http://127.0.0.1:5433',
		'http://0.0.0.0:5180',
		'http://[::1]:5180'
	])('refuses a local address on a forbidden port: %s', (url) => {
		expect(liveSiteProblems({ url }).join(' ')).toMatch(/port/);
	});
	it('does not refuse a remote host that happens to use 5180', () => {
		expect(liveSiteProblems({ url: 'https://app.example.com:5180' })).toEqual([]);
	});
	it.each([
		'*.example.com',
		'a.example.com:8080',
		'a.example.com/path',
		'https://a.example.com',
		'',
		' ',
		'a_b.example.com'
	])('refuses the extra host %j (not an exact name)', (h) => {
		expect(liveSiteProblems({ extraHosts: [h] }).length).toBeGreaterThan(0);
	});
	it.each([
		'127.0.0.1',
		'10.0.0.5',
		'8.8.8.8',
		'::1',
		'[::1]',
		'2001:db8::1',
		'2130706433',
		'0x7f000001'
	])('refuses the IP literal %s as an extra host', (h) => {
		expect(liveSiteProblems({ extraHosts: [h] }).length).toBeGreaterThan(0);
	});
	it.each(['localhost', 'LOCALHOST', 'app.localhost', 'host.docker.internal'])(
		'refuses the loopback host %s',
		(h) => {
			expect(liveSiteProblems({ extraHosts: [h] }).length).toBeGreaterThan(0);
		}
	);
	it('refuses more than 16 extra hosts', () => {
		const many = Array.from({ length: 17 }, (_, i) => `h${i}.example.com`);
		expect(liveSiteProblems({ extraHosts: many }).length).toBeGreaterThan(0);
	});
});

describe('liveSiteGuardOptions', () => {
	it('never allows writes and lowercases the extra hosts', () => {
		expect(
			liveSiteGuardOptions({
				url: 'https://a.example.com',
				extraHosts: ['CDN.example.com', 'cdn.example.com']
			})
		).toEqual({
			allowWrites: false,
			extraHosts: ['cdn.example.com']
		});
	});
	it('throws on settings that are refused', () => {
		expect(() => liveSiteGuardOptions({ url: 'ftp://x.example.com' })).toThrow();
	});
	it('stops a write on a live site through the real guard, and a read goes through', async () => {
		const opts = liveSiteGuardOptions({ url: 'https://a.example.com' });
		let handler: (r: RouteLike) => void | Promise<void> = () => {};
		const counts = await guardContext(
			{ route: async (_p, h) => void (handler = h) },
			{ origin: 'https://a.example.com', ...opts }
		);
		const hit = async (method: string) => {
			const calls: string[] = [];
			await handler({
				request: () => ({
					url: () => 'https://a.example.com/x',
					method: () => method,
					resourceType: () => 'fetch'
				}),
				continue: async () => void calls.push('continue'),
				abort: async () => void calls.push('abort'),
				fulfill: async () => void calls.push('fulfill')
			});
			return calls;
		};
		expect(await hit('GET')).toEqual(['continue']);
		for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(await hit(m)).toEqual(['abort']);
		expect(counts.writes).toBe(4);
	});
});

describe('child.ts', () => {
	it('already runs every check with writes off and takes no switch to turn them on', () => {
		const text = readFileSync(join(here, 'child.ts'), 'utf8');
		expect(text).toMatch(/allowWrites:\s*false/);
		expect(text).not.toMatch(/allowWrites:\s*(true|job\.|\w+\.allowWrites)/);
	});
});

describe('isLiveSite', () => {
	it('is true only with a url', () => {
		expect(isLiveSite({ url: 'https://a.example.com' })).toBe(true);
		expect(isLiveSite({})).toBe(false);
		expect(isLiveSite({ url: '' })).toBe(false);
	});
});
