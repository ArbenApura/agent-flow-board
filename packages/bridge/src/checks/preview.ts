// THE PREVIEW OF ONE RUN: A PRIVATE COPY OF THE REPO, BUILT AND SERVED FROM ITS OWN FOLDER ON A FREE PORT, WITH AN ENVIRONMENT THE TOOL BUILT (envPolicy.ts).
// A run builds and serves from its own copy so it can never take down the preview a person is looking at, and two runs never share a folder. The copy
// is a local clone of the git root at HEAD plus the working-tree changes (copy.ts); env files are not copied, they are read from the source repo.
// With an app folder the copy is still made from the git root, but install, build and start run in the app folder of the copy. A live site (cfg.url)
// builds and starts nothing: the run is unverified. A dependency cache is not made here: a fresh install per run cannot serve a stale module.

// -- DEP-MODULES -- //
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { appDirProblem, sandboxAppRoot } from './appdir.js';
import { git, listFiles, makePrivateCopy } from './copy.js';
import { buildAdoptedEnv, buildPreviewEnv } from './envPolicy.js';
import { describeFence, fenceProblem, readFence, withMailGuard } from './mailguard.js';
import { omitKeys, resolveSealedEnv } from './secrets.js';
import { FORBIDDEN_PORTS } from './guardrails.js';
import {
	KEEP_BUILDS,
	KEEP_DEPS,
	buildKey,
	depsKey,
	evict,
	hasEntry,
	publishBuildAsync,
	publishDepsAsync,
	restoreBuildAsync,
	restoreDepsAsync,
	restoreOrNull,
	snapshotAsync,
	treeId
} from './cache.js';
import {
	installCacheable,
	installCommand,
	installDirFor,
	lockHash,
	packageManagerOf,
	packageManagerVersion,
	pathOf,
	programArgv
} from './install.js';
import { cacheDirFor, copiesDir, ensureDir, logDirFor, runsDir, under } from './paths.js';
import { pinFiles } from './recipe.js';
import { redact as redactText } from './redact.js';
import { InfraError, singleFlight } from './singleflight.js';
import { provisionDatabase } from './dbpool.js';
import { freePort } from './provision.js';
import { type RunScope, killTree, removeTree } from './scope.js';
import type { Preview, ProjectConfig } from './types.js';

// -- TYPES -- //

export type PreviewOptions = {
	runId: string;
	scope: RunScope;
	log: (s: string) => void;
	/** Aborts the preview: the child processes of the install, the build and the start are killed and the call throws. */
	signal?: AbortSignal;
	/**
	 * A list the caller owns. Every value the run must never print (the throwaway database address, sealed and adopted values, the values of the start
	 * environment) is added to it as soon as it is known, so a failure that happens later in this call or after it can be redacted by the caller.
	 */
	needles?: string[];
	/** A test seam: runs inside each private copy, after the copy is made. */
	afterCopy?: (attempt: number) => void | Promise<void>;
};

// -- CONSTANTS -- //

const BUILD_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 120_000;
/** Env files are never part of what is hashed. */
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/i;
/** Host names that mean this machine. */
const LOOPBACK = new Set([
	'localhost',
	'127.0.0.1',
	'::1',
	'[::1]',
	'0.0.0.0',
	'host.docker.internal'
]);

// -- FUNCTIONS -- //

/** A hash over the uncommitted changes (`git diff HEAD`) and the contents of untracked files. Null when the folder is not a git repo. */
async function hashChanges(repo: string): Promise<string | null> {
	if (!(await listFiles(repo))) return null;
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
 * Node refuses to start directly; those go through `cmd.exe /d /s /c` (install.ts programArgv). The arguments came from a command that was already
 * checked (words, flags and a port, no metacharacters), so they are not interpreted by cmd.exe. Resolves once the process exists.
 */
export function launch(
	argv: string[],
	opts: { cwd: string; env: Record<string, string>; out: number; detached: boolean }
): Promise<ChildProcess> {
	const [file, ...args] = programArgv(argv, { pathEnv: pathOf(opts.env) });
	if (!file) return Promise.reject(new Error('The command is empty.'));
	return new Promise<ChildProcess>((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ['ignore', opts.out, opts.out] as ['ignore', number, number],
			windowsHide: true,
			shell: false,
			detached: opts.detached
		});
		child.once('error', reject);
		child.once('spawn', () => {
			child.off('error', reject);
			resolve(child);
		});
	});
}

/** The message of a stopped run. */
const STOPPED = 'The run was stopped.';

