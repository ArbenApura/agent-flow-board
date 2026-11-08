// THE PREVIEW OF ONE RUN: A PRIVATE COPY OF THE REPO, BUILT AND SERVED FROM ITS OWN FOLDER ON A FREE PORT, WITH AN ENVIRONMENT THE TOOL BUILT (envPolicy.ts).
// A run builds and serves from its own copy so it can never take down the preview a person is looking at, and two runs never share a folder. The copy is
// made from the files git lists (tracked, and untracked that are not ignored), never from .git; env files are not copied, they are read from the source repo.
// A dependency cache was left out on purpose: a fresh install per run is slower but cannot serve a stale module to a run.

// -- DEP-MODULES -- //
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
// -- MODULES -- //
import { buildPreviewEnv } from './envPolicy.js';
import { FORBIDDEN_PORTS } from './guardrails.js';
import { copiesDir, ensureDir, runsDir, under } from './paths.js';
import { freePort, makeThrowawayDatabase } from './provision.js';
import { type RunScope, killTree, removeTree } from './scope.js';
import type { Preview, ProjectConfig } from './types.js';

// -- TYPES -- //

export type PreviewOptions = { runId: string; scope: RunScope; log: (s: string) => void };
type GitResult = { status: number; stdout: Buffer };

// -- CONSTANTS -- //

/** A file bigger than this is not copied (a build output, a dump, a video). */
const MAX_COPY_BYTES = 5 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 120_000;
/** Env files are read from the source repo by envPolicy, never copied. An example file holds no secrets and is copied. */
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/i;
const ENV_EXAMPLE = /\.(example|sample|template)$/i;

// -- FUNCTIONS -- //

/** Runs git with an argument list and no shell. Resolves with the exit status; never throws. */
function git(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			'git',
			args,
			{
				cwd,
				windowsHide: true,
				encoding: 'buffer',
				maxBuffer: 256 * 1024 * 1024,
				timeout: 120_000
			},
			(err, stdout) => {
				const code = err
					? typeof (err as { code?: unknown }).code === 'number'
						? (err as { code: number }).code
						: -1
					: 0;
				resolve({ status: code, stdout: stdout as unknown as Buffer });
			}
		);
	});
}

/** The tracked and the untracked-not-ignored files of a repo, as paths relative to it. Null when the folder is not a git repo. */
async function listFiles(repo: string): Promise<string[] | null> {
	const r = await git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
	if (r.status !== 0) return null;
	return [...new Set(r.stdout.toString('utf8').split('\0').filter(Boolean))];
}

/**
 * Copies the listed files of `repo` into `dest`. A link anywhere in the repo's files (the file itself or a folder above it) is refused by name,
 * because a copy that follows a link could carry files from outside the repo into the build.
 */
export async function makePrivateCopy(
	repo: string,
	dest: string,
	log: (s: string) => void = () => {}
): Promise<{ files: number; skipped: number }> {
	const files = await listFiles(repo);
	if (!files)
		throw new Error(
			'The project folder is not a git repository, so the tool cannot tell which files belong to it.'
		);
	const checkedDirs = new Set<string>();
	let copied = 0;
	let skipped = 0;
	mkdirSync(dest, { recursive: true, mode: 0o700 });
	for (const rel of files) {
		const parts = rel.split('/');
		if (parts[0] === '.git' || parts.includes('..'))
			throw new Error(`The file "${rel.slice(0, 80)}" is not a file the tool copies.`);
		// Every folder above the file must be a real folder
		for (let i = 1; i < parts.length; i++) {
			const folder = parts.slice(0, i).join('/');
			if (checkedDirs.has(folder)) continue;
			let st;
			try {
				st = lstatSync(join(repo, folder));
			} catch {
				break;
			}
			if (st.isSymbolicLink())
				throw new Error(
					`"${folder.slice(0, 80)}" is a link. A check does not copy links; remove it or ignore it in git.`
				);
			checkedDirs.add(folder);
		}
		const from = join(repo, ...parts);
		let st;
		try {
			st = lstatSync(from);
		} catch {
			continue; // Listed by git but deleted in the working tree
		}
		if (st.isSymbolicLink())
			throw new Error(
				`"${rel.slice(0, 80)}" is a link. A check does not copy links; remove it or ignore it in git.`
			);
		if (!st.isFile()) continue;
		if ((ENV_FILE.test(rel) && !ENV_EXAMPLE.test(rel)) || st.size > MAX_COPY_BYTES) {
			skipped++;
			continue;
		}
		const to = under(dest, ...parts);
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		copyFileSync(from, to);
		copied++;
	}
	if (skipped) log(`${skipped} file(s) were not copied (env files and files over 5 MB).`);
	return { files: copied, skipped };
}

