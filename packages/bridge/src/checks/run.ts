// `check run <item> <key>`: ASK FOR THE RUN, CLAIM THAT RUN BY ITS ID, BUILD A PRIVATE PREVIEW, RUN THE CHECK IN A SANDBOX, REPORT
// The run is requested with the person's own sign in (the one the hooks and MCP use), claimed with this machine's runner token, and finished
// with it. The folder is the repo the agent is in: running a check there is the approval of that folder for `check watch`.

// -- DEP-MODULES -- //
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// -- TYPES -- //
import type { Fetch } from '../device.js';
import type { ChildJob, ChildResult } from './types.js';
import type { CheckJob, RunReport } from './board.js';
// -- MODULES -- //
import { appendAudit, verifyAudit } from './audit.js';
import { bindFolder } from './bind.js';
import { BoardError, RunnerBoard } from './board.js';
import { ensureBrowser, launchBrowserServer } from './browser.js';
import { lintCheck } from './guard.js';
import { assertName, ORG_SLUG, runsDir, scriptPath, scriptsDir } from './paths.js';
import { startPreview } from './preview.js';
import { redact } from './redact.js';
import { pinFiles, resolveProjectConfig } from './recipe.js';
import { runCheckInSandbox } from './sandbox.js';
import { installSignalHandlers, RunScope, sweepOrphans } from './scope.js';
import { signInWithPassword, stateNeedles } from './signin.js';

// -- TYPES -- //

export type RunOptions = {
	server: string;
	org: string;
	item: string;
	key: string;
	/** The repo folder: the current directory unless --dir says otherwise. */
	dir: string;
	/** The plan step to close when the run passes, for example 7.3. */
	step?: string;
	/** A run the agent already asked for (check_run through MCP). Without it the run is requested here. */
	runId?: string;
	/** A run `check watch` already claimed with the next-run call. Without it the run is claimed here by its id. */
	claimed?: CheckJob;
	/** The runner token of this machine, from `check connect`. */
	runnerToken: string;
	/** The person's own sign in, used only to ask for the run. */
	personalToken: string | null;
	fetch: Fetch;
	log: (line: string) => void;
	headed?: boolean;
};

export type RunOutcome = {
	/** 0 pass, 1 fail, 2 could not run. */
	exitCode: 0 | 1 | 2;
	runId: string | null;
	resultPath: string | null;
	message: string;
};

// -- CONSTANTS -- //

const BEAT_EVERY_MS = 30_000;
const MAX_EVIDENCE = 8;

// -- FUNCTIONS -- //

/** The slots header: this process takes one run at a time. */
const slotsHeader = (busy: number) => `1:${busy}`;

function auditHeaders(): Record<string, string> {
	try {
		const v = verifyAudit();
		return v.ok ? { 'x-afb-tool-audit': `${v.lines}:${v.head}` } : {};
	} catch {
		return {};
	}
}

/** Asks the board for a preview run of this check. Returns the run id, or throws one plain sentence. */
export async function requestRunOnBoard(
	o: Pick<RunOptions, 'server' | 'org' | 'item' | 'key' | 'step' | 'personalToken' | 'fetch'>
): Promise<string> {
	if (!o.personalToken)
		throw new Error(
			`Not signed in to ${o.org} on ${o.server}, so the run cannot be asked for. Run: agent-flow-board login --json --server ${o.server} --org ${o.org}, or ask for the run with check_run and pass --run <id>.`
		);
	const res = await o.fetch(
		`${o.server}/api/v1/orgs/${encodeURIComponent(o.org)}/items/${encodeURIComponent(o.item)}/browser-checks/runs`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${o.personalToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				check: o.key,
				target: 'preview',
				...(o.step ? { step: o.step } : {})
			}),
			signal: AbortSignal.timeout(30_000)
		}
	);
	const body = (await res.json().catch(() => ({}))) as {
		run?: { id?: string } | null;
		unavailable?: boolean;
		error?: { message?: string };
	};
	if (!res.ok)
		throw new Error(
			body.error?.message ?? `The board answered ${res.status} when asking for the run.`
		);
	if (!body.run?.id)
		throw new Error(
			'The board has no machine online for this project. Run: agent-flow-board check connect --server <url> --org <slug> --json'
		);
	return body.run.id;
}

