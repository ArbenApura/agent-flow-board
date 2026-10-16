// THE THREE TARGETS A RUN CAN USE: THE DEV SERVER, THE BUILD PREVIEW AND THE DEPLOYED SITE (SPEC 10, ADR-017)
// The build preview is the default: built from the working tree, reused while the commit and the uncommitted changes are the
// same, served from a process this runner starts and stops. The dev server is only ever chosen by hand and is warmed first. The
// deployed site is opened as it is, after an optional wait until it reports the commit being tested.

// -- DEP-MODULES -- //
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
// -- MODULES -- //
import type { Approvals } from './approvals';
import type { RunnerConfig, Served } from './config';
import { appHash, headCommit } from './git';

// -- TYPES -- //

export type Prepared = {
	baseUrl: string;
	commit: string | null;
	diffHash: string | null;
	/** Something the report should say: a version the site showed, a build that was reused. */
	note?: string;
	/** True when nothing proves the code under test is this working tree. A pass on it closes nothing. */
	unverified?: boolean;
};

/** A target that cannot be used. The message says why, in words for the person who asked. */
export class TargetUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TargetUnavailable';
	}
}

type Running = { child: ChildProcess; hash: string; tail: () => string };

// -- FUNCTIONS -- //

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The environment a child process gets: this process's, without the runner's own token or any server secret. */
function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra };
	for (const k of Object.keys(env))
		if (
			/^(AFB_RUNNER_|AFB_MASTER_|AFB_REPO_|BETTER_AUTH_SECRET|DATABASE_|BACKUP_)/.test(k) &&
			!(extra && k in extra)
		)
			delete env[k];
	return env;
}

function killTree(child: ChildProcess) {
	if (!child.pid || child.exitCode !== null) return;
	if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
	else {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
	}
}

async function answers(url: string, path = '/'): Promise<boolean> {
	try {
		const res = await fetch(new URL(path, url), {
			signal: AbortSignal.timeout(2500),
			redirect: 'manual'
		});
		return res.status < 500;
	} catch {
		return false;
	}
}

/**
 * The text the owner approves for a command: the command, the folder it runs in and the settings it runs with. A change to
 * any of them asks again, because NODE_OPTIONS or PATH can make the same command run other code.
 */
