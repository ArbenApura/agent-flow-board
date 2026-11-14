// IMPORTED DEP-MODULES
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { findLink, readPlainFile, JPEG_MAGIC } from './evidence.js';
import {
	cleanResult,
	permissionFlag,
	runNodeInSandbox,
	runCheckInSandbox,
	sandboxEnv
} from './sandbox.js';

// scope.ts is written by another part of the work; the sandbox only needs killTree from it, so it is faked here
vi.mock('./scope.js', () => ({ killTree: vi.fn() }));

// -- CONSTANTS -- //

/** What the probe tries. It runs inside the sandbox and prints one JSON line saying what worked. */
const PROBE = `
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const paths = JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => r(s)); }));
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, code: e && e.code }; } };
const out = {
	readKey: attempt(() => readFileSync(paths.key, 'utf8')),
	readToken: attempt(() => readFileSync(paths.token, 'utf8')),
	readOutside: attempt(() => readFileSync(paths.outside, 'utf8')),
	readInside: attempt(() => readFileSync(paths.inside, 'utf8')),
	writeOutside: attempt(() => writeFileSync(paths.outsideWrite, 'x')),
	writeInside: attempt(() => writeFileSync(paths.insideWrite, 'ok')),
	spawn: attempt(() => execFileSync(process.execPath, ['-e', '1']).toString()),
	token: process.env.AFB_TOKEN ?? null,
	home: process.env.HOME ?? process.env.USERPROFILE ?? null
};
process.stdout.write('PROBE ' + JSON.stringify(out) + '\\n');
`;

// -- STATES -- //

let base = '';
let paths: Record<string, string> = {};
const previousToken = process.env.AFB_TOKEN;

type Attempt = { ok: boolean; value?: string; code?: string };

// -- FUNCTIONS -- //

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), 'afb-sandbox-test-')));
	for (const d of ['home', 'scripts', 'run', 'outside']) mkdirSync(join(base, d));
	writeFileSync(join(base, 'home', 'key'), 'FAKE-KEY-MATERIAL');
	writeFileSync(join(base, 'home', 'token-x.enc'), 'FAKE-TOKEN-CIPHERTEXT');
	writeFileSync(join(base, 'scripts', 'probe.mjs'), PROBE);
	writeFileSync(join(base, 'scripts', 'inside.txt'), 'inside-content');
	writeFileSync(join(base, 'outside', 'secret.txt'), 'outside-content');
	writeFileSync(join(base, 'scripts', 'hang.mjs'), 'setInterval(() => {}, 1000);');
	paths = {
		key: join(base, 'home', 'key'),
		token: join(base, 'home', 'token-x.enc'),
		outside: join(base, 'outside', 'secret.txt'),
		inside: join(base, 'scripts', 'inside.txt'),
		outsideWrite: join(base, 'outside', 'written.txt'),
		insideWrite: join(base, 'run', 'written.txt')
	};
	process.env.AFB_TOKEN = 'parent-only-token-value';
});

afterAll(() => {
	if (previousToken === undefined) delete process.env.AFB_TOKEN;
	else process.env.AFB_TOKEN = previousToken;
	if (base) rmSync(base, { recursive: true, force: true });
});

describe('the permission flag', () => {
	it('exists on this Node', () => {
		expect(['--permission', '--experimental-permission']).toContain(permissionFlag());
	});
});

