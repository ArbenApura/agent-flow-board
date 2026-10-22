// THE RUNNER PROGRAM'S OWN RULES: WHAT NEEDS THE OWNER'S YES, WHEN A BUILD IS REUSED, WHAT A FAILED BUILD REPORTS, THE DEPLOYED
// VERSION WAIT AND THE LOCKED DOWN CONTAINER OF A HOSTED RUN (SPEC 10, L1, L26, L27)

// -- DEP-MODULES -- //
import { spawn, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { ApiError, CALL_TIMEOUT_MS, RunnerApi, UPLOAD_TIMEOUT_MS, retryDelay } from './api';
import { Approvals, NeedsApproval } from './approvals';
import { SCRIPT_TIMEOUT_MS, runCheckJob, withTimeout } from './checks';
import { loadConfig } from './config';
import { appHash, changedPaths, headCommit } from './git';
import { dockerArgs } from './supervisor';
import {
	OUTPUT_KEEP,
	Targets,
	TargetUnavailable,
	killTree,
	sweepStaleRunDirs,
	tailBuffer
} from './targets';

// -- CONSTANTS -- //

const dirs: string[] = [];
const servers: Server[] = [];
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const q = (s: string) => `"${s}"`;

// -- FUNCTIONS -- //

function tmp(prefix: string) {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = netServer();
		s.listen(0, () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve(port));
		});
		s.on('error', reject);
	});
}

/** A repo with one commit and a tiny server script that answers on the port it is given. */
function makeRepo() {
	const repo = tmp('afb-runner-repo-');
	git(repo, 'init', '-q');
	git(repo, 'config', 'user.email', 'qa@example.com');
	git(repo, 'config', 'user.name', 'QA');
	mkdirSync(join(repo, 'app'));
	writeFileSync(join(repo, 'app', 'page.txt'), 'one');
	writeFileSync(
		join(repo, 'server.cjs'),
		"require('http').createServer((q, r) => r.end('ok')).listen(Number(process.argv[2]), '127.0.0.1');"
	);
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'first');
	return repo;
}

afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the owner approves what a local runner would run', () => {
	let file: string;
	beforeAll(() => {
		file = join(tmp('afb-approvals-'), 'approvals.json');
	});
	it('asks for a new command, remembers the answer for the exact text, and asks again when one character changes', () => {
		const a = new Approvals(file, 'local');
		expect(() => a.require('CKT', 'command', 'preview start', 'yarn preview')).toThrow(
			NeedsApproval
		);
		const waiting = a.pending();
		expect(waiting).toHaveLength(1);
		expect(waiting[0]).toMatchObject({
			kind: 'command',
			label: 'preview start',
			text: 'yarn preview'
		});
		expect(a.approve(waiting[0].key)).toBe(true);
		expect(() => a.require('CKT', 'command', 'preview start', 'yarn preview')).not.toThrow();
		expect(() => a.require('CKT', 'command', 'preview start', 'yarn preview ')).toThrow(
			NeedsApproval
		);
		// Another project does not borrow the answer, and a script is not a command
		expect(() => a.require('OTH', 'command', 'preview start', 'yarn preview')).toThrow(
			NeedsApproval
		);
		expect(() => a.require('CKT', 'script', 'preview start', 'yarn preview')).toThrow(
			NeedsApproval
		);
		// A rejected one is forgotten and asks again
		const next = a.pending()[0];
		expect(a.reject(next.key)).toBe(true);
		expect(a.approve(next.key)).toBe(false);
		expect(() => a.require('OTH', 'command', 'preview start', 'yarn preview')).toThrow(
			NeedsApproval
		);
	});
	it('needs no yes in a hosted container or when told to trust everything', () => {
		for (const mode of ['hosted', 'trust-all'] as const)
			expect(() =>
				new Approvals(file, mode).require('CKT', 'script', 'x', 'anything')
			).not.toThrow();
	});
});

describe('what code is being tested', () => {
	it('ties a run to the commit and to the uncommitted changes under the app paths', () => {
		const repo = makeRepo();
		const base = appHash(repo, ['app']);
		expect(headCommit(repo)).toMatch(/^[0-9a-f]{40}$/);
		expect(appHash(repo, ['app'])).toBe(base);
		writeFileSync(join(repo, 'app', 'page.txt'), 'two');
		const edited = appHash(repo, ['app']);
		expect(edited).not.toBe(base);
		writeFileSync(join(repo, 'app', 'new.txt'), 'new');
		expect(appHash(repo, ['app'])).not.toBe(edited);
		// A change outside the app paths does not change the hash, so an unrelated edit never forces a rebuild
		writeFileSync(join(repo, 'notes.md'), 'x');
		const withNew = appHash(repo, ['app']);
		writeFileSync(join(repo, 'notes.md'), 'y');
		expect(appHash(repo, ['app'])).toBe(withNew);
		expect(changedPaths(repo)).toEqual(['app/new.txt', 'app/page.txt', 'notes.md']);
	});
	it('says there is no commit in a folder that is not a repository', () => {
		const dir = tmp('afb-norepo-');
		expect(headCommit(dir)).toBeNull();
		expect(changedPaths(dir)).toEqual([]);
	});
});

