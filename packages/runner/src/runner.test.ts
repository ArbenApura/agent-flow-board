// THE RUNNER PROGRAM'S OWN RULES: WHAT NEEDS THE OWNER'S YES, WHEN A BUILD IS REUSED, WHAT A FAILED BUILD REPORTS, THE DEPLOYED
// VERSION WAIT AND THE LOCKED DOWN CONTAINER OF A HOSTED RUN (SPEC 10, L1, L26, L27)

// -- DEP-MODULES -- //
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { Approvals, NeedsApproval } from './approvals';
import { loadConfig } from './config';
import { appHash, changedPaths, headCommit } from './git';
import { dockerArgs } from './supervisor';
import { Targets, TargetUnavailable } from './targets';

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
