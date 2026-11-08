// THE DEPENDENCY AND BUILD CACHES: KEYS, EVERY NO-CACHE RULE, PUBLISH AND RESTORE, HARD LINKS THAT ARE READ-ONLY, A DAMAGED ENTRY REFUSED, EVICTION AND CLEAN-UP

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
	lstatSync,
	readlinkSync,
	chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	CacheCorruptError,
	acquireUse,
	buildEntryDir,
	buildKey,
	depsEntryDir,
	depsKey,
	evict,
	hasEntry,
	publishBuild,
	publishDeps,
	publishDepsAsync,
	restoreBuild,
	restoreBuildAsync,
	restoreDeps,
	restoreDepsAsync,
	restoreOrNull,
	snapshot,
	snapshotAsync,
	treeId,
	uncacheableReason
} from './cache.js';

// -- CONSTANTS -- //

const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const deadPid = 2_147_483_000;
const base = {
	org: 'acme',
	name: 'WEB',
	treeId: hex('tree'),
	surface: hex('surface'),
	build: 'yarn build',
	env: { NODE_ENV: 'production', PUBLIC_NAME: 'Shop' }
};

// -- FUNCTIONS -- //

describe('cache keys', () => {
	it('depsKey is stable and every input changes it', () => {
		const i = {
			lockHash: 'a',
			node: '24.0.0',
			platform: 'win32',
			arch: 'x64',
			pm: 'yarn',
			pmVersion: '4.1.0'
		};
		expect(depsKey(i)).toBe(depsKey({ ...i }));
		expect(depsKey(i)).toMatch(/^[a-f0-9]{64}$/);
		for (const [k, v] of Object.entries({
			lockHash: 'b',
			node: '22.1.0',
			platform: 'linux',
			arch: 'arm64',
			pm: 'npm',
			pmVersion: '4.2.0'
		}))
			expect(depsKey({ ...i, [k]: v })).not.toBe(depsKey(i));
	});

	it('buildKey changes with the node version, platform, architecture and app folder (C16)', () => {
		const k = buildKey(base);
		expect(k).toMatch(/^[a-f0-9]{64}$/);
		for (const change of [
			{ node: 'v0.0.1' },
			{ platform: 'plan9' },
			{ arch: 'mips' },
			{ appDir: 'landing' }
		])
			expect(buildKey({ ...base, ...change })).not.toBe(k);
		// Defaults are this process's own values, so spelling them out changes nothing
		expect(
			buildKey({
				...base,
				node: process.version,
				platform: process.platform,
				arch: process.arch,
				appDir: ''
			})
		).toBe(k);
	});

	it('buildKey is stable, ignores PORT and HOST and key order, and changes with every input', () => {
		const k = buildKey(base);
		expect(k).toMatch(/^[a-f0-9]{64}$/);
		expect(buildKey({ ...base })).toBe(k);
		expect(
			buildKey({
				...base,
				env: { PUBLIC_NAME: 'Shop', NODE_ENV: 'production', PORT: '5300', HOST: 'x' }
			})
		).toBe(k);
		const changes: Partial<typeof base>[] = [
			{ org: 'other' },
			{ name: 'LAND' },
			{ treeId: hex('tree2') },
			{ surface: hex('s2') },
			{ build: 'yarn build:prod' },
			{ env: { NODE_ENV: 'production', PUBLIC_NAME: 'Other' } }
		];
		for (const c of changes) expect(buildKey({ ...base, ...c })).not.toBe(k);
	});

	it('treeId uses the commit and the diff, or the content hash', () => {
		expect(treeId({ commit: 'abc', diffHash: 'd1' })).not.toBe(
			treeId({ commit: 'abc', diffHash: 'd2' })
		);
		expect(treeId({ commit: 'abc' })).toBe(treeId({ commit: 'abc', diffHash: null }));
		expect(treeId({ contentHash: 'c1' })).not.toBe(treeId({ commit: 'c1' }));
		expect(treeId({})).toBeNull();
	});

	describe('no cache when the build holds something that belongs to one run', () => {
		const refused: [
			string,
			Partial<typeof base> & { envNames?: string[]; secretValues?: string[] }
		][] = [
			['no build command', { build: undefined }],
			['a blank build command', { build: '  ' }],
			['{port} in the command', { build: 'vite preview --port {port}' }],
			['{baseUrl} in the command', { build: 'yarn build --base {baseUrl}' }],
			['127.0.0.1:port in the command', { build: 'yarn build --api http://127.0.0.1:5300' }],
			['localhost:port in the command', { build: 'yarn build --api http://localhost:5300/x' }],
			['--port in the command', { build: 'yarn build --port 4000' }],
			['DATABASE_URL in the command', { build: 'DATABASE_URL=x yarn build' }],
			['a database url in the command', { build: 'yarn build postgres://u:p@h/db' }],
			[
				'a secret value in the command',
				{ build: 'yarn build --key s3cr3tvalue', secretValues: ['s3cr3tvalue'] }
			],
			['DATABASE_URL in the env', { env: { DATABASE_URL: 'x' } }],
			['a database url value', { env: { SOMETHING: 'postgresql://u:p@h:5432/db' } }],
			['a secret named setting', { env: { STRIPE_SECRET_KEY: 'x' } }],
			['a token named setting', { env: { AUTH_TOKEN: 'x' } }],
			['a base url setting', { env: { PUBLIC_BASE_URL: 'https://x.test' } }],
			['a port setting', { env: { API_PORT: '3000' } }],
			['a loopback address with a port', { env: { API: 'http://127.0.0.1:8080/api' } }],
			['localhost with a port', { env: { API: 'localhost:8080' } }],
			['a {port} placeholder value', { env: { API: 'http://x:{port}' } }],
			['a {baseUrl} placeholder value', { env: { SELF: '{baseUrl}/a' } }],
			['a JWT', { env: { ANON: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghijk' } }],
			['an adopted name', { env: { CUSTOM_THING: 'x' }, envNames: ['CUSTOM_THING'] }],
			[
				'a secret value inside a setting',
				{ env: { A: 'prefix-s3cr3tvalue-suffix' }, secretValues: ['s3cr3tvalue'] }
			]
		];
		for (const [label, change] of refused) {
			it(`refuses ${label}`, () => {
				const { envNames, secretValues, ...rest } = change;
				const input = { ...base, ...rest, envNames, secretValues };
				expect(buildKey(input)).toBeNull();
				expect(uncacheableReason(input)).not.toBeNull();
			});
		}
		it('still keys a plain build', () => {
			expect(uncacheableReason(base)).toBeNull();
		});
	});
});

describe('build and dependency entries', () => {
	let root = '';
	let work = '';
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'afb-cache-'));
		work = join(root, 'work');
		mkdirSync(work);
	});
	afterEach(() => {
		try {
			// Restored hard links are read-only; removing them must still work
			rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			/* Left for the temp cleaner */
		}
	});

	const cacheRoot = () => join(root, 'cache');
	const put = (dir: string, rel: string, text: string) => {
		const f = join(dir, rel);
		mkdirSync(join(f, '..'), { recursive: true });
		writeFileSync(f, text);
	};
	const made = (key: string) => {
		put(work, 'src/app.js', 'source');
		const before = snapshot(work);
		put(work, 'build/index.html', '<html>one</html>');
		put(work, 'build/assets/a.js', 'console.log(1)');
		put(work, 'src/app.js', 'source changed!');
		expect(publishBuild(cacheRoot(), key, work, before)).toBe(true);
	};

	it('publishes only the new or changed files and restores them by copy', () => {
		put(work, 'untouched.txt', 'same');
		const key = hex('b1');
		made(key);
		expect(hasEntry(cacheRoot(), 'builds', key)).toBe(true);
		const entry = buildEntryDir(cacheRoot(), key);
		expect(existsSync(join(entry, '.complete'))).toBe(true);
		expect(existsSync(join(entry, 'files', 'untouched.txt'))).toBe(false);
		expect(existsSync(join(entry, 'files', 'build', 'index.html'))).toBe(true);
		expect(readdirSync(join(cacheRoot(), 'builds')).filter((n) => n.includes('.tmp-'))).toEqual([]);
		// A second publish for the same key keeps the first
		expect(publishBuild(cacheRoot(), key, work, new Map())).toBe(false);
		expect(publishBuild(cacheRoot(), hex('none'), work, snapshot(work))).toBe(false);

		const dest = join(root, 'dest');
		const r = restoreBuild(cacheRoot(), key, dest, { link: 'copy' });
		expect(r).toEqual({ files: 3, linked: 0, copied: 3 });
		expect(readFileSync(join(dest, 'build', 'index.html'), 'utf8')).toBe('<html>one</html>');
		expect(readFileSync(join(dest, 'src', 'app.js'), 'utf8')).toBe('source changed!');
		// A copy is writable and never changes the cache
		writeFileSync(join(dest, 'build', 'index.html'), 'edited');
		expect(readFileSync(join(entry, 'files', 'build', 'index.html'), 'utf8')).toBe(
			'<html>one</html>'
		);
		expect(restoreBuild(cacheRoot(), hex('missing'), dest)).toBeNull();
	});

	it('restores with hard links on the same volume, read-only, so a write fails loudly', (ctx) => {
		const key = hex('b2');
		made(key);
		const dest = join(root, 'linked');
		const r = restoreBuild(cacheRoot(), key, dest, { link: 'auto' });
		expect(r?.files).toBe(3);
		const a = join(dest, 'build', 'index.html');
		const b = join(buildEntryDir(cacheRoot(), key), 'files', 'build', 'index.html');
		if (!r || r.linked === 0 || statSync(a).ino !== statSync(b).ino) {
			ctx.skip(); // This file system refused hard links, so there is nothing linked to assert on
			return;
		}
		expect(r.linked).toBe(3);
		expect(readFileSync(a, 'utf8')).toBe('<html>one</html>');
		if (typeof process.getuid === 'function' && process.getuid() === 0) {
			ctx.skip(); // Root can write to a read-only file
			return;
		}
		expect(() => writeFileSync(a, 'oops')).toThrow();
		expect(readFileSync(b, 'utf8')).toBe('<html>one</html>');
		// Eviction and clean-up can still remove them
		expect(evict(cacheRoot(), { builds: 0, now: Date.now() + 3_600_000 }).removed).toHaveLength(1);
	});

	it('refuses an entry whose content changed or whose size changed, and sets it aside', () => {
		const key = hex('b3');
		made(key);
		const file = join(buildEntryDir(cacheRoot(), key), 'files', 'build', 'assets', 'a.js');
		chmodSync(file, 0o666);
		writeFileSync(file, 'console.log(2)'); // Same size, other content
		expect(() => restoreBuild(cacheRoot(), key, join(root, 'd1'), { link: 'copy' })).toThrow(
			CacheCorruptError
		);
		expect(hasEntry(cacheRoot(), 'builds', key)).toBe(false);
		expect(existsSync(join(root, 'd1', 'build', 'index.html'))).toBe(false);
		expect(restoreBuild(cacheRoot(), key, join(root, 'd1'))).toBeNull();

		const key2 = hex('b4');
		work = join(root, 'work2');
		mkdirSync(work);
		made(key2);
		const f2 = join(buildEntryDir(cacheRoot(), key2), 'files', 'build', 'index.html');
		writeFileSync(f2, 'short');
		expect(() => restoreBuild(cacheRoot(), key2, join(root, 'd2'))).toThrow(CacheCorruptError);
	});

	it('skips paths with .. and never writes through a link in the destination', (ctx) => {
		const key = hex('b5');
		made(key);
		const entry = buildEntryDir(cacheRoot(), key);
		const manifestFile = join(entry, 'manifest.json');
		const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
			entries: { p: string; t: string }[];
		};
		m.entries.push({ p: '../escape.txt', t: 'f' }, { p: 'a/../../escape2.txt', t: 'f' });
		writeFileSync(manifestFile, JSON.stringify(m));
		writeFileSync(join(entry, 'escape.txt'), 'x');
		const dest = join(root, 'dd', 'inner');
		restoreBuild(cacheRoot(), key, dest, { link: 'copy' });
		expect(existsSync(join(root, 'dd', 'escape.txt'))).toBe(false);
		expect(existsSync(join(root, 'dd', 'escape2.txt'))).toBe(false);
		expect(existsSync(join(dest, 'build', 'index.html'))).toBe(true);

		// A link in the destination that points outside is not followed
		const outside = join(root, 'outside');
		mkdirSync(outside);
		const dest2 = join(root, 'dest2');
		mkdirSync(dest2);
		try {
			symlinkSync(outside, join(dest2, 'build'), 'junction');
		} catch {
			ctx.skip(); // This account cannot make links
			return;
		}
		expect(() => restoreBuild(cacheRoot(), key, dest2, { link: 'copy' })).toThrow(/link/i);
		expect(readdirSync(outside)).toEqual([]);
	});

	it('keeps and restores dependencies, links included, by copy and by link', (ctx) => {
		const project = join(root, 'project');
		put(project, 'node_modules/a/index.js', 'module.exports=1');
		put(project, 'node_modules/a/package.json', '{"name":"a"}');
		mkdirSync(join(project, 'node_modules', 'empty'));
		let linked = true;
		try {
			symlinkSync('a', join(project, 'node_modules', 'alias'), 'junction');
		} catch {
			linked = false;
		}
		const key = hex('d1');
		expect(publishDeps(cacheRoot(), key, project)).toBe(true);
		expect(publishDeps(cacheRoot(), key, project)).toBe(false);
		expect(publishDeps(cacheRoot(), hex('d0'), join(root, 'no-project'))).toBe(false);
		expect(depsEntryDir(cacheRoot(), key)).toContain('deps');
		for (const link of ['copy', 'auto'] as const) {
			const dest = join(root, `app-${link}`);
			const r = restoreDeps(cacheRoot(), key, dest, { link });
			expect(r?.files).toBe(2);
			expect(readFileSync(join(dest, 'node_modules', 'a', 'index.js'), 'utf8')).toBe(
				'module.exports=1'
			);
			expect(statSync(join(dest, 'node_modules', 'empty')).isDirectory()).toBe(true);
			if (linked)
				expect(lstatSync(join(dest, 'node_modules', 'alias')).isSymbolicLink()).toBe(true);
			if (linked) expect(readlinkSync(join(dest, 'node_modules', 'alias'))).toMatch(/a[\\/]?$/);
		}
		if (!linked) ctx.skip(); // The links part could not run on this account
	});

	it('does not keep a node_modules whose link points outside the project', (ctx) => {
		const project = join(root, 'project2');
		put(project, 'node_modules/a/index.js', 'x');
		put(root, 'elsewhere/lib.js', 'y');
		try {
			symlinkSync(join(root, 'elsewhere'), join(project, 'node_modules', 'ws'), 'junction');
		} catch {
			ctx.skip();
			return;
		}
		expect(publishDeps(cacheRoot(), hex('d2'), project)).toBe(false);
		expect(readdirSync(join(cacheRoot(), 'deps')).filter((n) => !n.includes('.tmp-'))).toEqual([]);
	});

	it('keeps a workspace link into the project and recreates it so it resolves in the restoring folder', (ctx) => {
		const project = join(root, 'ws-project');
		put(project, 'node_modules/a/index.js', 'x');
		put(project, 'packages/bridge/index.js', 'original');
		mkdirSync(join(project, 'node_modules', '@scope'), { recursive: true });
		try {
			// An absolute link inside the project, as a junction on Windows is
			symlinkSync(
				join(project, 'packages', 'bridge'),
				join(project, 'node_modules', '@scope', 'bridge'),
				'junction'
			);
		} catch {
			ctx.skip();
			return;
		}
		const key = hex('d3');
		expect(publishDeps(cacheRoot(), key, project)).toBe(true);
		for (const link of ['copy', 'auto'] as const) {
			// The restoring run has its own copy of the project's packages
			const dest = join(root, `ws-restored-${link}`);
			put(dest, 'packages/bridge/index.js', `copy of ${link}`);
			expect(restoreDeps(cacheRoot(), key, dest, { link })).not.toBeNull();
			const linkPath = join(dest, 'node_modules', '@scope', 'bridge');
			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			// It resolves into the restoring folder, not into the original project
			expect(readFileSync(join(linkPath, 'index.js'), 'utf8')).toBe(`copy of ${link}`);
		}
	});

	it('refuses to restore a dependency link that escapes the project (tampered manifest)', () => {
		const project = join(root, 'ws-project2');
		put(project, 'node_modules/a/index.js', 'x');
		const key = hex('d4');
		expect(publishDeps(cacheRoot(), key, project)).toBe(true);
		const manifestFile = join(depsEntryDir(cacheRoot(), key), 'manifest.json');
		const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as { entries: unknown[] };
		m.entries.push({ p: 'evil', t: 'l', to: '../../../outside', dir: true });
		writeFileSync(manifestFile, JSON.stringify(m));
		expect(() => restoreDeps(cacheRoot(), key, join(root, 'ws-dest'), { link: 'copy' })).toThrow(
			/link/i
		);
		const m2 = {
			...m,
			entries: [...m.entries.slice(0, -1), { p: 'abs', t: 'l', to: root, dir: true }]
		};
		writeFileSync(manifestFile, JSON.stringify(m2));
		expect(() => restoreDeps(cacheRoot(), key, join(root, 'ws-dest2'), { link: 'copy' })).toThrow(
			/link/i
		);
	});

	describe('eviction', () => {
		const age = (path: string, minutes: number) => {
			const t = new Date(Date.now() - minutes * 60_000);
			utimesSync(path, t, t);
		};
		const entries = (n: number) => {
			const keys: string[] = [];
			for (let i = 0; i < n; i++) {
				const w = join(root, `w${i}`);
				mkdirSync(w);
				put(w, 'f.txt', `file ${i}`);
				const key = hex(`ev${i}`);
				expect(publishBuild(cacheRoot(), key, w, new Map())).toBe(true);
				age(buildEntryDir(cacheRoot(), key), 30 + i * 10); // Entry 0 is the newest
				keys.push(key);
			}
			return keys;
		};
		const left = () => readdirSync(join(cacheRoot(), 'builds')).sort();

		it('keeps the newest N and removes the rest', () => {
			const keys = entries(8);
			const r = evict(cacheRoot(), { builds: 5, deps: 3, maxAgeDays: 14 });
			expect(r.removed).toHaveLength(3);
			expect(left()).toEqual(keys.slice(0, 5).sort());
		});

		it('removes an entry older than the maximum age even within the count', () => {
			entries(2);
			expect(evict(cacheRoot(), { now: Date.now() + 15 * 86_400_000 }).removed).toHaveLength(2);
		});

		it('never removes an entry with a live in-use marker, or one used in the last 10 minutes', () => {
			const keys = entries(4);
			const oldest = buildEntryDir(cacheRoot(), keys[3]);
			const release = acquireUse(oldest);
			age(oldest, 500);
			const recent = buildEntryDir(cacheRoot(), keys[2]);
			age(recent, 3);
			evict(cacheRoot(), { builds: 0 });
			expect(left().sort()).toEqual([keys[2], keys[3]].sort());
			// The marker of a dead process does not protect, and a released one does not either
			release();
			age(oldest, 500);
			writeFileSync(
				join(oldest, 'use', 'dead.json'),
				JSON.stringify({ pid: deadPid, start: new Date().toISOString(), token: 'x' })
			);
			evict(cacheRoot(), { builds: 0 });
			expect(left()).toEqual([keys[2]]);
		});

		it('removes half-written entries after an hour and leaves younger ones', () => {
			const tmpOld = join(cacheRoot(), 'builds', `${hex('t1')}.tmp-123-1`);
			const tmpNew = join(cacheRoot(), 'builds', `${hex('t2')}.tmp-123-2`);
			const noNote = join(cacheRoot(), 'deps', hex('t3'));
			for (const d of [tmpOld, tmpNew, noNote]) {
				mkdirSync(join(d, 'files'), { recursive: true });
				writeFileSync(join(d, 'files', 'x'), 'x');
			}
			age(tmpOld, 61);
			age(tmpNew, 10);
			age(noNote, 90);
			const r = evict(cacheRoot());
			expect(r.removed.sort()).toEqual(
				[`builds/${hex('t1')}.tmp-123-1`, `deps/${hex('t3')}`].sort()
			);
			expect(existsSync(tmpNew)).toBe(true);
		});
	});

	it('a damaged entry is a null for restoreOrNull, so the run installs or builds instead of failing (C5)', async () => {
		const key = hex('c5');
		made(key);
		const file = join(buildEntryDir(cacheRoot(), key), 'files', 'build', 'assets', 'a.js');
		chmodSync(file, 0o666);
		writeFileSync(file, 'console.log(2)'); // Same size, other content
		const logs: string[] = [];
		const got = await restoreOrNull(
			'build',
			() => restoreBuildAsync(cacheRoot(), key, join(root, 'd5')),
			(l) => logs.push(l)
		);
		expect(got).toBeNull();
		expect(logs.join(' ')).toMatch(/damaged and set aside/);
		// Any other failure is not swallowed
		await expect(
			restoreOrNull(
				'build',
				async () => {
					throw new Error('disk gone');
				},
				() => {}
			)
		).rejects.toThrow('disk gone');
	});

	it('the async forms give the same result as the plain ones (C6)', async () => {
		const key = hex('c6a');
		made(key);
		const sync = restoreBuild(cacheRoot(), key, join(root, 'dsync'), { link: 'copy' });
		const async_ = await restoreBuildAsync(cacheRoot(), key, join(root, 'dasync'), {
			link: 'copy'
		});
		expect(async_).toEqual(sync);
		expect(readFileSync(join(root, 'dasync', 'build', 'index.html'), 'utf8')).toBe(
			readFileSync(join(root, 'dsync', 'build', 'index.html'), 'utf8')
		);
		expect((await snapshotAsync(work)).size).toBe(snapshot(work).size);
	});

	it('a restore of thousands of files never blocks the event loop for long (C6)', async () => {
		// 3000 small files in a dependency tree: published and restored without the loop stalling past a quarter of a second
		const project = join(root, 'bigproject');
		for (let d = 0; d < 30; d++) {
			const dir = join(project, 'node_modules', `pkg${d}`);
			mkdirSync(dir, { recursive: true });
			for (let f = 0; f < 100; f++) writeFileSync(join(dir, `f${f}.js`), `module.exports=${f};`);
		}
		const key = hex('c6big');
		// The loop is watched by a timer. One slow call of the file system (a virus scanner holding a single file for 100 ms) is not the tool blocking the loop, so a
		// run that goes over the bound is measured again, up to three times; the tool's own batches are 10 ms or 50 files
		const attempts: number[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			const kept = attempt === 0 ? key : hex(`c6big${attempt}`);
			let worst = 0;
			let last = Date.now();
			const timer = setInterval(() => {
				const now = Date.now();
				worst = Math.max(worst, now - last);
				last = now;
			}, 10);
			try {
				expect(await publishDepsAsync(cacheRoot(), kept, project)).toBe(true);
				const dest = join(root, `bigdest${attempt}`);
				mkdirSync(dest, { recursive: true });
				const got = await restoreDepsAsync(cacheRoot(), kept, dest, { link: 'copy' });
				expect(got?.files).toBe(3000);
				expect(existsSync(join(dest, 'node_modules', 'pkg29', 'f99.js'))).toBe(true);
			} finally {
				clearInterval(timer);
			}
			attempts.push(worst);
			if (worst < 250) break;
		}
		expect(Math.min(...attempts), `lag per attempt: ${attempts.join(', ')} ms`).toBeLessThan(250);
	}, 60_000);
});
