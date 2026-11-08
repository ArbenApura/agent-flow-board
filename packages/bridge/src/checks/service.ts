// `check service install|uninstall|status|run`: THE CHECK WORKER AS A BACKGROUND SERVICE ON WINDOWS (A LOGON LAUNCHER AND A SUPERVISOR)
// `install` puts a small launcher in the Startup folder that runs `check service run` hidden at logon. `run` is a supervisor: it holds service.lock
// (one supervisor per machine), keeps one `check watch` child going, starts it again when it dies (waiting longer after each quick death), stops
// with one plain line when a restart can never help, and restarts the worker on a newer installed bridge, but only while the worker has no busy run.
// A process is stopped by `uninstall` only when its id AND its start time match what the lock recorded (a reused process id is never touched).
// Everything the service writes to its log passes redact.ts first.

// -- DEP-MODULES -- //
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// -- MODULES -- //
import { machineTotals } from './broker.js';
import { pidAlive } from './lock.js';
import { checksHome, ensureDir } from './paths.js';
import { redact } from './redact.js';

// -- TYPES -- //

export type ServiceContext = {
	log(line: string): void;
	out(line: string): void;
	json: boolean;
};
export type LastExit = { code: number; afterSeconds: number; at: string };
export type ServiceStatus = {
	state: 'running' | 'restarting' | 'stopped';
	message: string | null;
	lastExit?: LastExit;
	at: string;
};
export type ServiceLock = { pid: number; startedAt: string; version: string };
/** What the service needs from the machine. A test passes stand-ins. */
export type ServiceDeps = {
	platform: NodeJS.Platform;
	/** Start time of a process in milliseconds since 1970, or null when it cannot be read. */
	startOf(pid: number): Promise<number | null>;
	isAlive(pid: number): boolean;
	/** Stops a process and everything it started. */
	killTree(pid: number): Promise<void>;
	/** Starts `check service run` detached. */
	startDetached(): void;
	/** The folder of the launcher. */
	startupDir(): string;
};
export type RunServiceOptions = {
	say?: (line: string) => void;
	/** The command that is the worker. Default: this bridge's `check watch`. */
	workerCommand?: { cmd: string; args: string[] };
	/** The version this supervisor was started with (kept in service.lock). */
	version?: string;
	/** The version that is installed now. A higher one than `version` asks for a restart when the worker is idle. */
	installedVersion?: () => string;
	/** How often the installed version is looked at. */
	versionCheckMs?: number;
	nap?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
	signal?: AbortSignal;
	/** For tests: stop after this many restarts. */
	maxRestarts?: number;
	deps?: Partial<ServiceDeps>;
};
export type RunServiceResult = {
	reason: 'stopped' | 'terminal' | 'already' | 'max';
	message?: string;
};
type WorkerEnd = { code: number; out: string; replaced: boolean };

// -- CONSTANTS -- //

export const LOG_LIMIT = 1_000_000;
/** A worker that lived this long was healthy: the next wait starts small again. */
export const HEALTHY_MS = 60_000;
/** Start times are compared within this many milliseconds (the lock is written a moment after the process starts). */
export const START_TOLERANCE_MS = 120_000;
/**
 * What a restart can never fix. The supervisor stops and says it, instead of looping. Only the sentinel line the worker prints (watch.ts terminalLine) counts, never
 * free text: a log line of an app that happens to say "not set up" must not stop the service.
 */
export const TERMINAL: RegExp[] = [
	/^AFB_TERMINAL: (not-connected|rejected|needs-newer|not-set-up)\s*$/m
];
export const LAUNCHER_NAME = 'afb-checks-bridge.vbs';

// -- FUNCTIONS -- //

const lockFile = () => join(checksHome(), 'service.lock');
const statusFile = () => join(checksHome(), 'service-status.json');
export const serviceLogFile = () => join(checksHome(), 'service.log');
const workerFile = () => join(checksHome(), 'worker.json');

const here = dirname(fileURLToPath(import.meta.url));
/** The bridge's cli.js (dist/cli.js; src/cli.ts when run from source). */
export const cliPath = () =>
	join(here, '..', existsSync(join(here, '..', 'cli.js')) ? 'cli.js' : 'cli.ts');