describe('the build preview and the dev server', () => {
	const make = (repo: string, mode: 'local' | 'trust-all', served: object) => {
		const approvals = new Approvals(join(tmp('afb-ap-'), 'a.json'), mode);
		const config = { ...loadConfig(repo), appPaths: ['app'], preview: served, dev: served };
		const lines: string[] = [];
		return {
			approvals,
			targets: new Targets(repo, config, approvals, (l) => lines.push(l)),
			lines
		};
	};

	it('waits for the owner before it starts a server, then starts it, reuses it while nothing changed and restarts it after a change', async () => {
		const repo = makeRepo();
		const port = await freePort();
		const url = `http://127.0.0.1:${port}`;
		const { approvals, targets } = make(repo, 'local', {
			start: `${q(process.execPath)} server.cjs ${port}`,
			url
		});
		const job = { project: 'CKT', target: 'preview' as const, url, versionPath: null };
		await expect(targets.prepare(job)).rejects.toThrow(NeedsApproval);
		for (const e of approvals.pending()) approvals.approve(e.key);
		const first = await targets.prepare(job);
		expect(first.baseUrl).toBe(url);
		expect(first.diffHash).toMatch(/^[0-9a-f]{40}$/);
		expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
		expect((await fetch(url)).status).toBe(200);
		// Nothing changed: the running server is reused
		const second = await targets.prepare(job);
		expect(second.note).toMatch(/reused/);
		// A change in the app: the old server stops and a new one starts, with a different hash
		writeFileSync(join(repo, 'app', 'page.txt'), 'changed');
		const third = await targets.prepare(job);
		expect(third.diffHash).not.toBe(first.diffHash);
		expect(third.note ?? '').not.toMatch(/reused/);
		expect((await fetch(url)).status).toBe(200);
		targets.stopAll();
		await expect(fetch(url, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
	}, 60_000);

	it('refuses a run when the build fails, with the end of the build log, and never starts the server', async () => {
		const repo = makeRepo();
		const port = await freePort();
		const url = `http://127.0.0.1:${port}`;
		const { targets } = make(repo, 'trust-all', {
			build: `${q(process.execPath)} -e "console.error('compile error in page.svelte'); process.exit(3)"`,
			start: `${q(process.execPath)} server.cjs ${port}`,
			url
		});
		await expect(
			targets.prepare({ project: 'CKT', target: 'preview', url, versionPath: null })
		).rejects.toThrow(/build failed \(exit 3\)[\s\S]*compile error in page\.svelte/);
		await expect(fetch(url, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
	}, 30_000);

	it('says a target is not available when nothing answers and nothing can be started', async () => {
		const repo = makeRepo();
		const port = await freePort();
		const url = `http://127.0.0.1:${port}`;
		const config = { ...loadConfig(repo), appPaths: ['app'] };
		const targets = new Targets(
			repo,
			config,
			new Approvals(join(tmp('afb-ap-'), 'a.json'), 'trust-all'),
			() => {}
		);
		await expect(
			targets.prepare({ project: 'CKT', target: 'dev', url, versionPath: null })
		).rejects.toThrow(TargetUnavailable);
		// A server that is already running is used as it is when there is no command to start one
		const live = createServer((_q, r) => r.end('ok'));
		servers.push(live);
		await new Promise<void>((res) => live.listen(port, '127.0.0.1', res));
		const used = await targets.prepare({ project: 'CKT', target: 'dev', url, versionPath: null });
		expect(used.note).toMatch(/already running/);
	});

	it('does not give a started server the runner token or the server secrets', async () => {
		const repo = makeRepo();
		const port = await freePort();
		const url = `http://127.0.0.1:${port}`;
		writeFileSync(
			join(repo, 'env.cjs'),
			"require('http').createServer((q, r) => r.end(JSON.stringify({ t: process.env.AFB_RUNNER_TOKEN ?? null, m: process.env.AFB_MASTER_KEY ?? null, own: process.env.MY_OWN ?? null }))).listen(Number(process.argv[2]), '127.0.0.1');"
		);
		process.env.AFB_RUNNER_TOKEN = 'afx_secret_token_value';
		process.env.AFB_MASTER_KEY = 'a-master-key-that-must-not-leak-0123456789';
		try {
			const { targets } = make(repo, 'trust-all', {
				start: `${q(process.execPath)} env.cjs ${port}`,
				url,
				env: { MY_OWN: 'kept' }
			});
			await targets.prepare({ project: 'CKT', target: 'preview', url, versionPath: null });
			const seen = (await (await fetch(url)).json()) as Record<string, string | null>;
			expect(seen).toEqual({ t: null, m: null, own: 'kept' });
			targets.stopAll();
		} finally {
			delete process.env.AFB_RUNNER_TOKEN;
			delete process.env.AFB_MASTER_KEY;
		}
	}, 30_000);
});

describe('the deployed site', () => {
	it('waits until the site reports the commit under test, and says so when it cannot tell or never does', async () => {
		const repo = makeRepo();
		const head = headCommit(repo)!;
		let version = 'abc0000';
		const site = createServer((req, res) => {
			if (req.url === '/version') return void res.end(JSON.stringify({ commit: version }));
			res.end('ok');
		});
		servers.push(site);
		await new Promise<void>((res) => site.listen(0, '127.0.0.1', res));
		const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
		const approvals = new Approvals(join(tmp('afb-ap-'), 'a.json'), 'trust-all');
		const config = { ...loadConfig(repo), deployed: { waitMinutes: 0 } };
		const targets = new Targets(repo, config, approvals, () => {});
		// A site that cannot say which commit it runs: the run goes ahead, and the report says it cannot be tied to one
		const blind = await targets.prepare({
			project: 'CKT',
			target: 'deployed',
			url,
			versionPath: null
		});
		expect(blind.commit).toBeNull();
		expect(blind.note).toMatch(/does not say which commit/);
		// A site on another commit, with no wait left: it runs what is live, and says which version that was
		const stale = await targets.prepare({
			project: 'CKT',
			target: 'deployed',
			url,
			versionPath: '/version'
		});
		expect(stale.note).toMatch(/reports abc0000/);
		expect(stale.commit).toBe('abc0000');
		// A site that reports the commit under test
		version = head.slice(0, 7);
		const live = await targets.prepare({
			project: 'CKT',
			target: 'deployed',
			url,
			versionPath: '/version'
		});
		expect(live.note).toBeUndefined();
		expect(live.commit).toBe(head.slice(0, 7));
	});
});

describe('the container of a hosted run', () => {
	const args = dockerArgs({
		image: 'afb-runner',
		name: 'afb-run-1',
		server: 'https://board.example.com',
		network: 'egress-only'
	});
	it('is thrown away after one run, read only, without capabilities and with limits', () => {
		for (const flag of ['--rm', '--read-only', 'no-new-privileges'])
			expect(args.join(' ')).toContain(flag);
		expect(args).toEqual(
			expect.arrayContaining([
				'--cap-drop',
				'ALL',
				'--pids-limit',
				'512',
				'--memory',
				'2g',
				'--cpus',
				'2'
			])
		);
		expect(args.slice(args.indexOf('afb-runner'))).toEqual([
			'afb-runner',
			'start',
			'--hosted',
			'--stdin-job'
		]);
		expect(args.join(' ')).toContain('--network egress-only');
	});
	it('never gets the runner token, in the environment or on the command line, and mounts nothing', () => {
		expect(args.join(' ')).not.toContain('AFB_RUNNER_TOKEN');
		expect(args.join(' ')).not.toMatch(/afx_|afrun_/);
		expect(args).toContain('-i');
		expect(args).not.toContain('-v');
		expect(args).not.toContain('--volume');
		expect(args).not.toContain('--privileged');
		expect(args.join(' ')).not.toContain('--network host');
	});
});

// -- HANG GUARDS -- //

describe('the calls of the runner to the server', () => {
	const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

	it('gives every call a 30 second signal and an upload 120 seconds', async () => {
		const timeouts: number[] = [];
		const real = AbortSignal.timeout.bind(AbortSignal);
		const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
			timeouts.push(ms);
			return real(ms);
		});
		const seen: (AbortSignal | null | undefined)[] = [];
		const api = new RunnerApi('https://board.test', 'afx_t', async (_url, init) => {
			seen.push(init?.signal);
			return ok({ job: null, waiting: 0, attachmentId: 'a1' });
		});
		try {
			await api.claim();
			await api.upload('runs', 'r1', { filename: 'a.png', caption: 'c', bytes: new Uint8Array(2) });
		} finally {
			spy.mockRestore();
		}
		expect(timeouts).toEqual([CALL_TIMEOUT_MS, UPLOAD_TIMEOUT_MS]);
		expect(CALL_TIMEOUT_MS).toBe(30_000);
		expect(UPLOAD_TIMEOUT_MS).toBe(120_000);
		expect(seen.every((s) => s instanceof AbortSignal)).toBe(true);
	});

	it('turns a call that timed out into a clear error', async () => {
		const api = new RunnerApi('https://board.test', 'afx_t', async () => {
			throw Object.assign(new Error('The operation was aborted due to timeout'), {
				name: 'TimeoutError'
			});
		});
		const err = await api.claim().catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.code).toBe('TIMEOUT');
		expect(err.message).toMatch(/did not answer POST \/claim within 30 seconds/);
	});

	it('really gives up on a call that never answers', async () => {
		// A signal that is already aborted stands in for the 30 seconds
		const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
		const api = new RunnerApi(
			'https://board.test',
			'afx_t',
			(_url, init) =>
				new Promise((_res, rej) => {
					if (init?.signal?.aborted) rej(init.signal.reason);
				})
		);
		try {
			await expect(api.peek()).rejects.toMatchObject({ code: 'TIMEOUT' });
		} finally {
			spy.mockRestore();
		}
	});

	it('waits longer after each failure in a row, at most a minute', () => {
		expect([1, 2, 3, 4, 5, 6, 20].map(retryDelay)).toEqual([
			5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000
		]);
	});
});

describe('process guards of the targets', () => {
	const sleeper = `${q(process.execPath)} -e "setTimeout(() => {}, 600000)"`;

	it('stops a build that runs past its deadline, with a clear message', async () => {
		const repo = makeRepo();
		const approvals = new Approvals(join(tmp('afb-ap-'), 'a.json'), 'trust-all');
		const config = {
			...loadConfig(repo),
			appPaths: ['app'],
			preview: { build: sleeper, start: 'node -v', url: 'http://127.0.0.1:1' }
		};
		const targets = new Targets(repo, config, approvals, () => {}, tmp('afb-pids-'), 400);
		const started = Date.now();
		await expect(
			targets.prepare({
				project: 'CKT',
				target: 'preview',
				url: 'http://127.0.0.1:1',
				versionPath: null
			})
		).rejects.toThrow(/build took longer than .* and was stopped/);
		expect(Date.now() - started).toBeLessThan(20_000);
	}, 30_000);

	it('kills a process and its children', async () => {
		const parent = spawn(
			process.execPath,
			[
				'-e',
				"const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(()=>{},600000);"
			],
			{ stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' }
		);
		const childPid = Number(
			await new Promise<string>((res) => parent.stdout?.once('data', (d) => res(String(d).trim())))
		);
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		expect(alive(childPid)).toBe(true);
		killTree(parent);
		for (let i = 0; i < 100 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 50));
		expect(alive(childPid)).toBe(false);
	}, 20_000);

	it('keeps only the last 4 KB of what a process prints', () => {
		const t = tailBuffer();
		for (let i = 0; i < 1000; i++) t.push(`line ${i} ${'x'.repeat(50)}\n`);
		expect(t.text().length).toBe(OUTPUT_KEEP);
		expect(OUTPUT_KEEP).toBe(4096);
		expect(t.text()).toContain('line 999');
		expect(t.text()).not.toContain('line 0 ');
	});

	it('removes only afb-run folders older than a day', () => {
		const root = tmp('afb-sweep-');
		const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
		const mk = (name: string, when: Date) => {
			mkdirSync(join(root, name));
			utimesSync(join(root, name), when, when);
		};
		mk('afb-run-old', old);
		mk('afb-run-new', new Date());
		mk('other-old', old);
		writeFileSync(join(root, 'afb-run-file'), 'x');
		utimesSync(join(root, 'afb-run-file'), old, old);
		expect(sweepStaleRunDirs(root)).toBe(1);
		expect(existsSync(join(root, 'afb-run-old'))).toBe(false);
		expect(existsSync(join(root, 'afb-run-new'))).toBe(true);
		expect(existsSync(join(root, 'other-old'))).toBe(true);
		expect(existsSync(join(root, 'afb-run-file'))).toBe(true);
	});

	it('writes a pid file for a started server and removes it on stop', async () => {
		const repo = makeRepo();
		const port = await freePort();
		const url = `http://127.0.0.1:${port}`;
		const pidDir = tmp('afb-pids-');
		const approvals = new Approvals(join(tmp('afb-ap-'), 'a.json'), 'trust-all');
		const config = {
			...loadConfig(repo),
			appPaths: ['app'],
			preview: { start: `${q(process.execPath)} server.cjs ${port}`, url }
		};
		const targets = new Targets(repo, config, approvals, () => {}, pidDir);
		await targets.prepare({ project: 'CKT', target: 'preview', url, versionPath: null });
		expect(readdirSync(pidDir)).toEqual(['CKT_preview.pid']);
		targets.stopAll();
		expect(readdirSync(pidDir)).toEqual([]);
	}, 30_000);

	it('stops a server an earlier runner left behind before it starts a new one', async () => {
		const repo = makeRepo();
		const port = await freePort();
		const url = `http://127.0.0.1:${port}`;
		const pidDir = tmp('afb-pids-');
		const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
			stdio: 'ignore',
			detached: process.platform !== 'win32'
		});
		const pid = orphan.pid!;
		writeFileSync(join(pidDir, 'CKT_preview.pid'), String(pid));
		const lines: string[] = [];
		const approvals = new Approvals(join(tmp('afb-ap-'), 'a.json'), 'trust-all');
		const config = {
			...loadConfig(repo),
			appPaths: ['app'],
			preview: { start: `${q(process.execPath)} server.cjs ${port}`, url }
		};
		const targets = new Targets(repo, config, approvals, (l) => lines.push(l), pidDir);
		await targets.prepare({ project: 'CKT', target: 'preview', url, versionPath: null });
		for (let i = 0; i < 100 && orphan.exitCode === null && orphan.signalCode === null; i++)
			await new Promise((r) => setTimeout(r, 50));
		expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
		expect(lines.some((l) => l.includes(`process ${pid}`))).toBe(true);
		targets.stopAll();
	}, 30_000);
});

