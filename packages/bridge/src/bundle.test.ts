// THE BUNDLE COMMANDS (AFB-20261114-0409, D.3): A FOLDER OF PARTS GOES UP AS ONE JSON BODY AND COMES BACK AS THE SAME FOLDER

// -- DEP-MODULES -- //
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { MANIFEST_FILE, pullParts, pushBundle, readBundle } from './bundle.js';

// -- FUNCTIONS -- //

describe('mockup bundle', () => {
	let dir = '';
	let bundle = '';
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-bundle-'));
		bundle = join(dir, 'b');
		mkdirSync(join(bundle, 'screens'), { recursive: true });
		writeFileSync(
			join(bundle, 'screens', 'today.html'),
			'<section data-ref="screen-today">Today</section>'
		);
		writeFileSync(join(bundle, 'main.js'), 'const go = 1;');
		writeFileSync(
			join(bundle, MANIFEST_FILE),
			JSON.stringify({
				title: 'Bundle',
				parts: [
					{ kind: 'screen', key: 'today', file: 'screens/today.html' },
					{ kind: 'behavior', key: 'main', file: 'main.js' }
				]
			})
		);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('reads the manifest and the files it lists', () => {
		const { parts } = readBundle(bundle);
		expect(parts.map((p) => `${p.kind}:${p.key}`)).toEqual(['screen:today', 'behavior:main']);
		expect(parts[0].content).toContain('Today');
	});

	it('refuses a missing manifest, a bad kind, a file outside the folder and an empty file', () => {
		expect(() => readBundle(dir)).toThrow(/no mockup\.json/);
		const bad = (parts: unknown[]) => {
			const d = mkdtempSync(join(dir, 'x-'));
			writeFileSync(join(d, 'a.html'), '<p>a</p>');
			writeFileSync(join(d, 'empty.html'), '');
			writeFileSync(join(d, MANIFEST_FILE), JSON.stringify({ parts }));
			return () => readBundle(d);
		};
		expect(bad([{ kind: 'wat', key: 'a', file: 'a.html' }])).toThrow(/not a kind of part/);
		expect(bad([{ kind: 'screen', key: 'a', file: '../outside.html' }])).toThrow(
			/does not exist|outside/
		);
		expect(bad([{ kind: 'screen', key: 'a', file: 'empty.html' }])).toThrow(/empty/);
		expect(bad([])).toThrow(/lists no parts/);
	});

	it('posts one JSON body with the parts and says where to look', async () => {
		let sent: { url: string; body: Record<string, unknown>; key: string | null } | null = null;
		const logs: string[] = [];
		const result = await pushBundle({
			server: 'https://board.test',
			org: 'acme',
			token: 'afb_token',
			dir: bundle,
			item: 'AFB-20261114-0409',
			log: (l) => logs.push(l),
			wait: async () => undefined,
			fetch: async (url, init) => {
				sent = {
					url,
					body: JSON.parse(String(init?.body)),
					key: new Headers(init?.headers).get('idempotency-key')
				};
				return json({
					mockup: { id: 'm-1' },
					version: { number: 1 },
					projectKey: 'AFB',
					warnings: ['one warning'],
					composed: { chars: 500, parts: 2, slots: [] }
				});
			}
		});
		expect(sent!.url).toBe('https://board.test/api/v1/orgs/acme/mockups/bundle');
		expect(sent!.key).toMatch(/^mockup-bundle-/);
		expect(sent!.body).toMatchObject({ item: 'AFB-20261114-0409', title: 'Bundle' });
		expect((sent!.body.parts as unknown[]).length).toBe(2);
		expect(result).toMatchObject({ mockupId: 'm-1', version: 1, parts: 2, composedChars: 500 });
		expect(result.url).toBe('https://board.test/acme/AFB/mockups/m-1');
		expect(logs).toContain('Warning: one warning');
	});

	it('names pulled files from safe characters and gives a number to a name another part took', async () => {
		const answer = (url: string) => {
			if (url.includes('/parts/screen/')) return json({ content: '<p>x</p>', more: false });
			return json({
				version: 1,
				partsOf: 1,
				bundle: true,
				parts: [
					{ kind: 'screen', key: 'Today', size: 1, checksum: 'a' },
					{ kind: 'screen', key: 'today', size: 1, checksum: 'b' },
					{ kind: 'screen', key: '..a', size: 1, checksum: 'c' }
				]
			});
		};
		const out = join(dir, 'pulled-names');
		await pullParts({
			server: 'https://board.test',
			org: 'acme',
			token: 't',
			log: () => undefined,
			wait: async () => undefined,
			mockup: 'm-1',
			out,
			fetch: async (url) => answer(url)
		});
		const files = (
			JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8')) as { parts: { file: string }[] }
		).parts.map((p) => p.file);
		expect(new Set(files.map((f) => f.toLowerCase())).size).toBe(3);
		expect(files).toContain('screens/Today.html');
		expect(files).toContain('screens/today-2.html');
		expect(files.every((f) => !f.includes('..'))).toBe(true);
	});

	it('tells a person that the board is older than the bridge when it has no bundle endpoint', async () => {
		await expect(
			pushBundle({
				server: 'https://board.test',
				org: 'acme',
				token: 'afb_token',
				dir: bundle,
				item: 'AFB-1',
				log: () => undefined,
				wait: async () => undefined,
				fetch: async () => new Response('not found', { status: 404 })
			})
		).rejects.toThrow(/board is older than the bridge/);
	});

	it('writes a pulled bundle as the same folder, and never into a git repository or a folder that has files', async () => {
		const answer = (url: string) => {
			if (url.includes('/parts/screen/today'))
				return json({ content: '<p>Today</p>', more: false });
			if (url.includes('/parts/behavior/main'))
				return json({ content: 'const go = 1;', more: false });
			return json({
				version: 3,
				partsOf: 3,
				bundle: true,
				parts: [
					{ kind: 'screen', key: 'today', size: 12, checksum: 'a' },
					{ kind: 'behavior', key: 'main', size: 13, checksum: 'b' }
				]
			});
		};
		const base = {
			server: 'https://board.test',
			org: 'acme',
			token: 't',
			log: () => undefined,
			wait: async () => undefined
		};
		const out = join(dir, 'pulled');
		const pulled = await pullParts({
			...base,
			mockup: 'm-1',
			out,
			fetch: async (url) => answer(url)
		});
		expect(pulled).toMatchObject({ version: 3, parts: 2 });
		expect(readFileSync(join(out, 'screens', 'today.html'), 'utf8')).toBe('<p>Today</p>');
		expect(JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8')).parts).toHaveLength(2);
		// The folder it wrote is a bundle again
		expect(readBundle(out).parts).toHaveLength(2);
		await expect(
			pullParts({ ...base, mockup: 'm-1', out, fetch: async (url) => answer(url) })
		).rejects.toThrow(/not empty/);
		const repo = join(dir, 'repo');
		mkdirSync(join(repo, '.git'), { recursive: true });
		await expect(
			pullParts({ ...base, mockup: 'm-1', out: join(repo, 'x'), fetch: async (url) => answer(url) })
		).rejects.toThrow(/git repository/);
		expect(existsSync(join(repo, 'x'))).toBe(false);
	});
});