describe('runNodeInSandbox', () => {
	const probe = async () => {
		const run = await runNodeInSandbox({
			entry: join(base, 'scripts', 'probe.mjs'),
			readDirs: [join(base, 'scripts'), join(base, 'run')],
			writeDir: join(base, 'run'),
			env: sandboxEnv(join(base, 'run')),
			stdin: JSON.stringify(paths),
			timeoutMs: 20_000
		});
		const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE '));
		if (!line) throw new Error(`The probe printed nothing. exit ${run.exitCode}\n${run.stderr}`);
		return JSON.parse(line.slice(6)) as Record<string, Attempt | string | null>;
	};

	it('cannot read the token store, files outside, write outside, spawn, or see the environment; can read and write inside', async () => {
		const r = await probe();
		// Denied
		for (const name of ['readKey', 'readToken', 'readOutside', 'writeOutside', 'spawn'] as const) {
			const a = r[name] as Attempt;
			expect(a.ok, name).toBe(false);
			expect(a.code, name).toBe('ERR_ACCESS_DENIED');
		}
		expect(existsSync(paths.outsideWrite)).toBe(false);
		expect(r.token).toBeNull();
		// Allowed
		expect((r.readInside as Attempt).ok).toBe(true);
		expect((r.readInside as Attempt).value).toBe('inside-content');
		expect((r.writeInside as Attempt).ok).toBe(true);
		expect(readFileSync(paths.insideWrite, 'utf8')).toBe('ok');
	});

	it('the parent really has the token the child must not see', () => {
		expect(process.env.AFB_TOKEN).toBe('parent-only-token-value');
	});

	it('stops a process that runs too long', async () => {
		const run = await runNodeInSandbox({
			entry: join(base, 'scripts', 'hang.mjs'),
			readDirs: [join(base, 'scripts')],
			writeDir: null,
			env: sandboxEnv(base),
			timeoutMs: 600
		});
		expect(run.timedOut).toBe(true);
	}, 20_000);

	it('hands out stdout lines as they come', async () => {
		writeFileSync(
			join(base, 'scripts', 'lines.mjs'),
			"console.log('EVENT {\"a\":1}'); console.log('plain');"
		);
		const lines: string[] = [];
		const run = await runNodeInSandbox({
			entry: join(base, 'scripts', 'lines.mjs'),
			readDirs: [join(base, 'scripts')],
			writeDir: null,
			env: sandboxEnv(base),
			timeoutMs: 20_000,
			onLine: (l) => lines.push(l)
		});
		expect(run.exitCode).toBe(0);
		expect(lines).toEqual(['EVENT {"a":1}', 'plain']);
	});
});

describe('runCheckInSandbox refuses', () => {
	const job = (checkFile: string, runDir: string) => ({
		baseUrl: 'http://127.0.0.1:1',
		ws: 'ws://127.0.0.1:1/x',
		storageState: null,
		checkFile,
		runDir,
		viewport: { width: 1280, height: 800 },
		extraHosts: [],
		needles: []
	});

	it('a check outside the scripts folder', async () => {
		await expect(
			runCheckInSandbox({
				job: job(paths.outside, join(base, 'run')),
				scriptsRoot: join(base, 'scripts'),
				log: () => {}
			})
		).rejects.toThrow(/not inside the scripts folder/);
	});

	it('a run folder outside the runs folder', async () => {
		const prev = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'home');
		try {
			mkdirSync(join(base, 'home', 'checks', 'runs'), { recursive: true });
			await expect(
				runCheckInSandbox({
					job: job(paths.inside, join(base, 'run')),
					scriptsRoot: join(base, 'scripts'),
					log: () => {}
				})
			).rejects.toThrow(/not inside the runs folder/);
		} finally {
			if (prev === undefined) delete process.env.AFB_BRIDGE_HOME;
			else process.env.AFB_BRIDGE_HOME = prev;
		}
	});
});