describe('the check script guards', () => {
	/** A browser that records how often a context was made and closed, and a job whose script throws. */
	function harness(readOnly: boolean, script: string) {
		const calls = { contexts: 0, closed: 0, finished: [] as Record<string, unknown>[] };
		const page = { screenshot: async () => undefined, video: () => null };
		const browser = {
			newContext: async () => {
				calls.contexts++;
				return {
					tracing: { start: async () => undefined, stop: async () => undefined },
					route: async () => undefined,
					newPage: async () => page,
					close: async () => {
						calls.closed++;
					}
				};
			}
		};
		const api = {
			accounts: async () => ({}),
			upload: async () => 'att',
			finish: async (_k: string, _id: string, r: Record<string, unknown>) => {
				calls.finished.push(r);
				return {};
			}
		};
		const targets = {
			prepare: async () => ({ baseUrl: 'http://127.0.0.1:1', commit: null, diffHash: null })
		};
		const approvals = { require: () => undefined };
		const job = {
			id: 'run1',
			project: { key: 'CKT' },
			item: { ref: 'CKT-1' },
			check: { key: 'M1', script },
			target: 'preview',
			environment: { url: 'http://127.0.0.1:1', versionPath: null },
			accounts: [],
			readOnly
		};
		const deps = { api, browser, targets, approvals, config: {}, log: () => undefined };
		return { calls, run: () => runCheckJob(job as never, deps as never) };
	}

	it('retries a failed script on a read only target and not on a writable one', async () => {
		const ro = harness(true, "throw new Error('boom')");
		await ro.run();
		expect(ro.calls.contexts).toBe(2);
		expect(ro.calls.finished[0]).toMatchObject({ result: 'fail', reason: 'boom' });
		const rw = harness(false, "throw new Error('boom')");
		await rw.run();
		expect(rw.calls.contexts).toBe(1);
		expect(rw.calls.finished[0]).toMatchObject({ result: 'fail', retried: false });
	});

	it('closes every context it opened, also when the script fails', async () => {
		const h = harness(true, "throw new Error('boom')");
		await h.run();
		expect(h.calls.closed).toBeGreaterThanOrEqual(h.calls.contexts);
	});

	it('a timeout runs the stop action and rejects with a clear message', async () => {
		let stopped = 0;
		const never = new Promise<never>(() => undefined);
		await expect(withTimeout(never, 30, 'The check script', () => stopped++)).rejects.toThrow(
			/The check script took longer than/
		);
		expect(stopped).toBe(1);
		expect(SCRIPT_TIMEOUT_MS).toBe(120_000);
	});
});