function approvedText(served: Served, command: string): string {
	const env = Object.entries(served.env ?? {})
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`);
	const lines = [command, `cwd: ${served.cwd ?? '(the project folder)'}`];
	if (env.length) lines.push('env:', ...env);
	return lines.join('\n');
}

export class Targets {
	private running = new Map<string, Running>();
	private lastBuild = new Map<string, string>();

	constructor(
		private readonly repo: string,
		private readonly config: RunnerConfig,
		private readonly approvals: Approvals,
		private readonly log: (line: string) => void
	) {}

	/** Gets the target ready and says where it is and what code it holds. */
	async prepare(opts: {
		project: string;
		target: 'dev' | 'preview' | 'deployed';
		url: string;
		versionPath: string | null;
	}): Promise<Prepared> {
		if (opts.target === 'deployed') return this.deployed(opts.url, opts.versionPath);
		const served = this.config[opts.target];
		const hash = appHash(this.repo, this.config.appPaths);
		const commit = headCommit(this.repo);
		const key = `${opts.project}:${opts.target}`;
		const ready = served?.ready ?? '/';
		const mine = this.running.get(key);
		if (
			mine &&
			mine.child.exitCode === null &&
			mine.hash === hash &&
			(await answers(opts.url, ready))
		)
			return {
				baseUrl: opts.url,
				commit,
				diffHash: hash,
				note: 'The build from the last run was reused.'
			};
		if (mine) {
			killTree(mine.child);
			this.running.delete(key);
		}
		if (!served?.start) {
			// Nothing to start: use a server that is already answering, if one is
			if (await answers(opts.url, ready))
				return {
					baseUrl: opts.url,
					commit,
					diffHash: hash,
					note: 'Used the server that was already running, which may not hold this code.',
					unverified: this.config.trustRunning ? undefined : true
				};
			throw new TargetUnavailable(
				`The ${opts.target} target is not running at ${opts.url}, and ${'afb.runner.json'} has no "${opts.target}.start" command to start it.`
			);
		}
		if (served.reuseRunning && (await answers(opts.url, ready)))
			return {
				baseUrl: opts.url,
				commit,
				diffHash: hash,
				note: 'Used the server that was already running, which may not hold this code.',
				unverified: this.config.trustRunning ? undefined : true
			};
		if (served.build && this.lastBuild.get(key) !== hash) {
			this.approvals.require(
				opts.project,
				'command',
				`${opts.target} build`,
				approvedText(served, served.build)
			);
			await this.build(served, served.build);
			this.lastBuild.set(key, hash);
		}
		this.approvals.require(
			opts.project,
			'command',
			`${opts.target} start`,
			approvedText(served, served.start)
		);
		await this.start(key, served, opts.url, hash);
		for (const w of served.warm ?? (opts.target === 'dev' ? ['/'] : [])) await answers(opts.url, w);
		return { baseUrl: opts.url, commit, diffHash: hash };
	}

	private async build(served: Served, command: string) {
		this.log(`Building: ${command}`);
		const out: string[] = [];
		const child = spawn(command, {
			cwd: served.cwd ?? this.repo,
			shell: true,
			env: childEnv(served.env),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		child.stdout?.on('data', (d) => out.push(String(d)));
		child.stderr?.on('data', (d) => out.push(String(d)));
		const code: number = await new Promise((res) => child.on('close', (c) => res(c ?? 1)));
		if (code !== 0)
			throw new TargetUnavailable(
				`The build failed (exit ${code}). The end of its log:\n${out.join('').slice(-1500)}`
			);
	}

	private async start(key: string, served: Served, url: string, hash: string) {
		this.log(`Starting: ${served.start}`);
		const out: string[] = [];
		const child = spawn(served.start!, {
			cwd: served.cwd ?? this.repo,
			shell: true,
			env: childEnv(served.env),
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32'
		});
		child.stdout?.on('data', (d) => out.push(String(d)));
		child.stderr?.on('data', (d) => out.push(String(d)));
		const tail = () => out.join('').slice(-1500);
		this.running.set(key, { child, hash, tail });
		const deadline = Date.now() + 240_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				this.running.delete(key);
				throw new TargetUnavailable(
					`The server stopped while starting (exit ${child.exitCode}). The end of its log:\n${tail()}`
				);
			}
			if (await answers(url, served.ready ?? '/')) return;
			await sleep(500);
		}
		killTree(child);
		this.running.delete(key);
		throw new TargetUnavailable(
			`The server did not answer at ${url} within 4 minutes. The end of its log:\n${tail()}`
		);
	}

	/** The deployed site: waits until it reports this commit when it can say which one it runs (L27), and says so when it cannot. */
	private async deployed(url: string, versionPath: string | null): Promise<Prepared> {
		const head = headCommit(this.repo);
		if (!versionPath)
			return {
				baseUrl: url,
				commit: null,
				diffHash: null,
				// The site has no version address (SPEC 10, L27): the run says so and counts, as the plan allows
				note: 'The deployed site does not say which commit it runs, so this run cannot be tied to one.'
			};
		const deadline = Date.now() + this.config.deployed.waitMinutes * 60_000;
		let seen: string | null = null;
		for (;;) {
			try {
				const res = await fetch(new URL(versionPath, url), { signal: AbortSignal.timeout(4000) });
				const text = await res.text();
				let v = text.trim();
				try {
					const j = JSON.parse(text) as Record<string, unknown>;
					v = String(j.commit ?? j.sha ?? j.revision ?? j.version ?? text).trim();
				} catch {
					/* Plain text */
				}
				seen = v.slice(0, 80);
				// A version counts only when it is a commit hash of at least 7 characters that starts the same way as this tree's
				const hex = /^[0-9a-f]{7,40}$/i.test(seen);
				if (!head) return { baseUrl: url, commit: seen || null, diffHash: null, unverified: true };
				if (
					hex &&
					(head.startsWith(seen.toLowerCase()) || seen.toLowerCase().startsWith(head.slice(0, 7)))
				)
					return { baseUrl: url, commit: seen, diffHash: null };
			} catch {
				/* Not reachable yet */
			}
			if (Date.now() > deadline) break;
			await sleep(5000);
		}
		return {
			baseUrl: url,
			commit: seen,
			diffHash: null,
			note: `The deployed site reports ${seen ?? 'no version'}, not ${head?.slice(0, 7) ?? 'a known commit'}, so the run used what was live.`,
			unverified: true
		};
	}

	/** Stops every server this runner started. */
	stopAll() {
		for (const r of this.running.values()) killTree(r.child);
		this.running.clear();
	}
}