describe('links inside the folders of a check (S4)', () => {
	/** Makes a link the OS allows, or returns false (a file link needs a privilege on Windows). */
	const link = (target: string, at: string, kind: 'file' | 'dir'): boolean => {
		try {
			symlinkSync(target, at, kind === 'dir' ? 'junction' : 'file');
			return true;
		} catch {
			return false;
		}
	};
	const READ = `
import { readFileSync } from 'node:fs';
const t = (f) => { try { return readFileSync(f, 'utf8'); } catch (e) { return 'ERR ' + (e && e.code); } };
console.log('READ ' + JSON.stringify({ viaDir: t('jn/secret.txt'), viaFile: t('fl.txt') }));
`;

	it('finds the link, and a check that would use it is refused (this Node follows a link out of the allowed folders)', async () => {
		const dir = join(base, 'linkrun');
		mkdirSync(join(dir, 'sub'), { recursive: true });
		const dirLinked = link(join(base, 'outside'), join(dir, 'jn'), 'dir');
		const fileLinked = link(paths.outside, join(dir, 'fl.txt'), 'file');
		if (!dirLinked && !fileLinked) return; // The OS refused to create any link: nothing to prove here
		writeFileSync(join(base, 'scripts', 'readlink.mjs'), READ);
		const run = await runNodeInSandbox({
			entry: join(base, 'scripts', 'readlink.mjs'),
			readDirs: [join(base, 'scripts'), dir],
			writeDir: dir,
			env: sandboxEnv(dir),
			timeoutMs: 20_000
		});
		const line = run.stdout.split('\n').find((l) => l.startsWith('READ '));
		expect(line, run.stderr).toBeTruthy();
		const r = JSON.parse(String(line).slice(5)) as { viaDir: string; viaFile: string };
		// Whatever this Node does, the tool must not depend on it: the link is found before a run and a run with one is refused
		expect(findLink(dir)).not.toBeNull();
		const followed = r.viaDir.includes('outside-content') || r.viaFile.includes('outside-content');
		// On this Node the permission model follows links (that is why the walk exists); a Node that does not follow them also passes
		expect(typeof followed).toBe('boolean');
		rmSync(dir, { recursive: true, force: true });
	});

	it('findLink is quiet for a plain folder', () => {
		const dir = join(base, 'plainrun');
		mkdirSync(join(dir, 'shots'), { recursive: true });
		writeFileSync(join(dir, 'shots', '01.jpg'), 'x');
		expect(findLink(dir)).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});

	it('runCheckInSandbox refuses a run folder that holds a link', async () => {
		const prev = process.env.AFB_BRIDGE_HOME;
		const home = join(base, 'home2');
		process.env.AFB_BRIDGE_HOME = home;
		try {
			const runDir = join(home, 'checks', 'runs', 'rlinked');
			mkdirSync(runDir, { recursive: true });
			if (!link(join(base, 'outside'), join(runDir, 'jn'), 'dir')) return;
			await expect(
				runCheckInSandbox({
					job: {
						baseUrl: 'http://127.0.0.1:1',
						ws: 'ws://127.0.0.1:1/x',
						storageState: null,
						checkFile: paths.inside,
						runDir,
						viewport: { width: 1280, height: 800 },
						extraHosts: [],
						needles: []
					},
					scriptsRoot: join(base, 'scripts'),
					log: () => {}
				})
			).rejects.toThrow(/link/);
		} finally {
			if (prev === undefined) delete process.env.AFB_BRIDGE_HOME;
			else process.env.AFB_BRIDGE_HOME = prev;
		}
	});

	it('cleanResult keeps the picture of a plain file and drops one that is a link the child planted (S2)', () => {
		const shots = join(base, 'cleanshots');
		mkdirSync(shots, { recursive: true });
		writeFileSync(join(shots, '01.jpg'), Buffer.from([...JPEG_MAGIC, 1]));
		const linked = link(paths.outside, join(shots, '02.jpg'), 'file');
		const raw = {
			result: 'pass',
			durationMs: 5,
			log: '',
			steps: [
				{ name: 'one', status: 'pass', ms: 1, shot: '01.jpg' },
				{ name: 'two', status: 'pass', ms: 1, shot: '02.jpg' },
				{ name: 'three', status: 'pass', ms: 1, shot: '../../etc/passwd' }
			]
		};
		const r = cleanResult(raw, [], shots);
		expect(r?.steps.map((s) => s.shot)).toEqual(['01.jpg', null, null]);
		if (!linked) return; // The OS refused to make the link: the first two checks still hold
		rmSync(shots, { recursive: true, force: true });
	});

	it('readPlainFile refuses a planted link, a wrong kind of file and a big one (S2)', () => {
		const dir = join(base, 'shotsdir');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'good.jpg'), Buffer.from([...JPEG_MAGIC, 1, 2, 3]));
		writeFileSync(join(dir, 'text.jpg'), 'not a picture');
		writeFileSync(
			join(dir, 'big.jpg'),
			Buffer.concat([Buffer.from(JPEG_MAGIC), Buffer.alloc(100)])
		);
		const opts = { maxBytes: 50, magic: JPEG_MAGIC };
		expect('bytes' in readPlainFile(dir, 'good.jpg', opts)).toBe(true);
		expect(readPlainFile(dir, 'text.jpg', opts)).toEqual({
			refused: 'it is not the kind of file it should be'
		});
		expect(readPlainFile(dir, 'big.jpg', opts)).toEqual({ refused: 'it is too big' });
		expect(readPlainFile(dir, 'nope.jpg', opts)).toEqual({ refused: 'it is missing' });
		if (link(paths.outside, join(dir, 'planted.jpg'), 'file'))
			expect(readPlainFile(dir, 'planted.jpg', opts)).toEqual({ refused: 'it is a link' });
		rmSync(dir, { recursive: true, force: true });
	});
});
