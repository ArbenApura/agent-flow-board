// TESTS OF STATUS, DOCTOR --FIX AND CLEAR: WHAT IS FOUND, WHAT IS REMOVED BY RECORDED NAME ONLY, WHAT IS NEVER TOUCHED (A LIVE RUN, A YOUNG FOLDER, A SCRIPT).

// IMPORTED DEP-MODULES
import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { mintApproval } from './approve.js';
import {
	auditFile,
	brokerDir,
	copiesDir,
	endedPath,
	locksDir,
	markerPath,
	markersDir,
	poolDir,
	runsDir,
	scriptsDir
} from './paths.js';
import { acquireLock } from './lock.js';
import { saveProfile } from './profiles.js';
import {
	clearCommand,
	healthCommand,
	proxyHost,
	runDoctor,
	runStatus,
	trustedBoard
} from './doctor.js';
import type { BrowserReport, HealthContext, HealthDeps } from './doctor.js';
import { recordConnection } from './connections.js';
import {
	findRegistration,
	pinRegistration,
	pinState,
	registerProject,
	saveRegistration
} from './registry.js';
import { addRoot } from './roots.js';
import { writeServiceStatus } from './service.js';
import { listProfiles } from './profiles.js';
import type { TokenStore } from '../tokenStore.js';

// -- FUNCTIONS -- //

const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid ?? 2_000_000_000;