/** The version in this bridge's package.json (two folders up from dist/checks or src/checks). */
export function installedBridgeVersion(): string {
	try {
		const v: unknown = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
		const ver = (v as { version?: unknown }).version;
		return typeof ver === 'string' ? ver : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
};

// -- PURE HELPERS -- //

/** 1 s x 2^min(quickDeaths, 6), at most 60 s. */
export const backoffDelay = (quickDeaths: number): number =>
	Math.min(60_000, 1000 * 2 ** Math.min(Math.max(0, quickDeaths), 6));
/** The count of quick deaths after a worker that lived `livedMs`: reset after a long run. */
export const nextQuick = (quick: number, livedMs: number): number =>
	livedMs > HEALTHY_MS ? 0 : quick + 1;
export const isTerminal = (output: string): boolean => TERMINAL.some((re) => re.test(output));

/** True when version `a` is higher than `b` (dotted numbers; anything after a dash or plus is ignored). */
export function versionNewer(a: string, b: string): boolean {
	const part = (v: string) =>
		v
			.split(/[-+]/)[0]!
			.split('.')
			.map((n) => Number.parseInt(n, 10) || 0);
	const x = part(a);
	const y = part(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}

const vbsQuote = (s: string): string => {
	if (s.includes('"')) throw new Error('A path with a double quote cannot go in the launcher.');
	return `""${s}""`;
};
/** The launcher text: a Visual Basic script that runs the supervisor with no window (style 0) and does not wait. */
export function launcherText(node: string, cli: string): string {
	return `' afb-checks bridge: starts the check worker with no window when you sign in to Windows. Remove it with: agent-flow-board check service uninstall\r\nCreateObject("WScript.Shell").Run "${vbsQuote(node)} ${vbsQuote(cli)} check service run", 0, False\r\n`;
}
const BOM = String.fromCharCode(0xfeff);
/** The launcher bytes: UTF-16LE with a byte order mark, which Windows Script Host reads whatever the code page. */
export const launcherBytes = (node: string, cli: string): Buffer =>
	Buffer.from(BOM + launcherText(node, cli), 'utf16le');

/** True when a process with this id is the one that wrote the lock: alive, and a start time within the tolerance. `strict` refuses an unknown start time. */
export async function sameProcess(
	lock: ServiceLock | null,
	deps: Pick<ServiceDeps, 'isAlive' | 'startOf'>,
	strict: boolean
): Promise<boolean> {
	if (!lock || !Number.isInteger(lock.pid) || !deps.isAlive(lock.pid)) return false;
	const started = await deps.startOf(lock.pid);
	const wrote = Date.parse(lock.startedAt);
	if (started === null || Number.isNaN(wrote)) return !strict;
	return Math.abs(started - wrote) < START_TOLERANCE_MS;
}

function parseLock(value: unknown): ServiceLock | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as Partial<ServiceLock>;
	return typeof v.pid === 'number' &&
		typeof v.startedAt === 'string' &&
		typeof v.version === 'string'
		? { pid: v.pid, startedAt: v.startedAt, version: v.version }
		: null;
}
export const readServiceLock = (): ServiceLock | null => parseLock(readJson(lockFile()));

/** Appends one redacted line to the service log, moving it to service.log.old once it passes 1 MB. */
export function writeLog(line: string, now: Date = new Date()): void {
	ensureDir(checksHome());
	const file = serviceLogFile();
	try {
		if (existsSync(file) && statSync(file).size > LOG_LIMIT) {
			rmSync(`${file}.old`, { force: true });
			renameSync(file, `${file}.old`);
		}
	} catch {
		/* A log that cannot be rotated is still appended to */
	}
	appendFileSync(file, `${now.toISOString()} ${redact(line)}\n`, { mode: 0o600 });
}
/** The last lines of the log, redacted again on the way out. */
export function tailLog(n = 3): string[] {
	try {
		return readFileSync(serviceLogFile(), 'utf8')
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-n)
			.map((l) => redact(l));
	} catch {
		return [];
	}
}

