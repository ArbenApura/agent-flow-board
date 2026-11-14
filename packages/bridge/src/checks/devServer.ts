// DEV SERVER LIFECYCLE (STEP A.2, AFB-20261113-1008)
// Reuses an already-answering dev server (never stopping or restarting it), or starts an approved sealed --start command
// with filtered env (envPolicy) and shell:false, owns it in RunScope, and stops its whole process tree on exit.

// -- DEP-MODULES -- //
import { spawn, type ChildProcess } from 'node:child_process';
// -- MODULES -- //
import { Refusal } from './approve.js';
import { cleanDevUrl, probeDevUrl } from './devPolicy.js';
import { buildDevEnv } from './envPolicy.js';
import { pathOf, programArgv } from './install.js';
import { waitReady } from './preview.js';
import { needlesFromEnv, redact } from './redact.js';
import { verifyDevConfigApproval, verifySealedDevCommand } from './registry.js';
import { type RunScope, killTree } from './scope.js';
import type { Registration } from './types.js';

// -- TYPES -- //

export type DevServerResult = {
	origin: string;
	owned: boolean;
	pid?: number;
};

export type DevServerErrorCode =
	| 'DEV_URL_UNREACHABLE'
	| 'DEV_CROSS_HOST_REDIRECT'
	| 'DEV_START_FAILED'
	| 'DEV_START_TIMEOUT'
	| 'ABORTED';

export class DevServerError extends Refusal {
	readonly code: DevServerErrorCode;
	readonly fixLine: string;

	constructor(code: DevServerErrorCode, message: string, fixLine: string) {
		super(`${message} Fix: ${fixLine}`);
		this.code = code;
		this.fixLine = fixLine;
	}
}

export type DevServerOptions = {
	cwd?: string;
	log?: (line: string) => void;
	signal?: AbortSignal;
	waitTimeoutMs?: number;
	/** Optional untrusted payload guard test hook; passed to verifySealedDevCommand so board payloads can never supply startCommand. */
	untrustedBoardPayload?: unknown;
	probeFn?: typeof fetch;
	spawnFn?: typeof spawn;
};

// -- CONSTANTS -- //

const TAIL_LINES = 20;

// -- FUNCTIONS -- //

/**
 * Ensures the dev server for `reg` is answering.
 * If it already answers on `reg.devUrl`, reuses it and never stops or restarts it (announcing that once).
 * If nothing answers and sealed `startCommand` is present and hash-approved, starts it owned by `scope` and stops it when `scope` closes.
 */