/** The commit of HEAD, or null when the folder has no commit. */
async function headCommit(repo: string): Promise<string | null> {
	const r = await git(repo, ['rev-parse', 'HEAD']);
	return r.status === 0 ? r.stdout.toString('utf8').trim() || null : null;
}

/** A hash over the uncommitted changes (`git diff HEAD`) and the contents of untracked files. Null when the folder is not a git repo. */
async function hashChanges(repo: string): Promise<string | null> {
	const files = await listFiles(repo);
	if (!files) return null;
	const h = createHash('sha256');
	const diff = await git(repo, ['diff', 'HEAD']);
	if (diff.status === 0) h.update(diff.stdout);
	const others = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
	for (const rel of others.stdout.toString('utf8').split('\0').filter(Boolean).sort()) {
		try {
			const full = join(repo, ...rel.split('/'));
			if (ENV_FILE.test(rel) || !lstatSync(full).isFile()) continue;
			h.update(`\0${rel}\0`);
			h.update(readFileSync(full));
		} catch {
			/* A file that vanished while hashing */
		}
	}
	return h.digest('hex');
}

/**
 * Starts a program from an argument list with no shell. On Windows the package managers are .cmd shims, which a plain spawn cannot find (ENOENT) and
 * Node refuses to start directly; only then is the shim run through `cmd.exe /d /s /c`. The arguments came from a command that was already checked
 * (words, flags and a port, no metacharacters), so they are not interpreted by cmd.exe. Resolves once the process exists.
 */
export function launch(
	argv: string[],
	opts: { cwd: string; env: Record<string, string>; out: number; detached: boolean }
): Promise<ChildProcess> {
	const [file, ...args] = argv;
	if (!file) return Promise.reject(new Error('The command is empty.'));
	const base = {
		cwd: opts.cwd,
		env: opts.env,
		stdio: ['ignore', opts.out, opts.out] as ['ignore', number, number],
		windowsHide: true,
		shell: false,
		detached: opts.detached
	};
	const attempt = (f: string, a: string[]) =>
		new Promise<ChildProcess>((resolve, reject) => {
			const child = spawn(f, a, base);
			child.once('error', reject);
			child.once('spawn', () => {
				child.off('error', reject);
				resolve(child);
			});
		});
	return attempt(file, args).catch((e: NodeJS.ErrnoException) => {
		if (e.code === 'ENOENT' && process.platform === 'win32' && /^(yarn|npm|pnpm|npx)$/.test(file))
			return attempt('cmd.exe', ['/d', '/s', '/c', `${file}.cmd`, ...args]);
		throw e;
	});
}

/** Runs a command to its end and resolves with its exit code (or -1 when it timed out). The output goes to the open file `out`. */
async function runToEnd(
	argv: string[],
	opts: { cwd: string; env: Record<string, string>; out: number; timeoutMs: number }
): Promise<number> {
	const child = await launch(argv, { ...opts, detached: false });
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (child.pid) void killTree(child.pid).then(() => resolve(-1));
			else resolve(-1);
		}, opts.timeoutMs);
		child.once('exit', (code) => {
			clearTimeout(timer);
			resolve(code ?? -1);
		});
	});
}

const words = (command: string) => command.split(' ').filter(Boolean);

/** The install command for the copy, from the lock file it holds, or null when there is no lock file (a frozen install needs one). */
export function installCommand(dir: string): string[] | null {
	if (!existsSync(join(dir, 'package.json'))) return null;
	if (existsSync(join(dir, 'yarn.lock'))) return ['yarn', 'install', '--immutable'];
	if (existsSync(join(dir, 'pnpm-lock.yaml'))) return ['pnpm', 'install', '--frozen-lockfile'];
	if (existsSync(join(dir, 'package-lock.json'))) return ['npm', 'ci'];
	return null;
}

/** The last lines of a log file with every value of the preview environment hidden. */
export function tailOf(file: string, secrets: string[], lines = 20): string {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return '';
	}
	let out = text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
	for (const s of [...secrets].sort((a, b) => b.length - a.length))
		if (s.length >= 4) out = out.split(s).join('[hidden]');
	return out;
}

/** Waits until GET url answers with a status below 500. Gives up after `timeoutMs`, or at once when `exited` says the process is gone. */
export async function waitReady(
	url: string,
	opts: { timeoutMs: number; exited: () => boolean; intervalMs?: number }
): Promise<'ready' | 'exited' | 'timeout'> {
	const until = Date.now() + opts.timeoutMs;
	while (Date.now() < until) {
		if (opts.exited()) return 'exited';
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
			await res.body?.cancel();
			if (res.status < 500) return 'ready';
		} catch {
			/* Not listening yet */
		}
		await new Promise((r) => setTimeout(r, opts.intervalMs ?? 500));
	}
	return opts.exited() ? 'exited' : 'timeout';
}