export function readServiceStatus(): ServiceStatus | null {
	const v = readJson(statusFile());
	if (!v || typeof v !== 'object') return null;
	const s = v as Partial<ServiceStatus>;
	if (s.state !== 'running' && s.state !== 'restarting' && s.state !== 'stopped') return null;
	return {
		state: s.state,
		message: typeof s.message === 'string' ? s.message : null,
		lastExit: s.lastExit,
		at: typeof s.at === 'string' ? s.at : ''
	};
}
export function writeServiceStatus(patch: Partial<Omit<ServiceStatus, 'at'>>): void {
	ensureDir(checksHome());
	const merged = {
		state: 'stopped' as const,
		message: null,
		...(readServiceStatus() ?? {}),
		...patch,
		at: new Date().toISOString()
	};
	const tmp = `${statusFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(merged, null, '\t') + '\n', { mode: 0o600 });
	renameSync(tmp, statusFile());
}

/**
 * True when no run is busy. The live slot count of the machine decides (a slot is held for as long as a run is claimed, whichever process holds it); the worker's
 * status file only adds to it: a file that says some run is busy keeps the worker, a damaged one does too, a missing one means no worker has run yet.
 */
export function workerIdle(): boolean {
	try {
		if (machineTotals().busy > 0) return false;
	} catch {
		return false;
	}
	if (!existsSync(workerFile())) return true;
	const v = readJson(workerFile());
	if (!v || typeof v !== 'object') return false;
	const busy = (v as { busy?: unknown }).busy;
	return typeof busy === 'number' && busy === 0;
}

// -- PROCESS HELPERS -- //

function startOfDefault(platform: NodeJS.Platform) {
	return (pid: number): Promise<number | null> =>
		new Promise((resolve) => {
			const done = (text: string) => {
				const t = Date.parse(text.trim());
				resolve(Number.isNaN(t) ? null : t);
			};
			try {
				if (platform === 'win32')
					execFile(
						'powershell',
						[
							'-NoProfile',
							'-NonInteractive',
							'-Command',
							`(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
						],
						{ windowsHide: true, timeout: 15_000 },
						(err, stdout) => (err ? resolve(null) : done(String(stdout)))
					);
				else
					execFile(
						'ps',
						['-o', 'lstart=', '-p', String(Math.trunc(pid))],
						{ timeout: 15_000, env: { ...process.env, LC_ALL: 'C' } },
						(err, stdout) => (err ? resolve(null) : done(String(stdout)))
					);
			} catch {
				resolve(null);
			}
		});
}

function killTreeDefault(platform: NodeJS.Platform) {
	return (pid: number): Promise<void> =>
		new Promise((resolve) => {
			if (!pid) return resolve();
			if (platform === 'win32') {
				try {
					const c = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
						stdio: 'ignore',
						windowsHide: true
					});
					c.on('error', () => resolve());
					c.on('close', () => resolve());
				} catch {
					resolve();
				}
				return;
			}
			try {
				process.kill(pid, 'SIGTERM');
			} catch {
				/* Already gone */
			}
			resolve();
		});
}

export function defaultServiceDeps(): ServiceDeps {
	const platform = process.platform;
	return {
		platform,
		startOf: startOfDefault(platform),
		isAlive: pidAlive,
		killTree: killTreeDefault(platform),
		startDetached() {
			const c = spawn(process.execPath, [cliPath(), 'check', 'service', 'run'], {
				detached: true,
				stdio: 'ignore',
				windowsHide: true
			});
			c.unref();
		},
		startupDir: () =>
			process.env.AFB_CHECKS_STARTUP ??
			join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
	};
}
const withDeps = (d?: Partial<ServiceDeps>): ServiceDeps => ({ ...defaultServiceDeps(), ...d });

// -- THE LOCK -- //