describe('doctor', () => {
	let base = '';
	let work = '';
	let saved: string | undefined;
	let dockerCalls: string[][] = [];
	const lines: string[] = [];
	const outs: string[] = [];
	const deleted: string[] = [];
	const store: TokenStore = {
		kind: 'file',
		get: () => 'token',
		set: () => {},
		delete: (a) => {
			deleted.push(a);
		}
	};
	const ctx = (): HealthContext => ({
		log: (l) => lines.push(l),
		out: (l) => outs.push(l),
		json: false,
		store
	});
	const deps = (extra: HealthDeps = {}): HealthDeps => ({
		docker: async (args) => {
			dockerCalls.push(args);
			return { status: 0, stdout: '', stderr: '' };
		},
		hasPermissionModel: () => true,
		browserInstalled: () => true,
		sweepWarm: async () => 0,
		...extra
	});
	const old = (path: string, minutesAgo: number) => {
		const t = new Date(Date.now() - minutesAgo * 60_000);
		utimesSync(path, t, t);
	};
	const runDir = (id: string, marker?: object, minutesAgo = 60) => {
		const dir = join(runsDir(), id);
		mkdirSync(dir, { recursive: true });
		if (marker) {
			mkdirSync(markersDir(), { recursive: true });
			writeFileSync(markerPath(id), JSON.stringify({ runId: id, ...marker }));
		}
		old(dir, minutesAgo);
		return dir;
	};
	const repoAt = (name: string) => {
		const dir = join(work, name);
		mkdirSync(join(dir, '.git'), { recursive: true });
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ scripts: { preview: 'vite preview', build: 'vite build' } })
		);
		return realpathSync.native(dir);
	};

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-doctor-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		work = join(base, 'work');
		mkdirSync(work);
		work = realpathSync.native(work);
		addRoot(work, mintApproval('roots', work, { isTTY: true }).code);
		dockerCalls = [];
		lines.length = 0;
		outs.length = 0;
		deleted.length = 0;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	describe('runs and what they leave', () => {
		it('removes a dead run and its container by the recorded name, and keeps a live run', async () => {
			runDir('rdead1', { pid: deadPid(), startedAt: 'x', containerName: 'afb-checks-rdead1' });
			runDir('rlive1', { pid: process.pid, startedAt: 'x', containerName: 'afb-checks-rlive1' });
			const r = await runDoctor(ctx(), { fix: true }, deps());
			expect(existsSync(join(runsDir(), 'rdead1'))).toBe(false);
			expect(existsSync(join(runsDir(), 'rlive1'))).toBe(true);
			expect(dockerCalls).toEqual([['rm', '-f', '-v', 'afb-checks-rdead1']]);
			expect(r.fixed.join(' ')).toMatch(/1 run\(s\) left by a process that is gone/);
		});

		it('reports without removing when --fix is not given', async () => {
			runDir('rdead2', { pid: deadPid(), startedAt: 'x' });
			const r = await runDoctor(ctx(), { fix: false }, deps());
			expect(existsSync(join(runsDir(), 'rdead2'))).toBe(true);
			expect(r.ok).toBe(false);
			expect(r.problems[0]?.next).toMatch(/doctor --fix/);
			expect(dockerCalls).toEqual([]);
		});

		it('never calls docker when no marker names a container', async () => {
			runDir('rdead3', { pid: deadPid(), startedAt: 'x' });
			await runDoctor(ctx(), { fix: true }, deps());
			expect(dockerCalls).toEqual([]);
		});

		it('removes an old stray copy and keeps a young one and a live one', async () => {
			mkdirSync(join(copiesDir(), 'rstray'), { recursive: true });
			old(join(copiesDir(), 'rstray'), 30);
			mkdirSync(join(copiesDir(), 'ryoung'), { recursive: true });
			mkdirSync(join(copiesDir(), 'rlive2'), { recursive: true });
			old(join(copiesDir(), 'rlive2'), 30);
			runDir('rlive2', { pid: process.pid, startedAt: 'x' });
			await runDoctor(ctx(), { fix: true }, deps());
			expect(existsSync(join(copiesDir(), 'rstray'))).toBe(false);
			expect(existsSync(join(copiesDir(), 'ryoung'))).toBe(true);
			expect(existsSync(join(copiesDir(), 'rlive2'))).toBe(true);
		});

		it('keeps the newest runs and removes the rest, never a live one or a young one', async () => {
			for (let i = 0; i < 6; i++) {
				const d = runDir(`rfin${i}`, undefined, 100 - i);
				mkdirSync(markersDir(), { recursive: true });
				writeFileSync(endedPath(basename(d)), 'x');
				old(d, 100 - i);
			}
			runDir('ryoungrun', undefined, 0);
			runDir('rlive3', { pid: process.pid, startedAt: 'x' }, 500);
			await runDoctor(ctx(), { fix: true }, deps({ keepRuns: 3 }));
			const left = readdirSync(runsDir()).sort();
			// Newest first: ryoungrun (0 min) and rfin5, rfin4 are the three kept; rlive3 is live
			expect(left).toContain('rlive3');
			expect(left).toContain('ryoungrun');
			expect(left).toContain('rfin5');
			expect(left).not.toContain('rfin0');
			expect(left).not.toContain('rfin1');
		});
	});

	describe('markers, pools and the worker lock', () => {
		it('removes broker and pool markers whose process is dead and keeps live ones', async () => {
			mkdirSync(join(brokerDir(), 'slots'), { recursive: true });
			mkdirSync(join(poolDir(), 'warm', 'use'), { recursive: true });
			writeFileSync(
				join(brokerDir(), 'slots', 'slot-0.json'),
				JSON.stringify({ pid: deadPid(), startedAt: 1 })
			);
			writeFileSync(
				join(brokerDir(), 'slots', 'slot-1.json'),
				JSON.stringify({ pid: process.pid, startedAt: 1 })
			);
			writeFileSync(join(poolDir(), 'warm', 'use', 'a.json'), JSON.stringify({ pid: deadPid() }));
			writeFileSync(join(poolDir(), 'other.json'), JSON.stringify({ ownerPid: deadPid() }));
			const r = await runDoctor(ctx(), { fix: true }, deps());
			expect(existsSync(join(brokerDir(), 'slots', 'slot-0.json'))).toBe(false);
			expect(existsSync(join(brokerDir(), 'slots', 'slot-1.json'))).toBe(true);
			expect(existsSync(join(poolDir(), 'warm', 'use', 'a.json'))).toBe(false);
			// A file without a plain pid is not this sweep's to remove
			expect(existsSync(join(poolDir(), 'other.json'))).toBe(true);
			expect(r.fixed.join(' ')).toMatch(/marker/);
		});

		it('removes the pooled container of a dead owner by its recorded name only', async () => {
			mkdirSync(poolDir(), { recursive: true });
			const id = 'abcdef12';
			writeFileSync(
				join(poolDir(), `db-${id}.json`),
				JSON.stringify({
					kind: 'db',
					poolId: id,
					containerName: `afb-checks-pool-${id}`,
					port: 6543,
					ownerPid: deadPid(),
					ownerStartedAt: 1,
					image: 'postgres:17',
					maxConnections: 100,
					slots: 3,
					password: 'x',
					createdAt: new Date(Date.now() - 60 * 60_000).toISOString()
				})
			);
			await runDoctor(ctx(), { fix: true }, deps());
			expect(dockerCalls).toEqual([['rm', '-f', '-v', `afb-checks-pool-${id}`]]);
			expect(existsSync(join(poolDir(), `db-${id}.json`))).toBe(false);
		});

		it('removes a stale worker lock and keeps a live one', async () => {
			mkdirSync(locksDir(), { recursive: true });
			const dead = join(locksDir(), 'machine-old.lock');
			writeFileSync(
				dead,
				JSON.stringify({ pid: deadPid(), at: new Date().toISOString(), token: 'a' })
			);
			const live = acquireLock('machine-live', { staleMs: 3_600_000 });
			expect(live).not.toBeNull();
			const r = await runDoctor(ctx(), { fix: true }, deps());
			live?.release();
			expect(existsSync(dead)).toBe(false);
			expect(r.fixed.join(' ')).toMatch(/stale worker lock/);
		});
	});

	describe('connections', () => {
		it('forgets the credential of a board that is not trusted', async () => {
			recordConnection({ server: 'http://evil.example.com', org: 'acme', name: 'x' });
			recordConnection({ server: 'https://board.example.com', org: 'acme', name: 'y' });
			const r = await runDoctor(ctx(), { fix: true }, deps());
			expect(deleted.length).toBe(1);
			expect(r.fixed.join(' ')).toMatch(/not trusted/);
			const again = await runDoctor(ctx(), { fix: false }, deps());
			expect(again.problems.join()).not.toMatch(/not trusted/);
		});

		it('names a connection with no token and the exact command', async () => {
			recordConnection({ server: 'https://board.example.com', org: 'acme', name: 'y' });
			const r = await runDoctor(ctx(), { fix: false }, deps({ token: () => null }));
			expect(r.problems[0]?.next).toMatch(
				/check connect --server https:\/\/board.example.com --org acme/
			);
		});

		it('trusts https and a local address only', () => {
			expect(trustedBoard('https://afb.example.com')).toBe(true);
			expect(trustedBoard('http://127.0.0.1:5180')).toBe(true);
			expect(trustedBoard('http://board.example.com')).toBe(false);
			expect(trustedBoard('https://user:pw@board.example.com')).toBe(false);
			expect(trustedBoard('nonsense')).toBe(false);
		});
	});

	describe('registrations', () => {
		it('reports a collision between two registrations of one folder', async () => {
			const repo = repoAt('shared');
			registerProject({ org: 'acme', name: 'AAA', repo });
			// A file written by hand (with a valid seal) as another tool version might: the same folder under a second name
			saveRegistration({
				org: 'acme',
				name: 'BBB',
				boardProject: 'BBB',
				repo,
				recipe: false,
				database: 'none',
				adoptEnv: false,
				uploadSignedInPictures: false,
				createdAt: new Date().toISOString()
			});
			const r = await runDoctor(ctx(), { fix: true }, deps());
			expect(r.problems.some((p) => /name the same repo folder/.test(p.problem))).toBe(true);
		});

		it('reports a registration file that was changed by hand', async () => {
			const repo = repoAt('hand');
			registerProject({ org: 'acme', name: 'HAND', repo });
			const file = join(base, 'bridge-home', 'checks', 'registrations', 'acme', 'HAND.json');
			writeFileSync(
				file,
				JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), adoptEnv: true })
			);
			const r = await runDoctor(ctx(), { fix: false }, deps());
			expect(r.problems.some((p) => /changed outside/.test(p.problem))).toBe(true);
		});

		it('pins a changed surface again on --fix, after the guardrails', async () => {
			const repo = repoAt('pinned');
			registerProject({ org: 'acme', name: 'PIN', repo });
			pinRegistration('acme', 'PIN');
			writeFileSync(
				join(repo, 'package.json'),
				JSON.stringify({ scripts: { preview: 'vite preview', build: 'vite build --mode x' } })
			);
			const now = findRegistration('acme', 'PIN');
			expect(now && pinState(now)).toBe('changed');
			const before = await runDoctor(ctx(), { fix: false }, deps());
			expect(before.problems.some((p) => /changed since they were pinned/.test(p.problem))).toBe(
				true
			);
			const after = await runDoctor(ctx(), { fix: true }, deps());
			expect(after.fixed.join(' ')).toMatch(/pinned again/);
			const clean = await runDoctor(ctx(), { fix: false }, deps());
			expect(clean.problems).toEqual([]);
		});

		it('reports a repo that left the approved roots', async () => {
			const repo = repoAt('rooted');
			registerProject({ org: 'acme', name: 'ROOT', repo });
			writeFileSync(join(base, 'bridge-home', 'checks', 'roots.json'), '{}');
			const r = await runDoctor(ctx(), { fix: false }, deps());
			expect(r.problems.some((p) => /not inside a folder the owner approved/.test(p.problem))).toBe(
				true
			);
		});
	});

	describe('audit, browser, service', () => {
		it('reports a broken audit chain and cannot fix it', async () => {
			const a = await runDoctor(ctx(), { fix: false }, deps());
			expect(a.ok).toBe(true);
			registerProject({ org: 'acme', name: 'AUD', repo: repoAt('aud') });
			appendFileSync(auditFile(), '{"not":"a chain line"}\n');
			const r = await runDoctor(ctx(), { fix: true }, deps());
			expect(r.problems.some((p) => /audit log does not verify/.test(p.problem))).toBe(true);
		});

		it('installs the browser only with --fix', async () => {
			let installs = 0;
			const d = deps({
				browserInstalled: () => false,
				ensureBrowser: async () => {
					installs++;
				}
			});
			const plain = await runDoctor(ctx(), { fix: false }, d);
			expect(installs).toBe(0);
			expect(plain.problems[0]?.problem).toMatch(/browser is not installed/);
			const fixed = await runDoctor(ctx(), { fix: true }, d);
			expect(installs).toBe(1);
			expect(fixed.fixed).toContain('The browser was installed.');
		});

		// -- THE HONEST BROWSER REPORT (AFB-20261115-1229): OK, MISSING OR WRONG, ONE YES FOR THE WHOLE DOWNLOAD -- //

		const report = (over: Partial<BrowserReport> = {}): BrowserReport => ({
			bridge: '0.8.0',
			runtime: '1.64.0',
			pinned: '1.64.0',
			executable: '/home/x/.agent-flow-board/checks/browsers/chromium-1248/chrome',
			executableExists: true,
			launches: { ok: true, detail: 'it starts' },
			node: '22.1.0',
			diskFreeMb: 50_000,
			proxy: null,
			...over
		});
		const browserDeps = (r: BrowserReport, extra: HealthDeps = {}): HealthDeps => {
			const d = deps({ browserReport: async () => r, ...extra });
			delete d.browserInstalled;
			return d;
		};

		it('a healthy browser is one OK line with its path, and no problem', async () => {
			const r = await runDoctor(ctx(), { fix: false }, browserDeps(report()));
			expect(r.problems.filter((p) => /rowser/.test(p.problem))).toEqual([]);
			expect((r.notes ?? []).join('\n')).toMatch(
				/Browser: OK \(Playwright 1\.64\.0, .*chromium-1248/
			);
			expect((r.notes ?? []).join('\n')).toMatch(
				/Bridge 0\.8\.0, Node 22\.1\.0, Playwright pinned 1\.64\.0/
			);
		});

		it('the packages alone are not a browser: a runtime with no browser file is Missing, with the command that fixes it', async () => {
			const r = await runDoctor(
				ctx(),
				{ fix: false },
				browserDeps(report({ executableExists: false, launches: null }))
			);
			expect(r.problems[0]).toMatchObject({ problem: 'The browser is missing.' });
			expect(r.problems[0]?.next).toBe('Run: agent-flow-board check doctor --fix --yes');
		});

		it('another browser version in the runtime is Wrong', async () => {
			const r = await runDoctor(ctx(), { fix: false }, browserDeps(report({ runtime: '1.66.0' })));
			expect(r.problems[0]?.problem).toMatch(/Playwright 1\.66\.0 but this bridge needs 1\.64\.0/);
		});

		it('a browser that does not start is Wrong and says why', async () => {
			const r = await runDoctor(
				ctx(),
				{ fix: false },
				browserDeps(
					report({ launches: { ok: false, detail: 'it did not start within 20 seconds' } })
				)
			);
			expect(r.problems[0]?.problem).toMatch(
				/browser is there but it did not start within 20 seconds/
			);
		});

		it('--fix with no yes and no terminal downloads nothing and prints the one command', async () => {
			let installs = 0;
			const r = await runDoctor(
				ctx(),
				{ fix: true },
				browserDeps(report({ runtime: null, executableExists: false, launches: null }), {
					ensureBrowser: async () => void installs++
				})
			);
			expect(installs).toBe(0);
			expect(lines.join('\n')).toMatch(/about 320 MB/);
			expect(r.problems[0]?.next).toMatch(/--fix --yes \(it downloads about 320 MB\)/);
		});

		it('--fix with the one yes installs the whole set once, and a stand-in yes counts the same', async () => {
			let installs = 0;
			const missing = report({ runtime: null, executableExists: false, launches: null });
			const withYes = await runDoctor(
				ctx(),
				{ fix: true },
				browserDeps(missing, { yes: true, ensureBrowser: async () => void installs++ })
			);
			expect(installs).toBe(1);
			expect(withYes.fixed).toContain('The browser was installed.');
			const asked: string[] = [];
			const answered = await runDoctor(
				ctx(),
				{ fix: true },
				browserDeps(missing, {
					confirm: async (q) => (asked.push(q), true),
					ensureBrowser: async () => void installs++
				})
			);
			expect(asked).toHaveLength(1);
			expect(installs).toBe(2);
			expect(answered.fixed).toContain('The browser was installed.');
		});

		it('a failed install says what went wrong and the command to try again', async () => {
			const r = await runDoctor(
				ctx(),
				{ fix: true },
				browserDeps(report({ runtime: null, executableExists: false, launches: null }), {
					yes: true,
					ensureBrowser: async () => {
						throw new Error('Could not install the Chromium browser: the disk is full');
					}
				})
			);
			expect(r.problems[0]?.problem).toMatch(/the disk is full/);
			expect(r.problems[0]?.next).toMatch(/--fix --yes/);
		});

		it('a browser that is there but does not start is not called repaired until it is installed again (one yes), and missing libraries are not cured by a download', async () => {
			let installs = 0;
			const broken = report({ launches: { ok: false, detail: 'it does not start: crashed' } });
			const noYes = await runDoctor(
				ctx(),
				{ fix: true },
				browserDeps(broken, { ensureBrowser: async () => void installs++ })
			);
			expect(installs).toBe(0);
			expect(noYes.problems[0]?.next).toMatch(/--fix --yes/);
			const withYes = await runDoctor(
				ctx(),
				{ fix: true },
				browserDeps(broken, { yes: true, ensureBrowser: async () => void installs++ })
			);
			expect(installs).toBe(1);
			expect(withYes.fixed).toContain('The browser was repaired.');
			const libs = await runDoctor(
				ctx(),
				{ fix: true },
				browserDeps(
					report({
						launches: {
							ok: false,
							detail: 'it cannot start because this computer is missing system libraries'
						}
					}),
					{ yes: true, ensureBrowser: async () => void installs++ }
				)
			);
			expect(installs).toBe(1);
			expect(libs.problems[0]?.next).toMatch(/system libraries/);
		});

		it('`check status` never starts a browser: the file is there and it says doctor tests the start', async () => {
			const r = await runDoctor(
				ctx(),
				{ fix: false },
				browserDeps(report({ launches: null }), { skipLaunch: true })
			);
			expect(r.problems.filter((p) => /rowser/.test(p.problem))).toEqual([]);
			expect((r.notes ?? []).join('\n')).toMatch(/Browser: present .*check doctor/);
		});

		it('an old Node is Wrong with where to get a new one', async () => {
			const r = await runDoctor(ctx(), { fix: false }, browserDeps(report({ node: '18.19.0' })));
			expect(r.problems.some((p) => /Node 18\.19\.0 is too old/.test(p.problem))).toBe(true);
		});

		it('a proxy shows only its host and port, never a user name or a password', async () => {
			expect(proxyHost({ HTTPS_PROXY: 'http://u:s3cret@proxy.corp:8080' })).toBe('proxy.corp:8080');
			expect(proxyHost({ http_proxy: 'user:pw@proxy.corp:3128' })).toBe('proxy.corp:3128');
			expect(proxyHost({})).toBeNull();
			const r = await runDoctor(
				ctx(),
				{ fix: false },
				browserDeps(
					report({ proxy: proxyHost({ HTTPS_PROXY: 'http://u:s3cret@proxy.corp:8080' }) })
				)
			);
			const out = JSON.stringify(r) + lines.join('\n');
			expect(out).toMatch(/Proxy: set \(proxy\.corp:8080\)/);
			expect(out).not.toMatch(/s3cret|u:s3/);
		});

		it('a low disk is said before the download', async () => {
			const r = await runDoctor(ctx(), { fix: false }, browserDeps(report({ diskFreeMb: 300 })));
			expect((r.notes ?? []).join('\n')).toMatch(/Free disk space: low \(300 MB/);
		});

		it('reports a stopped service with its message and does not change it', async () => {
			writeServiceStatus({ state: 'stopped', message: 'The sign-in no longer works.' });
			const r = await runDoctor(ctx(), { fix: true }, deps());
			expect(r.problems.some((p) => /worker service stopped/.test(p.problem))).toBe(true);
		});
	});

	describe('status', () => {
		it('prints the registrations, slots, service, connections and audit chain as json', async () => {
			const repo = repoAt('stat');
			registerProject({ org: 'acme', name: 'STAT', repo });
			recordConnection({ server: 'https://board.example.com', org: 'acme', name: 'y' });
			const code = await healthCommand(['status', '--json'], { ...ctx(), json: undefined }, deps());
			expect(code).toBe(0);
			const s = JSON.parse(outs[0] ?? '{}') as Awaited<ReturnType<typeof runStatus>>;
			expect(s.registrations).toMatchObject([
				{ org: 'acme', name: 'STAT', kind: 'repo', folder: 'stat', pin: 'unpinned', signIns: 0 }
			]);
			expect(s.slots?.slots).toBeGreaterThan(0);
			expect(s.connections).toEqual([
				{ server: 'https://board.example.com', org: 'acme', connected: true }
			]);
			expect(s.audit.ok).toBe(true);
			// Names and counts only: no repo path
			expect(outs[0]).not.toContain(work);
		});

		it('exits 1 for doctor with a problem listed and 0 for status', async () => {
			runDir('rdead9', { pid: deadPid(), startedAt: 'x' });
			expect(await healthCommand(['doctor'], ctx(), deps())).toBe(1);
			expect(await healthCommand(['status'], ctx(), deps())).toBe(0);
			expect(await healthCommand(['doctor', '--fix'], ctx(), deps())).toBe(0);
		});
	});

	describe('clear', () => {
		it('needs --yes for what deletes data', async () => {
			expect(await clearCommand(['clear', 'dbs'], ctx(), deps())).toBe(2);
			expect(await clearCommand(['clear', 'all'], ctx(), deps())).toBe(2);
			expect(await clearCommand(['clear', 'nonsense'], ctx(), deps())).toBe(2);
		});

		it('clears finished runs, never a live one and never the scripts', async () => {
			const d = runDir('rdone1', undefined, 60 * 24 * 10);
			mkdirSync(markersDir(), { recursive: true });
			writeFileSync(endedPath(basename(d)), 'x');
			old(d, 60 * 24 * 10);
			runDir('rlive4', { pid: process.pid, startedAt: 'x' });
			mkdirSync(join(scriptsDir(), 'acme', 'AFB-1'), { recursive: true });
			writeFileSync(join(scriptsDir(), 'acme', 'AFB-1', 'k.mjs'), '// check');
			expect(await clearCommand(['clear', 'runs', '--all'], ctx(), deps())).toBe(0);
			expect(existsSync(join(runsDir(), 'rdone1'))).toBe(false);
			expect(existsSync(join(runsDir(), 'rlive4'))).toBe(true);
			expect(await clearCommand(['clear', 'all', '--yes'], ctx(), deps())).toBe(0);
			expect(existsSync(join(scriptsDir(), 'acme', 'AFB-1', 'k.mjs'))).toBe(true);
			expect(existsSync(join(runsDir(), 'rlive4'))).toBe(true);
		});

		it('clear dbs removes a dead run container by its recorded name only', async () => {
			runDir('rdead5', { pid: deadPid(), startedAt: 'x', containerName: 'afb-checks-rdead5' });
			expect(await clearCommand(['clear', 'dbs', '--yes'], ctx(), deps())).toBe(0);
			expect(dockerCalls).toEqual([['rm', '-f', '-v', 'afb-checks-rdead5']]);
		});

		it('profiles and auth need the registration', async () => {
			expect(await clearCommand(['clear', 'profiles', '--yes'], ctx(), deps())).toBe(2);
			expect(
				await clearCommand(
					['clear', 'profiles', '--yes', '--registration', 'NOPE', '--org', 'acme'],
					ctx(),
					deps()
				)
			).toBe(2);
		});

		it('clears the saved sign-ins of one registration and, for auth, forgets its connections', async () => {
			const repo = repoAt('prof');
			registerProject({ org: 'acme', name: 'PROF', repo });
			saveProfile('acme', 'PROF', 'http://127.0.0.1:4000', { cookies: [] });
			saveProfile('acme', 'PROF', 'http://127.0.0.1:4001', { cookies: [] });
			expect(listProfiles('acme', 'PROF')).toHaveLength(2);
			expect(
				await clearCommand(
					[
						'clear',
						'profiles',
						'--yes',
						'--registration',
						'PROF',
						'--org',
						'acme',
						'--site',
						'http://127.0.0.1:4000'
					],
					ctx(),
					deps()
				)
			).toBe(0);
			expect(listProfiles('acme', 'PROF')).toHaveLength(1);
			recordConnection({ server: 'https://board.example.com', org: 'acme', name: 'y' });
			expect(
				await clearCommand(
					['clear', 'auth', '--yes', '--registration', 'PROF', '--org', 'acme'],
					ctx(),
					deps()
				)
			).toBe(0);
			expect(listProfiles('acme', 'PROF')).toHaveLength(0);
			expect(deleted.length).toBe(1);
		});
	});
});