/** Picks a free port on 127.0.0.1 and refuses a forbidden one. */
export async function pickPort(): Promise<number> {
	const port = await freePort();
	if (FORBIDDEN_PORTS.has(port)) throw new Error(`Port ${port} is not one a check may use.`);
	return port;
}

export async function startPreview(cfg: ProjectConfig, opts: PreviewOptions): Promise<Preview> {
	const { runId, scope, log } = opts;
	// -- 1. THE MARKER COMES FIRST -- //
	scope.start();
	const runDir = ensureDir(under(runsDir(), runId));
	const notes: string[] = [];
	const secrets: string[] = [];
	// -- 2. A PRIVATE COPY -- //
	const copyDir = under(copiesDir(), runId);
	scope.setInfo({ copyDir });
	scope.add('private copy', () => removeTree(copyDir));
	const made = await makePrivateCopy(cfg.repo, copyDir, log);
	log(`Made a private copy of ${made.files} file(s).`);
	// -- 3. WHAT WAS TESTED -- //
	const commit = await headCommit(cfg.repo);
	const diffHash = await hashChanges(cfg.repo);
	// -- 4. A FREE PORT -- //
	const port = await pickPort();
	const baseUrl = `http://127.0.0.1:${port}`;
	// -- 5. A THROWAWAY DATABASE, ONLY WHEN THE APP NEEDS ONE -- //
	let databaseUrl: string | undefined;
	let ownerUrl: string | undefined;
	if (cfg.needsDatabase) {
		const db = await makeThrowawayDatabase(runId, scope, log, { runtimeRole: cfg.runtimeRole });
		databaseUrl = db.databaseUrl;
		ownerUrl = db.ownerUrl;
		secrets.push(db.databaseUrl, db.ownerUrl);
		notes.push('A throwaway database was made for this run.');
	}
	// -- ENVIRONMENT -- //
	const built = buildPreviewEnv({
		repo: cfg.repo,
		recipeEnv: cfg.env,
		port,
		baseUrl,
		databaseUrl,
		databaseOwnerUrl: ownerUrl
	});
	notes.push(...built.notes);
	const redact = Object.values(built.env).filter((v) => v.length >= 8);
	if (cfg.testUser) secrets.push(cfg.testUser.password);
	// -- 6. INSTALL AND BUILD -- //
	const buildLog = openSync(join(runDir, 'build.log'), 'a');
	try {
		const install = installCommand(copyDir);
		if (install) {
			log('Installing dependencies in the private copy.');
			const code = await runToEnd(install, {
				cwd: copyDir,
				env: built.env,
				out: buildLog,
				timeoutMs: BUILD_TIMEOUT_MS
			});
			if (code !== 0)
				throw new Error(
					`The install failed (exit ${code}). Last lines:\n${tailOf(join(runDir, 'build.log'), redact)}`
				);
		}
		if (cfg.build) {
			log('Building the project.');
			const code = await runToEnd(words(cfg.build), {
				cwd: copyDir,
				env: built.env,
				out: buildLog,
				timeoutMs: BUILD_TIMEOUT_MS
			});
			if (code !== 0)
				throw new Error(
					`The build failed (exit ${code}). Last lines:\n${tailOf(join(runDir, 'build.log'), redact)}`
				);
		}
	} finally {
		closeSync(buildLog);
	}
	// -- 7. START -- //
	const startLog = openSync(join(runDir, 'preview.log'), 'a');
	let child: ChildProcess;
	try {
		child = await launch(words(cfg.start.split('{port}').join(String(port))), {
			cwd: copyDir,
			env: built.env,
			out: startLog,
			detached: process.platform !== 'win32'
		});
	} finally {
		closeSync(startLog);
	}
	let exited = false;
	child.once('exit', () => (exited = true));
	if (child.pid) {
		const pid = child.pid;
		scope.setInfo({ previewPid: pid });
		scope.add('preview process', () => killTree(pid));
	}
	// -- 8. WAIT UNTIL IT ANSWERS -- //
	const readyUrl = baseUrl + (cfg.ready ?? '/');
	const state = await waitReady(readyUrl, { timeoutMs: READY_TIMEOUT_MS, exited: () => exited });
	if (state !== 'ready') {
		const why =
			state === 'exited'
				? 'The preview stopped before it answered.'
				: 'The preview did not answer within 120 seconds.';
		throw new Error(`${why} Last lines:\n${tailOf(join(runDir, 'preview.log'), redact)}`);
	}
	log('The preview answers.');
	// -- 9. RESULT -- //
	return {
		baseUrl,
		commit,
		diffHash,
		testUser: cfg.testUser ?? null,
		secrets,
		note: notes.join(' ')
	};
}
