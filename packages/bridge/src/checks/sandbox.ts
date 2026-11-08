// THE SANDBOX OF A CHECK: A SEPARATE NODE PROCESS STARTED WITH THE PERMISSION MODEL ON.
// A check script is arbitrary Node code written by an agent, and board text can talk an agent into writing anything. The bridge keeps its
// sign-in (the key file and the token files) in the bridge home, and the check state in its checks folder. So the child can read ONLY the
// scripts folder, its own run folder, the folder of its own code and the Playwright runtime, and can write ONLY its run folder. It starts no
// program and no worker, loads no addon, and gets an environment of PATH, SystemRoot, TEMP, TMP and AFB_PLAYWRIGHT_DIR and nothing else.

// -- DEP-MODULES -- //
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// -- TYPES -- //
import type { ChildJob, ChildResult } from './types.js';
// -- MODULES -- //
import { playwrightRuntimeDir } from './browser.js';
import { MAX_RESULT_BYTES, findLink, isPlainFile, readPlainFile } from './evidence.js';
import { ensureDir, isInside, runsDir } from './paths.js';
import { redact } from './redact.js';
import { killTree } from './scope.js';

// -- TYPES -- //

export type SandboxOptions = {
	/** The script Node runs. Its folder must be in readDirs. */
	entry: string;
	/** Folders the process may read (the entry's folder included). */
	readDirs: string[];
	/** The one folder the process may write, or null for none. It is also the working directory. */
	writeDir: string | null;
	/** The whole environment of the process. Nothing is inherited. */
	env: Record<string, string>;
	/** Written to the process's stdin, then stdin is closed. */
	stdin?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Called with every complete stdout line. */
	onLine?: (line: string) => void;
};
export type SandboxRun = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

// -- CONSTANTS -- //

/** The hard limit of a whole check run. The child has its own 2 minute limit for the check itself, this is the backstop. */
export const RUN_TIMEOUT_MS = 5 * 60_000;
const SHOT = /^\d{2}\.jpg$/;
const MAX_STDERR = 4000;
const MAX_STDOUT = 2_000_000;

// -- FUNCTIONS -- //

/** The name of the permission flag of this Node: --permission since Node 23.5, --experimental-permission before. Null when it has neither. */
export function permissionFlag(): string | null {
	const flags = process.allowedNodeEnvironmentFlags;
	if (flags.has('--permission')) return '--permission';
	if (flags.has('--experimental-permission')) return '--experimental-permission';
	return null;
}

/** The environment of a sandboxed process: the least a Node program needs, a temp folder inside the run folder, and what the caller adds. */
export function sandboxEnv(
	tmpDir: string,
	extra: Record<string, string> = {}
): Record<string, string> {
	const env: Record<string, string> = {};
	if (process.env.PATH) env.PATH = process.env.PATH;
	if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
	env.TEMP = tmpDir;
	env.TMP = tmpDir;
	return { ...env, ...extra };
}

/** Runs a Node script with the permission model on: it reads readDirs, writes writeDir, and starts nothing. */
export async function runNodeInSandbox(opts: SandboxOptions): Promise<SandboxRun> {
	const flag = permissionFlag();
	if (!flag)
		throw new Error(
			`This Node (${process.version}) has no permission model, so a check cannot be run safely. Use Node 22 or newer.`
		);
	const args = [flag, ...opts.readDirs.map((d) => `--allow-fs-read=${d}`)];
	if (opts.writeDir) args.push(`--allow-fs-write=${opts.writeDir}`);
	args.push(opts.entry);
	const child = spawn(process.execPath, args, {
		cwd: opts.writeDir ?? dirname(opts.entry),
		env: opts.env,
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
		shell: false
	});
	let stdout = '';
	let stderr = '';
	let buf = '';
	let timedOut = false;
	const stop = () => {
		if (child.pid !== undefined) void Promise.resolve(killTree(child.pid)).catch(() => {});
		child.kill();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, opts.timeoutMs);
	const onAbort = () => stop();
	if (opts.signal) {
		if (opts.signal.aborted) stop();
		else opts.signal.addEventListener('abort', onAbort, { once: true });
	}
	child.stdout.on('data', (d: Buffer) => {
		const text = d.toString('utf8');
		if (stdout.length < MAX_STDOUT) stdout += text;
		buf += text;
		let i: number;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, '');
			buf = buf.slice(i + 1);
			opts.onLine?.(line);
		}
	});
	child.stderr.on('data', (d: Buffer) => {
		stderr = (stderr + d.toString('utf8')).slice(-MAX_STDERR);
	});
	// A child that dies before reading its stdin must not crash the parent
	child.stdin.on('error', () => {});
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve(code));
		child.stdin.end(opts.stdin ?? '');
	}).finally(() => {
		clearTimeout(timer);
		opts.signal?.removeEventListener('abort', onAbort);
	});
	return { exitCode, stdout, stderr, timedOut };
}

const redactDeep = (text: unknown, needles: string[], max: number): string =>
	redact(String(text ?? ''), needles).slice(0, max);