/** Writes the lock whole into a temporary file and links it into place, so a second supervisor never sees half of it. */
function tryCreateLock(text: string): boolean {
	const file = lockFile();
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	try {
		linkSync(tmp, file);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw e;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Takes service.lock, or returns null when a live supervisor holds it. A lock of a gone process is moved aside in one step and taken over. */
export async function acquireServiceLock(
	version: string,
	deps: Pick<ServiceDeps, 'isAlive' | 'startOf'>
): Promise<{ release(): void; setVersion(v: string): void } | null> {
	ensureDir(checksHome());
	const body = (v: string): ServiceLock => ({
		pid: process.pid,
		startedAt: new Date().toISOString(),
		version: v
	});
	const mine = body(version);
	const text = () => JSON.stringify(mine) + '\n';
	let got = false;
	for (let i = 0; i < 4 && !got; i++) {
		if (tryCreateLock(text())) {
			got = true;
			break;
		}
		const held = readServiceLock();
		if (held && (await sameProcess(held, deps, false))) return null;
		const aside = `${lockFile()}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
		try {
			renameSync(lockFile(), aside);
		} catch {
			continue;
		}
		// What was moved may be a fresh lock that another supervisor made in the meantime: it goes back
		const moved = parseLock(readJson(aside));
		if (moved && moved.pid !== held?.pid && (await sameProcess(moved, deps, false))) {
			try {
				linkSync(aside, lockFile());
			} catch {
				/* Another lock is already there */
			}
			rmSync(aside, { force: true });
			return null;
		}
		rmSync(aside, { force: true });
	}
	if (!got) return null;
	return {
		release() {
			if (readServiceLock()?.pid === process.pid) rmSync(lockFile(), { force: true });
		},
		setVersion(v: string) {
			mine.version = v;
			if (readServiceLock()?.pid === process.pid) {
				const tmp = `${lockFile()}.${process.pid}.v.tmp`;
				writeFileSync(tmp, text(), { mode: 0o600 });
				renameSync(tmp, lockFile());
			}
		}
	};
}

// -- THE SUPERVISOR -- //

const defaultNap = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal.removeEventListener('abort', done);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});

/** Keeps the worker going until the signal aborts or a restart can never help. Holds service.lock all the time. */
export async function runService(opts: RunServiceOptions = {}): Promise<RunServiceResult> {
	const say = opts.say ?? (() => undefined);
	const deps = withDeps(opts.deps);
	const version = opts.version ?? installedBridgeVersion();
	const installed = opts.installedVersion ?? installedBridgeVersion;
	const nap = opts.nap ?? defaultNap;
	const now = opts.now ?? Date.now;
	const signal = opts.signal ?? new AbortController().signal;
	const worker = opts.workerCommand ?? {
		cmd: process.execPath,
		args: [cliPath(), 'check', 'watch']
	};
	const checkMs = opts.versionCheckMs ?? 60_000;
	const lock = await acquireServiceLock(version, deps);
	if (!lock) {
		say('The check service is already running on this machine.');
		return { reason: 'already' };
	}
	let current = version;
	let quick = 0;
	let restarts = 0;
	const held: { child: ReturnType<typeof spawn> | null } = { child: null };
	const onAbort = () => {
		if (held.child?.pid) void deps.killTree(held.child.pid);
	};
	signal.addEventListener('abort', onAbort, { once: true });
	writeLog(`service started (pid ${process.pid}, bridge ${version})`);
	try {
		for (;;) {
			if (signal.aborted) break;
			const began = now();
			writeServiceStatus({ state: 'running', message: null });
			const ended = await new Promise<WorkerEnd>((resolve) => {
				let tail = '';
				let replaced = false;
				const partial = { out: '', err: '' };
				const feed = (which: 'out' | 'err') => (d: Buffer) => {
					const text = d.toString();
					tail = (tail + text).slice(-4000);
					const lines = (partial[which] + text).split(/\r?\n/);
					partial[which] = lines.pop() ?? '';
					for (const l of lines) if (l.trim()) writeLog(`worker: ${l}`);
				};
				const flush = () => {
					for (const rest of [partial.out, partial.err])
						if (rest.trim()) writeLog(`worker: ${rest}`);
				};
				let timer: NodeJS.Timeout | null = null;
				let c: ReturnType<typeof spawn>;
				try {
					c = spawn(worker.cmd, worker.args, {
						windowsHide: true,
						stdio: ['ignore', 'pipe', 'pipe'],
						env: { ...process.env, AFB_CHECKS_SERVICE_CHILD: '1' }
					});
				} catch (e) {
					return resolve({
						code: -1,
						out: e instanceof Error ? e.message : String(e),
						replaced: false
					});
				}
				held.child = c;
				c.stdout?.on('data', feed('out'));
				c.stderr?.on('data', feed('err'));
				const finish = (code: number, extra = '') => {
					if (timer) clearInterval(timer);
					flush();
					held.child = null;
					resolve({ code, out: tail + extra, replaced });
				};
				c.on('error', (e) => finish(-1, `\n${e.message}`));
				c.on('close', (code) => finish(code ?? -1));
				// A newer installed bridge restarts the worker, but never while a run is busy
				timer = setInterval(() => {
					if (replaced || signal.aborted) return;
					let latest: string;
					try {
						latest = installed();
					} catch {
						return;
					}
					if (versionNewer(latest, current) && workerIdle()) {
						replaced = true;
						writeLog(
							`bridge ${latest} is installed (running ${current}) and no run is busy: restarting the worker`
						);
						current = latest;
						lock.setVersion(latest);
						if (c.pid) void deps.killTree(c.pid);
					}
				}, checkMs);
			});
			const lived = now() - began;
			const seconds = Math.round(lived / 1000);
			writeServiceStatus({
				state: 'restarting',
				lastExit: { code: ended.code, afterSeconds: seconds, at: new Date().toISOString() }
			});
			writeLog(`worker ended with code ${ended.code} after ${seconds}s`);
			if (signal.aborted) break;
			if (ended.replaced) {
				quick = 0;
				continue;
			}
			if (isTerminal(ended.out)) {
				const last = redact(ended.out.trim().split(/\r?\n/).slice(-3).join(' | '));
				const message = last || `The worker stopped with code ${ended.code}.`;
				writeServiceStatus({ state: 'stopped', message });
				writeLog(`service stopped: ${message}`);
				say(`The check service stopped: ${message}`);
				return { reason: 'terminal', message };
			}
			quick = nextQuick(quick, lived);
			if (++restarts > (opts.maxRestarts ?? Infinity)) return { reason: 'max' };
			await nap(backoffDelay(quick), signal);
		}
		writeServiceStatus({ state: 'stopped', message: 'Stopped.' });
		return { reason: 'stopped' };
	} finally {
		signal.removeEventListener('abort', onAbort);
		if (held.child) onAbort();
		lock.release();
		writeLog('service ended');
	}
}

// -- THE COMMAND -- //

export const SERVICE_USAGE =
	'Usage: agent-flow-board check service install [--no-start] | uninstall | status [--json]';

export async function serviceCommand(
	args: string[],
	ctx: ServiceContext,
	override?: Partial<ServiceDeps>
): Promise<number> {
	const sub = args[0];
	const deps = withDeps(override);
	const launcherFile = () => join(deps.startupDir(), LAUNCHER_NAME);
	try {
		if (sub === 'install') {
			if (deps.platform !== 'win32' && !process.env.AFB_CHECKS_STARTUP) {
				ctx.log(
					'The service launcher is for Windows (the Startup folder). On macOS or Linux run "agent-flow-board check watch" under your own service manager (launchd, systemd).'
				);
				return 2;
			}
			const file = launcherFile();
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, launcherBytes(process.execPath, cliPath()));
			ctx.log(
				`Installed ${file}. The worker now starts, with no window, each time you sign in to Windows.`
			);
			let started = false;
			if (!args.includes('--no-start')) {
				if (await sameProcess(readServiceLock(), deps, false))
					ctx.log('The service is already running.');
				else {
					deps.startDetached();
					started = true;
					ctx.log('Started it now as well.');
				}
			}
			if (ctx.json) ctx.out(JSON.stringify({ ok: true, launcher: file, started }));
			return 0;
		}
		if (sub === 'uninstall') {
			const file = launcherFile();
			const had = existsSync(file);
			rmSync(file, { force: true });
			ctx.log(had ? `Removed ${file}.` : 'The launcher was not installed.');
			const lock = readServiceLock();
			let stopped = false;
			if (lock && deps.isAlive(lock.pid)) {
				if (await sameProcess(lock, deps, true)) {
					await deps.killTree(lock.pid);
					stopped = true;
					ctx.log('Stopped the running service.');
				} else
					ctx.log(
						`Process ${lock.pid} is not the recorded service (its start time does not match), so it was left alone.`
					);
			}
			if (!lock || !deps.isAlive(lock.pid) || stopped) rmSync(lockFile(), { force: true });
			writeServiceStatus({ state: 'stopped', message: 'Uninstalled.' });
			if (ctx.json) ctx.out(JSON.stringify({ ok: true, removed: had, stopped }));
			return 0;
		}
		if (sub === 'status') {
			const installed = existsSync(launcherFile());
			const lock = readServiceLock();
			const running = await sameProcess(lock, deps, false);
			const status = readServiceStatus();
			const tail = tailLog(3);
			if (ctx.json)
				ctx.out(
					JSON.stringify({
						installed,
						running,
						pid: running ? lock?.pid : null,
						version: lock?.version ?? null,
						status,
						log: tail
					})
				);
			else {
				ctx.log(
					`Service: ${installed ? 'installed (starts when you sign in)' : 'not installed (agent-flow-board check service install)'}, ${running ? 'running' : 'stopped'}`
				);
				if (status?.message) ctx.log(`  ${status.state}: ${redact(status.message)}`);
				if (status?.lastExit)
					ctx.log(
						`  last worker exit: code ${status.lastExit.code} after ${status.lastExit.afterSeconds}s at ${status.lastExit.at}`
					);
				for (const l of tail) ctx.log(`  log: ${l}`);
			}
			return 0;
		}
		if (sub === 'run') {
			const ac = new AbortController();
			const stop = () => ac.abort();
			process.once('SIGINT', stop);
			process.once('SIGTERM', stop);
			try {
				const r = await runService({ say: ctx.log, signal: ac.signal, deps: override });
				return r.reason === 'already' || r.reason === 'terminal' ? 1 : 0;
			} finally {
				process.off('SIGINT', stop);
				process.off('SIGTERM', stop);
			}
		}
		ctx.log(SERVICE_USAGE);
		return 2;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (ctx.json) ctx.out(JSON.stringify({ ok: false, event: 'error', error: message }));
		else ctx.log(message);
		return 2;
	}
}
