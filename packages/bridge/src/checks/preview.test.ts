// THE PREVIEW: THE PRIVATE COPY, THE PORT PICK, THE READY WAIT AND A WHOLE RUN OF A SMALL NODE APP FROM A FIXTURE REPO (NO BUILD TOOL NEEDED)

// IMPORTED DEP-MODULES
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	closeSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { makePrivateCopy } from './copy.js';
import { FORBIDDEN_PORTS } from './guardrails.js';
import { copiesDir, logDirFor, runsDir } from './paths.js';
import { pickPort, runToEnd, stageError, startPreview, tailOf, waitReady } from './preview.js';
import { InfraError, singleFlight } from './singleflight.js';
import { pidAlive } from './lock.js';
import { RunScope } from './scope.js';
import type { ProjectConfig } from './types.js';

// -- FUNCTIONS -- //

describe('preview', () => {
	let home = '';
	let repo = '';
	let before: string | undefined;
	const servers: Server[] = [];
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-prev-home-'));
		process.env.AFB_BRIDGE_HOME = home;
		repo = mkdtempSync(join(tmpdir(), 'afb-prev-repo-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
		writeFileSync(join(repo, 'package.json'), '{"name":"fixture","private":true}');
		writeFileSync(
			join(repo, 'server.js'),
			"require('http').createServer((q, s) => s.end(process.env.ORIGIN + '|' + (process.env.DATABASE_URL ?? 'none'))).listen(Number(process.argv[2]), '127.0.0.1');"
		);
		writeFileSync(join(repo, '.gitignore'), 'ignored.txt\nnode_modules\n');
		writeFileSync(join(repo, 'ignored.txt'), 'no');
		writeFileSync(
			join(repo, '.env'),
			'DATABASE_URL=postgres://u:pw12345678@db.example.com/x\nPUBLIC_NAME=fixture\n'
		);
		mkdirSync(join(repo, 'src'));
		writeFileSync(join(repo, 'src', 'a.txt'), 'a');
		execFileSync('git', ['add', '-A'], { cwd: repo });
	});
	afterEach(async () => {
		for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const listen = (handler: Parameters<typeof createServer>[1]) =>
		new Promise<{ server: Server; port: number }>((resolve) => {
			const server = createServer(handler);
			servers.push(server);
			server.listen(0, '127.0.0.1', () =>
				resolve({ server, port: (server.address() as { port: number }).port })
			);
		});

	it('copies tracked and untracked files, without .git, env files, ignored files or node_modules', async () => {
		writeFileSync(join(repo, 'untracked.txt'), 'u');
		const dest = join(home, 'copy');
		const r = await makePrivateCopy(repo, dest);
		expect(r.skipped).toBe(1);
		expect(existsSync(join(dest, 'src', 'a.txt'))).toBe(true);
		expect(existsSync(join(dest, 'untracked.txt'))).toBe(true);
		expect(existsSync(join(dest, 'server.js'))).toBe(true);
		expect(existsSync(join(dest, '.git'))).toBe(false);
		expect(existsSync(join(dest, '.env'))).toBe(false);
		expect(existsSync(join(dest, 'ignored.txt'))).toBe(false);
	});

	it('refuses a link inside the repo by name', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'afb-prev-out-'));
		writeFileSync(join(outside, 'x.txt'), 'x');
		try {
			symlinkSync(outside, join(repo, 'linked'), 'junction');
		} catch {
			rmSync(outside, { recursive: true, force: true });
			return; // This machine does not allow links for this user
		}
		try {
			await expect(makePrivateCopy(repo, join(home, 'copy'))).rejects.toThrow(/linked/);
		} finally {
			rmSync(join(repo, 'linked'), { recursive: false, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('copies a folder that is not a git repo, without its env files', async () => {
		const plain = mkdtempSync(join(tmpdir(), 'afb-prev-plain-'));
		try {
			writeFileSync(join(plain, 'a.txt'), 'a');
			writeFileSync(join(plain, '.env'), 'X=1');
			const r = await makePrivateCopy(plain, join(home, 'c2'));
			expect(r.mode).toBe('plain');
			expect(existsSync(join(home, 'c2', 'a.txt'))).toBe(true);
			expect(existsSync(join(home, 'c2', '.env'))).toBe(false);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it('picks a free port that is not forbidden', async () => {
		for (let i = 0; i < 5; i++) {
			const p = await pickPort();
			expect(p).toBeGreaterThan(1023);
			expect(FORBIDDEN_PORTS.has(p)).toBe(false);
		}
	});

	it('waits until the server answers below 500, and gives up early when the process is gone', async () => {
		let n = 0;
		const { port } = await listen((_q, s) => {
			s.statusCode = n++ < 2 ? 503 : 404;
			s.end();
		});
		expect(
			await waitReady(`http://127.0.0.1:${port}/`, {
				timeoutMs: 5_000,
				exited: () => false,
				intervalMs: 20
			})
		).toBe('ready');
		expect(await waitReady('http://127.0.0.1:1/', { timeoutMs: 5_000, exited: () => true })).toBe(
			'exited'
		);
		expect(
			await waitReady('http://127.0.0.1:1/', {
				timeoutMs: 200,
				exited: () => false,
				intervalMs: 20
			})
		).toBe('timeout');
	});

	it('hides every secret in the tail of a log', () => {
		const f = join(home, 'out.log');
		writeFileSync(f, Array.from({ length: 30 }, (_, i) => `line ${i} secretvalue1`).join('\n'));
		const t = tailOf(f, ['secretvalue1']);
		expect(t.split('\n')).toHaveLength(20);
		expect(t).not.toContain('secretvalue1');
	});

	it('runs a whole preview from a fixture repo with its own env, and cleans up on close', async () => {
		const cfg: ProjectConfig = {
			repo,
			start: 'node server.js {port}',
			needsDatabase: false,
			env: {},
			appPaths: []
		};
		const scope = new RunScope('rprev1');
		const logs: string[] = [];
		try {
			const p = await startPreview(cfg, { runId: 'rprev1', scope, log: (s) => logs.push(s) });
			expect(p.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			expect(FORBIDDEN_PORTS.has(Number(new URL(p.baseUrl).port))).toBe(false);
			expect(p.commit).toBeNull();
			expect(p.diffHash).toMatch(/^[0-9a-f]{64}$/);
			const body = await (await fetch(p.baseUrl)).text();
			// The app got its own address, and the DATABASE_URL of the .env was stripped
			expect(body).toBe(`${p.baseUrl}|none`);
			expect(p.note).toContain('DATABASE_URL');
			expect(p.note).not.toContain('pw12345678');
			expect(readFileSync(join(home, 'checks', 'markers', 'rprev1.json'), 'utf8')).toContain(
				'previewPid'
			);
			expect(existsSync(join(copiesDir(), 'rprev1', 'server.js'))).toBe(true);
		} finally {
			await scope.close();
		}
		expect(existsSync(join(copiesDir(), 'rprev1'))).toBe(false);
		expect(existsSync(join(home, 'checks', 'markers', 'rprev1.json'))).toBe(false);
	}, 60_000);

	it('two runs of one folder at once each get their own copy and port, and closing one leaves the other up', async () => {
		const cfg: ProjectConfig = {
			repo,
			start: 'node server.js {port}',
			needsDatabase: false,
			env: {},
			appPaths: []
		};
		const a = new RunScope('rpar1');
		const b = new RunScope('rpar2');
		try {
			const [pa, pb] = await Promise.all([
				startPreview(cfg, { runId: 'rpar1', scope: a, log: () => undefined }),
				startPreview(cfg, { runId: 'rpar2', scope: b, log: () => undefined })
			]);
			expect(pa.baseUrl).not.toBe(pb.baseUrl);
			expect(existsSync(join(copiesDir(), 'rpar1', 'server.js'))).toBe(true);
			expect(existsSync(join(copiesDir(), 'rpar2', 'server.js'))).toBe(true);
			expect((await fetch(pa.baseUrl)).ok).toBe(true);
			expect((await fetch(pb.baseUrl)).ok).toBe(true);
			// Closing the first run takes only its own copy, marker and preview
			await a.close();
			expect(existsSync(join(copiesDir(), 'rpar1'))).toBe(false);
			expect(existsSync(join(copiesDir(), 'rpar2', 'server.js'))).toBe(true);
			expect((await fetch(pb.baseUrl)).ok).toBe(true);
		} finally {
			await a.close();
			await b.close();
		}
		expect(existsSync(join(copiesDir(), 'rpar2'))).toBe(false);
	}, 90_000);

	// -- APP FOLDERS, LIVE SITES -- //

	const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
	const SERVER =
		"require('http').createServer((q, s) => s.end(require('path').basename(process.cwd()) + '|' + process.env.ORIGIN)).listen(Number(process.argv[2]), '127.0.0.1');";
	/** A committed repo with the app in web/ and another app in landing/, and no package.json at the git root. */
	function appRepo(): string {
		const root = mkdtempSync(join(tmpdir(), 'afb-prev-apps-'));
		execFileSync('git', ['init', '-q'], { cwd: root });
		for (const app of ['web', 'landing']) {
			mkdirSync(join(root, app));
			writeFileSync(join(root, app, 'package.json'), `{"name":"${app}","private":true}`);
		}
		writeFileSync(join(root, 'web', 'server.js'), SERVER);
		writeFileSync(join(root, 'landing', 'server.js'), SERVER);
		execFileSync('git', [...GIT, 'add', '-A'], { cwd: root });
		execFileSync('git', [...GIT, 'commit', '-q', '-m', 'apps'], { cwd: root });
		return root;
	}

	it('builds the copy from the git root and runs the start command in the app folder', async () => {
		const root = appRepo();
		const scopes: RunScope[] = [];
		try {
			for (const app of ['web', 'landing']) {
				const scope = new RunScope(`rapp-${app}`);
				scopes.push(scope);
				const cfg: ProjectConfig = {
					repo: root,
					appDir: app,
					start: 'node server.js {port}',
					needsDatabase: false,
					env: {},
					appPaths: []
				};
				const p = await startPreview(cfg, { runId: `rapp-${app}`, scope, log: () => {} });
				expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
				expect(await (await fetch(p.baseUrl)).text()).toBe(`${app}|${p.baseUrl}`);
				// The copy holds the whole repo, so a sibling app folder is there too
				expect(existsSync(join(copiesDir(), `rapp-${app}`, 'landing', 'server.js'))).toBe(true);
				expect(existsSync(join(copiesDir(), `rapp-${app}`, 'web', 'server.js'))).toBe(true);
			}
		} finally {
			for (const s of scopes) await s.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);

	it('refuses an app folder that is a link, is missing, or has no package.json', async () => {
		const root = appRepo();
		const outside = mkdtempSync(join(tmpdir(), 'afb-prev-out-'));
		const run = (appDir: string, id: string) =>
			startPreview(
				{
					repo: root,
					appDir,
					start: 'node server.js {port}',
					needsDatabase: false,
					env: {},
					appPaths: []
				},
				{ runId: id, scope: new RunScope(id), log: () => {} }
			);
		try {
			await expect(run('nope', 'rbad1')).rejects.toThrow(/not in the repo/);
			await expect(run('../web', 'rbad2')).rejects.toThrow(/\.\./);
			mkdirSync(join(root, 'bare'));
			await expect(run('bare', 'rbad3')).rejects.toThrow(/no package\.json/);
			try {
				symlinkSync(outside, join(root, 'linkapp'), 'junction');
				await expect(run('linkapp', 'rbad4')).rejects.toThrow(/link/);
				rmSync(join(root, 'linkapp'), { force: true });
			} catch (e) {
				if (!/link/.test(String(e))) return; // This machine does not allow links for this user
				throw e;
			}
			// Nothing was left behind by a refused run
			expect(existsSync(join(copiesDir(), 'rbad1'))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	}, 60_000);

	it('returns a live site at once: no copy, no build, no start, no commit', async () => {
		const scope = new RunScope('rlive1');
		const cfg: ProjectConfig = {
			repo: '',
			url: 'https://app.example.com/',
			start: 'pnpm preview',
			build: 'pnpm build',
			needsDatabase: true,
			env: {},
			appPaths: []
		};
		const p = await startPreview(cfg, { runId: 'rlive1', scope, log: () => {} });
		expect(p.baseUrl).toBe('https://app.example.com/');
		expect(p.commit).toBeNull();
		expect(p.diffHash).toBeNull();
		expect(p.note).toMatch(/unverified/);
		expect(existsSync(join(copiesDir(), 'rlive1'))).toBe(false);
		expect(existsSync(join(home, 'checks', 'runs', 'rlive1'))).toBe(false);
		await scope.close();
	});

	it('refuses a live site on this machine at a port a check never uses', async () => {
		const run = (url: string) =>
			startPreview(
				{ repo: '', url, start: 'x', needsDatabase: false, env: {}, appPaths: [] },
				{ runId: 'rlive2', scope: new RunScope('rlive2'), log: () => {} }
			);
		for (const url of [
			'http://127.0.0.1:5180/',
			'http://localhost:5190/',
			'http://[::1]:5433/',
			'http://0.0.0.0:5180/'
		])
			await expect(run(url), url).rejects.toThrow(/not one a check may use/);
		await expect(run('ftp://example.com/')).rejects.toThrow(/http/);
		await expect(run('not a url')).rejects.toThrow(/web address/);
		expect((await run('http://127.0.0.1:5999/')).baseUrl).toBe('http://127.0.0.1:5999/');
	});

	it('fails early with the last lines of the output when the app dies', async () => {
		writeFileSync(
			join(repo, 'dies.js'),
			"console.log('boom ' + process.env.PUBLIC_NAME); process.exit(1);"
		);
		execFileSync('git', ['add', '-A'], { cwd: repo });
		const cfg: ProjectConfig = {
			repo,
			start: 'node dies.js',
			needsDatabase: false,
			env: { PUBLIC_NAME: 'secretname-value' },
			appPaths: []
		};
		const scope = new RunScope('rprev2');
		try {
			await expect(startPreview(cfg, { runId: 'rprev2', scope, log: () => {} })).rejects.toThrow(
				/stopped before it answered[\s\S]*boom \[hidden\]/
			);
		} finally {
			await scope.close();
		}
	}, 60_000);

	// -- REDACTION, LOG PLACES, STOP SIGNALS, A MOVING TREE (S3 S5 C2 C7) -- //

	it('hides a secret in a log tail in every spelling: raw, url encoded, base64 and as a token', () => {
		const secret = 'p@ss word/12345';
		const f = join(home, 'spell.log');
		writeFileSync(
			f,
			[
				'raw ' + secret,
				'url ' + encodeURIComponent(secret),
				'b64 ' + Buffer.from(secret).toString('base64'),
				'tok afb_abcdefghijklmnopqrstuvwxyz'
			].join('\n')
		);
		const t = tailOf(f, [secret]);
		expect(t).not.toContain(secret);
		expect(t).not.toContain(encodeURIComponent(secret));
		expect(t).not.toContain(Buffer.from(secret).toString('base64'));
		expect(t).not.toContain('afb_abcdefghijklmnopqrstuvwxyz');
	});

	it('a preview that crashes printing a secret in other spellings never shows it in the failure (S5)', async () => {
		const secret = 'sUp3r secret/value+99';
		writeFileSync(
			join(repo, 'dies2.js'),
			"const v = process.env.APP_KEY; console.log('raw ' + v); console.log('b64 ' + Buffer.from(v).toString('base64')); console.log('url ' + encodeURIComponent(v)); process.exit(1);"
		);
		execFileSync('git', ['add', '-A'], { cwd: repo });
		const needles: string[] = [];
		const scope = new RunScope('rprev5');
		try {
			let message = '';
			try {
				await startPreview(
					{
						repo,
						start: 'node dies2.js',
						needsDatabase: false,
						env: { APP_KEY: secret },
						appPaths: []
					},
					{ runId: 'rprev5', scope, log: () => {}, needles }
				);
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).toMatch(/stopped before it answered/);
			for (const form of [
				secret,
				Buffer.from(secret).toString('base64'),
				encodeURIComponent(secret)
			])
				expect(message).not.toContain(form);
			// The caller's list holds the value, so a later failure can be redacted too
			expect(needles).toContain(secret);
		} finally {
			await scope.close();
		}
	}, 60_000);

	it('keeps the preview log out of the run folder and removes it with the scope (S3)', async () => {
		const scope = new RunScope('rprev6');
		try {
			await startPreview(
				{ repo, start: 'node server.js {port}', needsDatabase: false, env: {}, appPaths: [] },
				{ runId: 'rprev6', scope, log: () => {} }
			);
			expect(existsSync(join(logDirFor('rprev6'), 'preview.log'))).toBe(true);
			expect(existsSync(join(runsDir(), 'rprev6', 'preview.log'))).toBe(false);
			expect(existsSync(join(runsDir(), 'rprev6', 'build.log'))).toBe(false);
		} finally {
			await scope.close();
		}
		expect(existsSync(logDirFor('rprev6'))).toBe(false);
	}, 60_000);

	it('copies again when the tree changed while it was being copied, and tests what it hashed (C7)', async () => {
		const logs: string[] = [];
		const scope = new RunScope('rprev7');
		try {
			const p = await startPreview(
				{ repo, start: 'node server.js {port}', needsDatabase: false, env: {}, appPaths: [] },
				{
					runId: 'rprev7',
					scope,
					log: (l) => logs.push(l),
					afterCopy: (n) => {
						if (n === 1) writeFileSync(join(repo, 'late.txt'), 'saved during the copy');
					}
				}
			);
			expect(logs.join('\n')).toMatch(/changed while it was being copied/);
			expect(readFileSync(join(copiesDir(), 'rprev7', 'late.txt'), 'utf8')).toBe(
				'saved during the copy'
			);
			expect(p.diffHash).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			await scope.close();
		}
	}, 60_000);

	it('waitReady stops at once when the signal aborts (C2)', async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 150);
		const started = Date.now();
		expect(
			await waitReady('http://127.0.0.1:1/', {
				timeoutMs: 30_000,
				exited: () => false,
				intervalMs: 50,
				signal: ac.signal
			})
		).toBe('aborted');
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('a preview that never answers stops when the run is aborted, and the process is killed with the scope (C2)', async () => {
		writeFileSync(join(repo, 'hang.js'), 'setInterval(() => {}, 1000);');
		execFileSync('git', ['add', '-A'], { cwd: repo });
		const ac = new AbortController();
		const scope = new RunScope('rprev8');
		setTimeout(() => ac.abort(), 1500);
		let pid: number;
		try {
			await expect(
				startPreview(
					{ repo, start: 'node hang.js', needsDatabase: false, env: {}, appPaths: [] },
					{ runId: 'rprev8', scope, log: () => {}, signal: ac.signal }
				)
			).rejects.toThrow(/stopped/);
			const text = readFileSync(join(home, 'checks', 'markers', 'rprev8.json'), 'utf8');
			pid = Number(/"previewPid":(\d+)/.exec(text)?.[1]);
			expect(pid).toBeGreaterThan(1);
		} finally {
			await scope.close();
		}
		for (let i = 0; i < 30 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
		expect(pidAlive(pid)).toBe(false);
	}, 60_000);

	it('runToEnd registers its process on the scope, kills it on abort, and calls a timeout or a missing program an infrastructure failure (C2 C9)', async () => {
		const out = openSync(join(home, 'cmd.out'), 'a');
		const scope = new RunScope('rprev9');
		try {
			const ac = new AbortController();
			const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
			const running = runToEnd([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
				cwd: home,
				env,
				out,
				timeoutMs: 60_000,
				scope,
				name: 'install process',
				signal: ac.signal
			});
			await new Promise((r) => setTimeout(r, 400));
			ac.abort();
			expect(await running).toBe(-1);
			// A timeout is -1 as well
			expect(
				await runToEnd([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
					cwd: home,
					env,
					out,
					timeoutMs: 300,
					scope
				})
			).toBe(-1);
			// A program that does not exist cannot be started: the machine's trouble, so waiters may take over
			await expect(
				runToEnd(['afb-no-such-program-xyz'], { cwd: home, env, out, timeoutMs: 5_000, scope })
			).rejects.toBeInstanceOf(InfraError);
			// An already aborted run starts nothing
			await expect(
				runToEnd([process.execPath, '-e', '1'], {
					cwd: home,
					env,
					out,
					timeoutMs: 5_000,
					signal: ac.signal
				})
			).rejects.toBeInstanceOf(InfraError);
		} finally {
			await scope.close();
			closeSync(out);
		}
	}, 60_000);

	it('a builder whose command timed out hands the build to the next waiter, but a real build failure is shared (C9)', async () => {
		const out = openSync(join(home, 'flight.out'), 'a');
		const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
		const attempts: string[] = [];
		try {
			let first = true;
			const build = async (who: string) => {
				attempts.push(who);
				// The first builder's command is killed by its timeout (no exit code); the next one's command works
				const code = await runToEnd(
					first
						? [process.execPath, '-e', 'setInterval(() => {}, 1000)']
						: [process.execPath, '-e', '1'],
					{ cwd: home, env, out, timeoutMs: first ? 300 : 20_000 }
				);
				first = false;
				if (code !== 0) throw stageError('build', code, false, () => '');
				return { hit: false };
			};
			const results = await Promise.allSettled([
				singleFlight('c9-timeout', () => build('a'), { pollMs: 20 }),
				singleFlight('c9-timeout', () => build('b'), { pollMs: 20 })
			]);
			// One run failed with the infrastructure error, the other took over and built
			const failed = results.filter((r) => r.status === 'rejected');
			const built = results.filter((r) => r.status === 'fulfilled');
			expect(failed).toHaveLength(1);
			expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(InfraError);
			expect(built).toHaveLength(1);
			expect(attempts).toHaveLength(2);
			// A real failure (exit code 2) is shared: both runs get it, nobody builds a second time
			const calls: string[] = [];
			const broken = async (who: string) => {
				calls.push(who);
				await new Promise((r) => setTimeout(r, 200));
				throw stageError('build', 2, false, () => 'boom');
			};
			const shared = await Promise.allSettled([
				singleFlight('c9-real', () => broken('a'), { pollMs: 20 }),
				singleFlight('c9-real', () => broken('b'), { pollMs: 20 })
			]);
			expect(shared.every((r) => r.status === 'rejected')).toBe(true);
			expect(calls).toHaveLength(1);
			expect(stageError('build', 2, false, () => 'boom').message).toContain('exit 2');
			expect(stageError('install', -1, true, () => '').message).toBe('The run was stopped.');
		} finally {
			closeSync(out);
		}
	}, 30_000);
});