/** The result the child wrote is data, not trusted: its shape is rebuilt, names are checked and every text goes through the redaction again. */
export function cleanResult(
	raw: unknown,
	needles: string[],
	shotsDir?: string
): ChildResult | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const steps = Array.isArray(r.steps) ? (r.steps as Record<string, unknown>[]) : [];
	return {
		schema: 1,
		result: r.result === 'pass' ? 'pass' : 'fail',
		reason: typeof r.reason === 'string' && r.reason ? redactDeep(r.reason, needles, 700) : null,
		durationMs: Number(r.durationMs) || 0,
		steps: steps
			.filter((s) => typeof s === 'object' && s !== null)
			.slice(0, 200)
			.map((s) => ({
				name: redactDeep(s.name, needles, 200),
				status: s.status === 'pass' || s.status === 'fail' ? s.status : 'shot',
				ms: Number(s.ms) || 0,
				// A picture that is not a plain file (a link the child planted) is dropped, not reported
				shot:
					SHOT.test(String(s.shot ?? '')) && (!shotsDir || isPlainFile(shotsDir, String(s.shot)))
						? String(s.shot)
						: null,
				...(s.error ? { error: redactDeep(s.error, needles, 500) } : {})
			})),
		log: redactDeep(r.log, needles, 20_000),
		blockedWrites: Number(r.blockedWrites) || 0,
		blockedOutside: Number(r.blockedOutside) || 0
	};
}

/** Runs one check script in the sandbox and returns what it wrote. The browser is already running; the job names its address. */
export async function runCheckInSandbox({
	job,
	scriptsRoot,
	log,
	signal
}: {
	job: ChildJob;
	scriptsRoot: string;
	log: (line: string) => void;
	signal?: AbortSignal;
}): Promise<{ exitCode: number | null; stderr: string; result: ChildResult | null }> {
	if (!isInside(scriptsRoot, job.checkFile))
		throw new Error('That check is not inside the scripts folder, so it was not run.');
	if (!isInside(runsDir(), job.runDir))
		throw new Error('The run folder is not inside the runs folder, so the check was not run.');
	// The permission model follows links, so a link in a folder the check may read or write would reach files outside it: none is allowed there
	for (const folder of [job.runDir, scriptsRoot]) {
		const link = findLink(folder);
		if (link)
			throw new Error(
				`There is a link or a file with several names in a folder the check may use (${basename(link)}), so the check was not run. Remove it.`
			);
	}
	const pwDir = playwrightRuntimeDir();
	if (!pwDir)
		throw new Error(
			'Playwright is not installed yet. Run "agent-flow-board check setup" and it will install it.'
		);
	const childFile = join(dirname(fileURLToPath(import.meta.url)), 'child.js');
	if (!existsSync(childFile))
		throw new Error(
			'The check runner (child.js) is missing from this install. Build the bridge again.'
		);
	const needles = job.needles ?? [];
	const tmpDir = ensureDir(join(job.runDir, 'tmp'));
	const run = await runNodeInSandbox({
		entry: childFile,
		readDirs: [scriptsRoot, job.runDir, dirname(childFile), pwDir],
		writeDir: job.runDir,
		env: sandboxEnv(tmpDir, { AFB_PLAYWRIGHT_DIR: pwDir }),
		stdin: JSON.stringify(job),
		timeoutMs: RUN_TIMEOUT_MS,
		signal,
		onLine: (line) => {
			if (!line.startsWith('EVENT ')) return;
			try {
				const e = JSON.parse(line.slice(6)) as {
					type?: string;
					status?: string;
					name?: unknown;
					ms?: unknown;
					error?: unknown;
					text?: unknown;
				};
				if (e.type === 'step') {
					const secs = Math.round((Number(e.ms) || 0) / 100) / 10;
					log(
						redact(
							`  ${e.status === 'pass' ? 'PASS' : 'FAIL'} ${String(e.name ?? '')} (${secs}s)${e.error ? `: ${String(e.error)}` : ''}`,
							needles
						)
					);
				} else if (e.type === 'log') log(redact(`  ${String(e.text ?? '')}`, needles));
			} catch {
				/* Not an event */
			}
		}
	});
	let stderr = redact(run.stderr, needles);
	// A link made during the run is as bad as one made before it: nothing the check wrote is read
	const planted = [job.runDir, scriptsRoot].map((d) => findLink(d)).find(Boolean);
	if (planted) {
		log('A link appeared in a folder the check may use, so what it wrote was not read.');
		stderr = `A link appeared in the run folder (${basename(planted)}). ${stderr}`.slice(-4000);
		return { exitCode: run.exitCode, stderr, result: null };
	}
	const file = join(job.runDir, 'result.json');
	let result: ChildResult | null = null;
	if (existsSync(file)) {
		const read = readPlainFile(job.runDir, 'result.json', { maxBytes: MAX_RESULT_BYTES });
		if ('refused' in read) log(`The result file of the check was not read: ${read.refused}.`);
		else {
			try {
				result = cleanResult(
					JSON.parse(read.bytes.toString('utf8')),
					needles,
					join(job.runDir, 'shots')
				);
			} catch {
				result = null;
			}
		}
	}
	if (run.timedOut) log('The check ran for 5 minutes and was stopped.');
	return { exitCode: run.exitCode, stderr, result };
}
