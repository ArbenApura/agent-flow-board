// THE PREVIEW: THE PRIVATE COPY, THE PORT PICK, THE READY WAIT AND A WHOLE RUN OF A SMALL NODE APP FROM A FIXTURE REPO (NO BUILD TOOL NEEDED)

// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { FORBIDDEN_PORTS } from './guardrails.js';
import { copiesDir } from './paths.js';
import {
	installCommand,
	makePrivateCopy,
	pickPort,
	startPreview,
	tailOf,
	waitReady
} from './preview.js';
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

	it('refuses a folder that is not a git repo', async () => {
		const plain = mkdtempSync(join(tmpdir(), 'afb-prev-plain-'));
		try {
			await expect(makePrivateCopy(plain, join(home, 'c2'))).rejects.toThrow(
				/not a git repository/
			);
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

	it('picks the install command from the lock file', () => {
		expect(installCommand(repo)).toBeNull();
		writeFileSync(join(repo, 'yarn.lock'), '');
		expect(installCommand(repo)).toEqual(['yarn', 'install', '--immutable']);
		rmSync(join(repo, 'yarn.lock'));
		writeFileSync(join(repo, 'package-lock.json'), '{}');
		expect(installCommand(repo)).toEqual(['npm', 'ci']);
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
			expect(readFileSync(join(home, 'checks', 'runs', 'rprev1', 'ACTIVE'), 'utf8')).toContain(
				'previewPid'
			);
			expect(existsSync(join(copiesDir(), 'rprev1', 'server.js'))).toBe(true);
		} finally {
			await scope.close();
		}
		expect(existsSync(join(copiesDir(), 'rprev1'))).toBe(false);
		expect(existsSync(join(home, 'checks', 'runs', 'rprev1', 'ACTIVE'))).toBe(false);
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
});