/** Up to MAX_EVIDENCE pictures, the last one always kept. */
function pickShots(steps: ChildResult['steps']) {
	const wanted = steps.filter((s) => s.shot);
	return wanted.length > MAX_EVIDENCE
		? [...wanted.slice(0, MAX_EVIDENCE - 1), wanted[wanted.length - 1]]
		: wanted;
}

/** Runs one check end to end. Never throws: every failure is an outcome with a plain message. */
export async function runCheck(o: RunOptions): Promise<RunOutcome> {
	let lastStop = '';
	let finished = false;
	const stop = (message: string, runId: string | null = null): RunOutcome => {
		lastStop = message;
		return { exitCode: 2, runId, resultPath: null, message };
	};
	let runId: string | null = null;
	let board: RunnerBoard | null = null;
	let scope: RunScope | null = null;
	let beat: ReturnType<typeof setInterval> | null = null;
	let uninstall: () => void = () => undefined;
	let claimed = false;
	try {
		if (o.claimed) claimed = true;
		if (!ORG_SLUG.test(o.org))
			return stop('--org takes an organisation slug: lowercase letters, digits and dashes.');
		assertName(o.item, 'item reference');
		assertName(o.key, 'check key');
		// -- THE FOLDER AND THE SCRIPT -- //
		const cfg = resolveProjectConfig(o.dir);
		const script = scriptPath(o.org, o.item, o.key);
		if (!existsSync(script))
			return stop(
				`There is no check file for ${o.item} ${o.key} at ${script}. Write it there, or read the board's copy with: agent-flow-board check pull ${o.item} ${o.key} --org ${o.org}`
			);
		const source = readFileSync(script, 'utf8');
		const unsafe = lintCheck(source);
		if (unsafe.length)
			return stop(
				`This check uses ${unsafe.join(', ')}, which a check has no business doing, so it was not run. Rewrite it.`
			);
		// Running a check in a folder is the approval of that folder (and of the files that decide what runs) for `check watch`
		const projectKey = /^([A-Z][A-Z0-9]{1,9})-\d{8}-\d{4}/.exec(o.item)?.[1];
		if (projectKey) bindFolder(o.org, projectKey, cfg.repo, pinFiles(cfg.repo));
		// -- THE RUN -- //
		board = new RunnerBoard(o.server, o.runnerToken, o.fetch, () => ({
			'x-afb-tool-slots': slotsHeader(claimed ? 1 : 0),
			...auditHeaders()
		}));
		await sweepOrphans(o.log);
		runId = o.claimed?.id ?? o.runId ?? (await requestRunOnBoard(o));
		const job: CheckJob | null = o.claimed ?? (await board.claim(runId));
		if (!job)
			return stop(
				`The board did not give this machine the run ${runId}. It is not queued for this machine, or this machine does not serve that project (check connect --project), or another tool took it.`,
				runId
			);
		claimed = true;
		appendAudit('run-claimed', { run: runId });
		if (job.item.ref !== o.item || job.check.key !== o.key) {
			await board.release([runId]).catch(() => undefined);
			claimed = false;
			return stop(
				`The run ${runId} is for ${job.item.ref} ${job.check.key}, not ${o.item} ${o.key}, so it was given back.`,
				runId
			);
		}
		const thisBoard = board;
		const thisRun = runId;
		const abort = new AbortController();
		beat = setInterval(() => {
			thisBoard.beat(thisRun).catch((e) => {
				// The board gave up on the run: stop working on it
				if (e instanceof BoardError && e.status === 409) abort.abort();
			});
		}, BEAT_EVERY_MS);
		beat.unref();
		scope = new RunScope(runId, o.log);
		scope.start();
		const thisScope = scope;
		uninstall = installSignalHandlers(scope, () => {
			void thisBoard
				.finish(thisRun, { result: 'error', reason: 'The run was stopped before it finished.' })
				.catch(() => undefined)
				.finally(() => process.exit(2));
		});
		await ensureBrowser(o.log);
		const preview = await startPreview(cfg, { runId, scope, log: o.log });
		if (preview.note) o.log(preview.note);
		// -- SIGN IN AS THE RECIPE'S TEST USER -- //
		let state: unknown = null;
		if (preview.testUser) {
			o.log(`Signing in as ${preview.testUser.email.replace(/^(.).*(@.*)$/, '$1***$2')}...`);
			state = await signInWithPassword(preview.baseUrl, preview.testUser);
		}
		const needles = [
			...preview.secrets,
			...(preview.testUser ? [preview.testUser.password, preview.testUser.email] : []),
			...stateNeedles(state)
		];
		const runDir = join(runsDir(), runId);
		const browser = await launchBrowserServer({ headed: o.headed });
		thisScope.add('browser', () => browser.close());
		const childJob: ChildJob = {
			baseUrl: preview.baseUrl,
			ws: browser.wsEndpoint(),
			storageState: state,
			checkFile: script,
			runDir,
			viewport: { width: 1280, height: 800 },
			extraHosts: [],
			needles
		};
		const ran = await runCheckInSandbox({
			job: childJob,
			scriptsRoot: scriptsDir(),
			log: o.log,
			signal: abort.signal
		});
		if (!ran.result) {
			const why = redact(ran.stderr || 'The check did not finish.', needles).slice(-1200);
			await board.finish(runId, {
				result: 'error',
				reason: `The check did not finish. ${why}`.slice(0, 1900)
			});
			finished = true;
			claimed = false;
			return stop(`The check did not finish. ${why}`, runId);
		}
		// -- REPORT -- //
		const ids: string[] = [];
		for (const s of pickShots(ran.result.steps)) {
			if (!s.shot) continue;
			const bytes = readFileSync(join(runDir, 'shots', s.shot));
			// A picture that holds a secret (found as bytes or text) is not uploaded
			if (needles.some((n) => n.length >= 6 && Buffer.from(bytes).includes(n))) {
				o.log('  A picture held a secret value, so it was not uploaded.');
				continue;
			}
			ids.push(
				await board.upload(runId, {
					filename: s.shot,
					caption: `${s.status === 'fail' ? 'Failed: ' : ''}${s.name}`.slice(0, 120),
					bytes
				})
			);
		}
		const result = ran.result;
		const report: RunReport = {
			result: result.result,
			durationMs: Math.min(result.durationMs, 24 * 3600 * 1000),
			url: preview.baseUrl.slice(0, 300),
			commit: preview.commit,
			diffHash: preview.diffHash,
			...(result.result === 'pass'
				? {}
				: { reason: redact(result.reason ?? 'The check failed.', needles).slice(0, 1900) }),
			...(preview.commit ? {} : { unverified: true }),
			log: redact(result.log, needles).slice(0, 390_000),
			evidence: ids
		};
		await board.finish(runId, report);
		finished = true;
		claimed = false;
		appendAudit('run-finished', { run: runId, result: result.result });
		return {
			exitCode: result.result === 'pass' ? 0 : 1,
			runId,
			resultPath: join(runDir, 'result.json'),
			message:
				result.result === 'pass'
					? 'The check passed.'
					: `The check failed: ${result.reason ?? 'see the log'}`
		};
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		if (board && runId && claimed) {
			await board
				.finish(runId, { result: 'error', reason: reason.slice(0, 1900) })
				.catch(() => undefined);
			finished = true;
			claimed = false;
		}
		return stop(reason, runId);
	} finally {
		if (beat) clearInterval(beat);
		uninstall();
		if (scope) await scope.close();
		// A run that `check watch` already claimed must never be left running when this ends early (no script, a changed folder, a refusal)
		if (o.claimed && !finished) {
			const b = board ?? new RunnerBoard(o.server, o.runnerToken, o.fetch);
			await b
				.finish(o.claimed.id, {
					result: 'error',
					reason: (lastStop || 'The run stopped early.').slice(0, 1900)
				})
				.catch(() => undefined);
		}
	}
}