/**
 * The error of an install or build command that ended without success. No exit code at all (-1: it timed out, was killed or was stopped) is the machine's trouble and
 * not the code's, so it is an InfraError: a run that waited for this one takes over instead of being handed the same failure. A real exit code is the code's failure
 * and is shared with every waiter, with the last lines of the log.
 */
export function stageError(
	what: string,
	code: number,
	aborted: boolean,
	tail: () => string
): Error {
	if (code === -1)
		return new InfraError(aborted ? STOPPED : `The ${what} timed out or was stopped.`);
	return new Error(`The ${what} failed (exit ${code}). Last lines:\n${tail()}`);
}

/**
 * Runs a command to its end and resolves with its exit code (or -1 when it timed out or was killed). The output goes to the open file `out`.
 * The process is registered on the scope while it runs, so a stop signal or a crash of the run cannot leave it (or the cmd.exe and node under it) behind;
 * an abort kills its whole tree at once. A command that cannot be started at all (no such program, no disk, no handles) is an InfraError.
 */
export async function runToEnd(
	argv: string[],
	opts: {
		cwd: string;
		env: Record<string, string>;
		out: number;
		timeoutMs: number;
		scope?: RunScope;
		name?: string;
		signal?: AbortSignal;
	}
): Promise<number> {
	if (opts.signal?.aborted) throw new InfraError(STOPPED);
	let child: ChildProcess;
	try {
		child = await launch(argv, { ...opts, detached: false });
	} catch (e) {
		throw new InfraError(
			`The command could not be started: ${(e as NodeJS.ErrnoException).code ?? 'an error'}.`,
			{ cause: e }
		);
	}
	let gone = false;
	const pid = child.pid;
	if (pid) opts.scope?.add(opts.name ?? 'build process', () => (gone ? undefined : killTree(pid)));
	return new Promise((resolve) => {
		const finish = (code: number) => {
			gone = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			resolve(code);
		};
		// A process the tool killed (a timeout, an abort) is -1 whatever code the kill made it exit with (taskkill ends it with 1): the exit event
		// can come before the kill call returns
		let killed = false;
		const kill = () => {
			killed = true;
			if (pid && !gone) void killTree(pid).then(() => finish(-1));
			else finish(-1);
		};
		const onAbort = () => kill();
		const timer = setTimeout(kill, opts.timeoutMs);
		child.once('exit', (code) => finish(killed ? -1 : (code ?? -1)));
		if (opts.signal) {
			if (opts.signal.aborted) kill();
			else opts.signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

const words = (command: string) => command.split(' ').filter(Boolean);

/** Logs how long one stage of a run took, as `Stage <name>: <seconds>s` (the benchmark reads these lines). */
function stageDone(log: (s: string) => void, name: string, since: number): void {
	log(`Stage ${name}: ${((Date.now() - since) / 1000).toFixed(1)}s`);
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
	// The raw value is not the only way a secret shows in a log: URL encoded, base64 and the shape of a token are removed as well
	return redactText(out, secrets);
}

/** Waits until GET url answers with a status below 500. Gives up after `timeoutMs`, at once when `exited` says the process is gone, or when the signal aborts. */
export async function waitReady(
	url: string,
	opts: { timeoutMs: number; exited: () => boolean; intervalMs?: number; signal?: AbortSignal }
): Promise<'ready' | 'exited' | 'timeout' | 'aborted'> {
	const until = Date.now() + opts.timeoutMs;
	while (Date.now() < until) {
		if (opts.signal?.aborted) return 'aborted';
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
	if (opts.signal?.aborted) return 'aborted';
	return opts.exited() ? 'exited' : 'timeout';
}

/** Picks a free port on 127.0.0.1 and refuses a forbidden one. */
export async function pickPort(): Promise<number> {
	const port = await freePort();
	if (FORBIDDEN_PORTS.has(port)) throw new Error(`Port ${port} is not one a check may use.`);
	return port;
}

/**
 * The preview of a live site: nothing is copied, built or started. A loopback address on a port a check never uses is refused. The run is unverified:
 * there is no commit and no diff hash, and the note says so.
 */
export function liveSitePreview(cfg: ProjectConfig): Preview {
	let u: URL;
	try {
		u = new URL(String(cfg.url));
	} catch {
		throw new Error('The live site address is not a web address.');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:')
		throw new Error('The live site address must start with http:// or https://.');
	if (LOOPBACK.has(u.hostname.toLowerCase())) {
		const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
		if (FORBIDDEN_PORTS.has(port)) throw new Error(`Port ${port} is not one a check may use.`);
	}
	return {
		baseUrl: cfg.url as string,
		commit: null,
		diffHash: null,
		testUser: cfg.testUser ?? null,
		secrets: cfg.testUser ? [cfg.testUser.password] : [],
		note: 'This is a live site: nothing was built or started, so the run is unverified (no commit is recorded).'
	};
}

export async function startPreview(cfg: ProjectConfig, opts: PreviewOptions): Promise<Preview> {
	const { runId, scope, log, signal } = opts;
	const stopIfAborted = () => {
		if (signal?.aborted) throw new Error(STOPPED);
	};
	// -- 0. A LIVE SITE: NOTHING TO MAKE -- //
	if (cfg.url) return liveSitePreview(cfg);
	// The app folder is checked in the live repo first, so a bad one stops before anything is copied
	if (cfg.appDir) {
		const problem = appDirProblem(cfg.repo, cfg.appDir);
		if (problem) throw new Error(problem);
	}
	// -- 1. THE MARKER COMES FIRST -- //
	scope.start();
	// The run folder is the child's to write; the logs hold what the app printed and live where the child cannot read (paths.ts logsDir)
	ensureDir(under(runsDir(), runId));
	const logDir = ensureDir(logDirFor(runId));
	const notes: string[] = [];
	const secrets: string[] = [];
	const known = opts.needles ?? [];
	const learn = (...values: string[]) => {
		for (const v of values)
			if (typeof v === 'string' && v.length >= 6 && !known.includes(v)) known.push(v);
	};
	// -- 2. A PRIVATE COPY -- //
	const copyDir = under(copiesDir(), runId);
	scope.setInfo({ copyDir });
	scope.add('private copy', () => removeTree(copyDir));
	const copyStart = Date.now();
	// The tree is hashed before the copy and again after it: a file saved while the copy was made would otherwise be tested but described by another hash
	let hashBefore = await hashChanges(cfg.repo);
	let calls = 0;
	const copyOnce = () =>
		makePrivateCopy(cfg.repo, copyDir, {
			log,
			afterCopy: opts.afterCopy ? () => opts.afterCopy?.(++calls) : undefined
		});
	let made = await copyOnce();
	let diffHash = await hashChanges(cfg.repo);
	if (diffHash !== hashBefore) {
		log('The repo changed while it was being copied; copying again.');
		removeTree(copyDir);
		hashBefore = diffHash;
		made = await copyOnce();
		diffHash = await hashChanges(cfg.repo);
		if (diffHash !== hashBefore)
			notes.push(
				'The repo kept changing while it was copied, so the diff hash may not describe exactly the files that were tested.'
			);
	}
	stopIfAborted();
	log(
		`Made a private copy of ${made.files} changed file(s) at ${made.head ? made.head.slice(0, 8) : 'no commit'}.`
	);
	stageDone(log, 'copy', copyStart);
	// The app folder is walked again inside the copy: a link or a missing package.json there stops the run
	const appCwd = sandboxAppRoot(made.repoInCopy, cfg.appDir);
	// -- 3. WHAT WAS TESTED -- //
	const commit = made.head;
	// -- 4. A FREE PORT -- //
	const port = await pickPort();
	const baseUrl = `http://127.0.0.1:${port}`;
	// -- 5. A THROWAWAY DATABASE, ONLY WHEN THE APP NEEDS ONE -- //
	let databaseUrl: string | undefined;
	let ownerUrl: string | undefined;
	if (cfg.needsDatabase) {
		const databaseStart = Date.now();
		// One pool container per machine and a clone per run. The app migrates and seeds itself at start (AFB_AUTO_MIGRATE), so the template
		// is an empty database that every run clones; it falls back to a container per run when the pool is not available
		const db = await provisionDatabase(runId, scope, log, {
			runtimeRole: cfg.runtimeRole,
			template: {
				recipeHash: createHash('sha256')
					.update(JSON.stringify([cfg.build, cfg.start, cfg.runtimeRole ?? '']))
					.digest('hex')
					.slice(0, 16),
				migrationHash: 'self-migrating',
				warm: async () => undefined
			}
		});
		databaseUrl = db.databaseUrl;
		ownerUrl = db.ownerUrl;
		secrets.push(db.databaseUrl, db.ownerUrl);
		learn(db.databaseUrl, db.ownerUrl);
		notes.push('A throwaway database was made for this run.');
		stageDone(log, 'database', databaseStart);
	}
	// -- ENVIRONMENT -- //
	// Sealed values ({secret:NAME}) are opened from this registration's own store only; service and mail keys are for the start alone, the build never sees them
	let recipeEnv = cfg.env;
	let startOnly: string[] = [];
	let sealedHosts: string[] = [];
	let sealedReds: string[] = [];
	let sealedNames: string[] = [];
	let mailInbox: string | null = null;
	if (cfg.registration && Object.values(cfg.env).some((v) => v.includes('{secret:'))) {
		const opened = resolveSealedEnv(cfg.registration.org, cfg.registration.name, cfg.env);
		recipeEnv = opened.env;
		startOnly = opened.startOnly;
		sealedHosts = opened.hosts;
		sealedReds = opened.redactions;
		sealedNames = [...opened.filled];
		mailInbox = opened.mailInbox;
		secrets.push(...opened.redactions);
		learn(...opened.redactions);
		notes.push(
			`Opened ${opened.filled.length} sealed value(s) (names only: ${opened.filled.join(', ')}).`
		);
	}
	// A registration whose owner approved it adopts the whole repo .env (database values are refused, not stripped); any other keeps the stricter rule
	let startEnv: Record<string, string>;
	let buildEnv: Record<string, string>;
	let adoptedReds: string[] = [];
	if (cfg.adoptEnv) {
		const adopted = buildAdoptedEnv({
			repo: cfg.repo,
			appDir: cfg.appDir,
			recipeEnv,
			port,
			baseUrl,
			databaseUrl,
			databaseOwnerUrl: ownerUrl,
			sealedNames,
			testHost: sealedHosts[0]
		});
		if (adopted.problems.length) throw new Error(adopted.problems.join(' '));
		startEnv = adopted.env;
		buildEnv = adopted.buildEnv;
		// The address of the preview itself is not a secret: keeping it out of the redactions keeps the run log readable
		adoptedReds = adopted.redactions.filter((v) => !v.includes(baseUrl));
		notes.push(...adopted.notes);
	} else {
		const built = buildPreviewEnv({
			repo: cfg.repo,
			recipeEnv,
			port,
			baseUrl,
			databaseUrl,
			databaseOwnerUrl: ownerUrl
		});
		startEnv = built.env;
		buildEnv = built.env;
		notes.push(...built.notes);
	}
	buildEnv = omitKeys(buildEnv, startOnly);
	const mailLog = join(logDir, 'mail-guard.jsonl');
	if (mailInbox) startEnv = withMailGuard(startEnv, { inbox: mailInbox, log: mailLog });
	const redact = [
		...Object.values(startEnv).filter((v) => v.length >= 6),
		...Object.values(buildEnv).filter((v) => v.length >= 6),
		...secrets,
		...sealedReds,
		...adoptedReds
	];
	secrets.push(...adoptedReds);
	if (cfg.testUser) {
		secrets.push(cfg.testUser.password);
		redact.push(cfg.testUser.password);
	}
	learn(...redact);
	stopIfAborted();
	// -- 6. INSTALL AND BUILD -- //
	const buildLogFile = join(logDir, 'build.log');
	const buildLog = openSync(buildLogFile, 'a');
	// The command of a stage ended without an exit code: it timed out, was killed or was stopped. That is the machine's trouble, not the code's, so a run that waited for it may try again
	const stageFailed = (what: string, code: number): Error =>
		stageError(what, code, Boolean(signal?.aborted), () => tailOf(buildLogFile, redact));
	try {
		const installStart = Date.now();
		// A monorepo keeps its lock file above the app folder: the install runs where the lock file is
		const installDir = installDirFor(appCwd, copyDir);
		const install = installDir ? installCommand(installDir) : null;
		if (!install || !installDir) log('No lockfile, install skipped.');
		if (install && installDir) {
			const doInstall = async () => {
				stopIfAborted();
				log('Installing dependencies in the private copy.');
				const code = await runToEnd(install, {
					cwd: installDir,
					env: buildEnv,
					out: buildLog,
					timeoutMs: BUILD_TIMEOUT_MS,
					scope,
					name: 'install process',
					signal
				});
				if (code !== 0) throw stageFailed('install', code);
			};
			// Dependencies are kept per registration by lockfile hash, node, platform, architecture and package manager. Runs that need the same set
			// install once (single flight) and the others restore it; a pnpm install is never kept (its modules name the store location)
			const pm = packageManagerOf(installDir);
			const depsCacheRoot = cfg.registration
				? cacheDirFor(cfg.registration.org, cfg.registration.name)
				: null;
			const dkey =
				depsCacheRoot && pm && installCacheable(installDir)
					? depsKey({
							lockHash: lockHash(installDir),
							node: process.version,
							platform: process.platform,
							arch: process.arch,
							pm,
							pmVersion: await packageManagerVersion(pm, installDir, buildEnv)
						})
					: null;
			if (depsCacheRoot && dkey) {
				const flight = await singleFlight(
					`deps-${dkey.slice(0, 32)}`,
					async () => {
						if (hasEntry(depsCacheRoot, 'deps', dkey)) return { hit: true };
						await doInstall();
						await publishDepsAsync(depsCacheRoot, dkey, installDir);
						return { hit: false };
					},
					{ signal }
				);
				const installedHere = flight.role === 'builder' && !flight.result.hit;
				if (!installedHere) {
					const restored = await restoreOrNull(
						'dependencies',
						() => restoreDepsAsync(depsCacheRoot, dkey, installDir, { link: 'auto' }),
						log
					);
					if (restored) log(`Restored the kept dependencies (${restored.files} files).`);
					else await doInstall();
				}
				evict(depsCacheRoot, { builds: KEEP_BUILDS, deps: KEEP_DEPS, maxAgeDays: 14 });
			} else await doInstall();
		}
		stageDone(log, 'install', installStart);
		stopIfAborted();
		const buildStart = Date.now();
		if (cfg.build) {
			const doBuild = async () => {
				stopIfAborted();
				log('Building the project.');
				const code = await runToEnd(words(cfg.build as string), {
					cwd: appCwd,
					env: buildEnv,
					out: buildLog,
					timeoutMs: BUILD_TIMEOUT_MS,
					scope,
					name: 'build process',
					signal
				});
				if (code !== 0) throw stageFailed('build', code);
			};
			// A finished build is kept per registration when nothing that decides it is per run (no port, base url, database url or secret in the
			// command or the environment, adopted values included). Runs that need the same build build it once and the others restore it
			const buildRoot = cfg.registration
				? cacheDirFor(cfg.registration.org, cfg.registration.name)
				: null;
			const tree = treeId({ commit, diffHash });
			const bkey =
				buildRoot && tree
					? buildKey({
							org: cfg.registration?.org ?? '',
							name: cfg.registration?.name ?? '',
							treeId: tree,
							surface: pinFiles(cfg.repo),
							build: cfg.build,
							env: buildEnv,
							secretValues: secrets,
							appDir: cfg.appDir ?? ''
						})
					: null;
			if (buildRoot && bkey) {
				const before = await snapshotAsync(appCwd);
				const flight = await singleFlight(
					`build-${bkey.slice(0, 32)}`,
					async () => {
						if (hasEntry(buildRoot, 'builds', bkey)) return { hit: true };
						await doBuild();
						await publishBuildAsync(buildRoot, bkey, appCwd, before);
						return { hit: false };
					},
					{ signal }
				);
				const builtHere = flight.role === 'builder' && !flight.result.hit;
				if (!builtHere) {
					const restored = await restoreOrNull(
						'build',
						() => restoreBuildAsync(buildRoot, bkey, appCwd, { link: 'auto' }),
						log
					);
					if (restored) log(`Restored the kept build (${restored.files} files).`);
					else await doBuild();
				}
			} else await doBuild();
		}
		stageDone(log, 'build', buildStart);
	} finally {
		closeSync(buildLog);
	}
	stopIfAborted();
	// -- 7. START -- //
	const startStageStart = Date.now();
	const previewLogFile = join(logDir, 'preview.log');
	const startLog = openSync(previewLogFile, 'a');
	let child: ChildProcess;
	try {
		child = await launch(words(cfg.start.split('{port}').join(String(port))), {
			cwd: appCwd,
			env: startEnv,
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
	const state = await waitReady(readyUrl, {
		timeoutMs: READY_TIMEOUT_MS,
		exited: () => exited,
		signal
	});
	if (state === 'aborted') throw new Error(STOPPED);
	if (state !== 'ready') {
		const why =
			state === 'exited'
				? 'The preview stopped before it answered.'
				: 'The preview did not answer within 120 seconds.';
		throw new Error(`${why} Last lines:\n${tailOf(previewLogFile, redact)}`);
	}
	log('The preview answers.');
	stageDone(log, 'start-and-ready', startStageStart);
	// The mail guard must have reported listening on the preview port, or mail may not have been fenced and the run does not count
	if (mailInbox) {
		const fence = readFence(mailLog, port);
		const problem = fenceProblem(true, fence);
		if (problem) throw new Error(problem);
		notes.push(describeFence(mailInbox, fence));
	}
	// -- 9. RESULT -- //
	return {
		baseUrl,
		commit,
		diffHash,
		testUser: cfg.testUser ?? null,
		secrets,
		note: notes.join(' '),
		extraHosts: sealedHosts,
		...(mailInbox ? { mail: { inbox: mailInbox, log: mailLog, port } } : {})
	};
}