export async function ensureDevServer(
	reg: Registration,
	scope: RunScope,
	opts: DevServerOptions = {}
): Promise<DevServerResult> {
	if (!reg.devUrl) {
		throw new DevServerError(
			'DEV_URL_UNREACHABLE',
			`Registration ${reg.name} has no dev URL.`,
			`Register it with: agent-flow-board check project ${reg.name} --org ${reg.org} --dev-url http://localhost:5173`
		);
	}
	const devUrl = cleanDevUrl(reg.devUrl);
	// Always verify devApprovalHash (and reject board-supplied execution fields) BEFORE reusing or starting.
	verifyDevConfigApproval(reg, opts.untrustedBoardPayload);
	const log = opts.log ?? (() => {});
	const probeFn = opts.probeFn ?? fetch;
	const initial = await probeDevUrl(devUrl, probeFn);
	if (initial.ok) {
		log(`Dev server at ${devUrl} is already answering; reusing it and leaving it running.`);
		return { origin: devUrl, owned: false };
	}
	if (initial.code === 'DEV_CROSS_HOST_REDIRECT') {
		throw new DevServerError(
			'DEV_CROSS_HOST_REDIRECT',
			initial.message,
			'Point --dev-url at an origin that does not redirect to another host or port.'
		);
	}

	const cmd = verifySealedDevCommand(reg, opts.untrustedBoardPayload);
	if (!cmd) {
		throw new DevServerError(
			'DEV_URL_UNREACHABLE',
			`Nothing answered at ${devUrl} and no --start command is sealed for ${reg.name}.`,
			`Start the dev server on ${devUrl}, or register with --start "<cmd>" and approve with check approve --action dev.`
		);
	}

	const parsed = new URL(devUrl);
	const port = Number(parsed.port);
	const cwd = reg.repo ?? opts.cwd ?? process.cwd();
	const filtered = buildDevEnv({
		repo: cwd,
		recipeEnv: {},
		port,
		baseUrl: devUrl,
		readRepoEnv: false
	});
	const needles = [...needlesFromEnv(process.env), ...needlesFromEnv(filtered.env)];
	const [file, ...args] = programArgv(cmd, { pathEnv: pathOf(filtered.env) });
	if (!file) {
		throw new DevServerError(
			'DEV_START_FAILED',
			'Dev server start command has no executable program.',
			'Re-register --start with a valid executable command.'
		);
	}

	const spawnImpl = opts.spawnFn ?? spawn;
	const child: ChildProcess = spawnImpl(file, args, {
		cwd,
		env: filtered.env,
		shell: false,
		detached: process.platform !== 'win32',
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let exited = false;
	const tail: string[] = [];
	const pushTail = (buf: Buffer) => {
		for (const line of buf.toString('utf8').split(/\r?\n/)) {
			const clean = redact(line, needles).trimEnd();
			if (!clean) continue;
			tail.push(clean);
			if (tail.length > TAIL_LINES) tail.shift();
		}
	};
	child.stdout?.on('data', pushTail);
	child.stderr?.on('data', pushTail);
	child.once('error', (err) => {
		exited = true;
		const cleanErr = redact(err instanceof Error ? err.message : String(err), needles).trimEnd();
		if (cleanErr) tail.push(cleanErr);
	});
	child.once('exit', () => {
		exited = true;
	});

	const pid = child.pid;
	if (pid) {
		scope.setInfo({ previewPid: pid });
		scope.add('dev server', async () => {
			if (!exited) await killTree(pid);
		});
	}

	const state = await waitReady(devUrl, {
		timeoutMs: opts.waitTimeoutMs ?? 30_000,
		exited: () => exited,
		intervalMs: 150,
		signal: opts.signal
	});
	if (state !== 'ready') {
		if (pid && !exited) await killTree(pid);
		const tailNote = tail.length ? ` Output: ${tail.slice(-5).join(' | ')}` : '';
		if (state === 'aborted') {
			throw new DevServerError(
				'ABORTED',
				`Aborted while starting the dev server for ${reg.name}.${tailNote}`,
				'Re-run the check when ready.'
			);
		}
		if (state === 'exited') {
			throw new DevServerError(
				'DEV_START_FAILED',
				`The dev server command for ${reg.name} exited before answering on ${devUrl}.${tailNote}`,
				`Check the dev command for ${reg.name} locally, then run the check again.`
			);
		}
		throw new DevServerError(
			'DEV_START_TIMEOUT',
			`Timed out waiting for the dev server for ${reg.name} to answer on ${devUrl}.${tailNote}`,
			`Verify the command serves ${devUrl} and re-run the check.`
		);
	}

	const verify = await probeDevUrl(devUrl, probeFn);
	if (!verify.ok && verify.code === 'DEV_CROSS_HOST_REDIRECT') {
		if (pid && !exited) await killTree(pid);
		throw new DevServerError(
			'DEV_CROSS_HOST_REDIRECT',
			verify.message,
			'Point --dev-url at an origin that does not redirect to another host or port.'
		);
	}

	log(
		`Started owned dev server at ${devUrl}${pid ? ` (pid ${pid})` : ''}; it will stop when the run ends.`
	);
	return { origin: devUrl, owned: true, ...(pid ? { pid } : {}) };
}
