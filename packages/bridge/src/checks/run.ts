// `check run <item> <key>`: ASK FOR THE RUN, CLAIM THAT RUN BY ITS ID, BUILD A PRIVATE PREVIEW, RUN THE CHECK IN A SANDBOX, REPORT
// The run is requested with the person's own sign in (the one the hooks and MCP use), claimed with this machine's runner token, and finished
// with it. The folder is the repo the agent is in: running a check there is the approval of that folder for `check watch`.

// -- DEP-MODULES -- //
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
// -- TYPES -- //
import type { Fetch } from '../device.js';
import type { ChildJob, ChildResult, ProjectConfig, Registration } from './types.js';
import type { CheckJob, RunReport } from './board.js';
// -- MODULES -- //
import { appendAudit, verifyAudit } from './audit.js';
import { bindFolder } from './bind.js';
import { BoardError, RunnerBoard } from './board.js';
import { ensureBrowser } from './browser.js';
import { acquireBrowser } from './browserpool.js';
import { JPEG_MAGIC, MAX_SHOT_BYTES, readPlainFile } from './evidence.js';
import { acquireSlot, slotsHeader } from './broker.js';
import { closePoolIfIdle } from './dbpool.js';
import { lintCheck } from './guard.js';
import { assertName, ORG_SLUG, runsDir, scriptPath, scriptsDir } from './paths.js';
import { liveSiteGuardOptions } from './live.js';
import { pictureUploadAllowed } from './login.js';
import { startPreview } from './preview.js';
import { redact } from './redact.js';
import { pinFiles, resolveProjectConfig } from './recipe.js';
import {
	configFor,
	listRegistrations,
	pinRegistration,
	pinState,
	readRegistrations
} from './registry.js';
import { profileHeader, registrationHeader, routeRun } from './routing.js';
import { chooseSignin, sealedKey } from './signinChoice.js';
import { registrationsHeader, sanitiseReport, withBranch } from './wire.js';
import { runCheckInSandbox } from './sandbox.js';
import { installSignalHandlers, newLocalRunId, RunScope, sweepOrphans } from './scope.js';
import { signInWithPassword, stateNeedles } from './signin.js';
import { LocalSink, type BoardLike } from './localSink.js';
import { lockHolderPid } from './lock.js';

// -- TYPES -- //

export type RunOptions = {
	/**
	 * 'board' (the default) asks the board for the run and reports to it. 'local' runs the script with the same sandbox, preview, sign-in and guard rails and makes NO board call:
	 * it needs no connection, no token and no server (the three fields below are empty and never used), and it needs the registration by name.
	 */
	mode?: 'board' | 'local';
	server: string;
	org: string;
	item: string;
	key: string;
	/** The repo folder: the current directory unless --dir says otherwise. */
	dir: string;
	/** The plan step to close when the run passes, for example 7.3. */
	step?: string;
	/** True for a run the worker's scheduler holds: it has the slot and beats the board itself. */
	scheduled?: boolean;
	/** Aborts the run (a stopped worker, a run over its limit, a run the board gave up on). */
	signal?: AbortSignal;
	/** The registration to use, when the run and the check name none (`--registration`). */
	registration?: string;
	/** The saved sign-in to open with (`--profile`). A script may ask for one with "// afb-profile: NAME"; otherwise the default profile is used. */
	profile?: string;
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
/** A run started by hand (not by the worker, whose scheduler has its own limit) stops after this long. */
const DEFAULT_RUN_LIMIT_MS = 40 * 60_000;

// -- FUNCTIONS -- //

/** The run limit of a standalone run in ms: AFB_CHECKS_RUN_LIMIT_MS when it is a positive number, else 40 minutes. */
export function runLimitMs(env: Record<string, string | undefined> = process.env): number {
	const v = Number(env.AFB_CHECKS_RUN_LIMIT_MS);
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_RUN_LIMIT_MS;
}

/** The sentence for a run stopped by its limit. */
export function limitSentence(ms: number): string {
	return ms < 60_000
		? `The run took longer than ${Math.round(ms / 1000)} seconds and was stopped.`
		: `The run took longer than ${Math.round(ms / 60_000)} minutes and was stopped.`;
}

/** Writes an audit line, and never lets a failure of the log change the outcome of a run. */
function auditSafely(
	log: (line: string) => void,
	action: string,
	detail: Record<string, string | number | boolean>
): void {
	try {
		appendAudit(action, detail);
	} catch {
		log('The audit log could not be written for this run.');
	}
}

/** The registrations of this organisation, for the board to route a run that names one (at most 16, refreshed by every call). */
export function registrationsHeaderFor(org: string): Record<string, string> {
	try {
		const value = registrationsHeader(org, listRegistrations(org).map(withBranch));
		return value ? { 'x-afb-tool-registrations': value } : {};
	} catch {
		return {};
	}
}

/**
 * The registration of a run: the one the board names, else the one asked for with --registration, else the check script's own header, else the board
 * project's only registration. With none registered for the board project the folder of the current directory is used, as before registrations existed.
 */
export function configForRun(
	o: Pick<RunOptions, 'org' | 'dir' | 'registration'>,
	job: CheckJob,
	source: string,
	log: (line: string) => void,
	fromWatch: boolean
): { cfg: ProjectConfig; registration: Registration | null; scriptRegistration: string | null } {
	const read = readRegistrations(o.org);
	const all = read.registrations;
	const mine = all.filter((r) => r.boardProject === job.project.key);
	if (!mine.length) {
		// A registration that is damaged or was changed by hand is not "no registration": the folder of the current directory is never taken in its place
		if (read.problems.length)
			throw new Error(
				`${read.problems.join(' ')} No other registration serves ${job.project.key}, so the run was not started. Register the project again with: agent-flow-board check project`
			);
		const cfg = resolveProjectConfig(o.dir);
		// Running a check in a folder is the approval of that folder (and of the files that decide what runs) for `check watch`
		bindFolder(o.org, job.project.key, cfg.repo, pinFiles(cfg.repo));
		return { cfg, registration: null, scriptRegistration: null };
	}
	const registration = routeRun({
		org: o.org,
		boardProject: job.project.key,
		run: job.registration ?? o.registration ?? null,
		script: source,
		all
	});
	if (registration.repo) {
		if (fromWatch) {
			// The board's Run button never re-approves: a changed or missing pin needs a `check run` in the folder first
			if (pinState(registration) !== 'ok')
				throw new Error(
					`The files that decide what runs in ${registration.name} changed since they were approved. In that folder run: agent-flow-board check run <item> <key> --org ${o.org}`
				);
		} else {
			const pin = pinRegistration(o.org, registration.name);
			if (pin.changed)
				log(
					`The files that decide what runs in ${registration.name} changed and were pinned again (${pin.files.length} files).`
				);
		}
	}
	return {
		cfg: configFor(registration),
		registration,
		scriptRegistration: registrationHeader(source)
	};
}

export function auditHeaders(): Record<string, string> {
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

/**
 * The registration of a local run, read straight from the registry: the one `--registration` names, else the one the script's header names. There is no board project and no
 * job to route by, so a missing name is refused with the list, and the folder of the current directory is never taken in its place. A changed pin stops the run (a board run
 * that `check watch` takes does the same); a local run never pins or binds a folder by itself.
 */
export function configForLocal(
	o: Pick<RunOptions, 'org' | 'registration'>,
	source: string
): { cfg: ProjectConfig; registration: Registration; scriptRegistration: string | null } {
	const scriptRegistration = registrationHeader(source);
	const wanted = o.registration ?? scriptRegistration;
	const mine = listRegistrations(o.org);
	const list = mine.map((r) => r.name).join(', ');
	if (!wanted)
		throw new Error(
			`A local run needs the registration: pass --registration NAME or put "// afb-registration: NAME" in the script. Registrations of ${o.org}: ${list || 'none'}.`
		);
	const registration = mine.find((r) => r.name.toLowerCase() === wanted.toLowerCase());
	if (!registration)
		throw new Error(
			`There is no registration ${wanted.slice(0, 40)} in ${o.org}. Registrations of ${o.org}: ${list || 'none'}.`
		);
	if (registration.repo && pinState(registration) !== 'ok')
		throw new Error(
			`The files that decide what runs in ${registration.name} changed since they were approved. Approve them again: agent-flow-board check project pin ${registration.name} --org ${o.org}`
		);
	return { cfg: configFor(registration), registration, scriptRegistration };
}

/** Runs one check end to end. Never throws: every failure is an outcome with a plain message. */
export async function runCheck(o: RunOptions): Promise<RunOutcome> {
	const local = o.mode === 'local';
	let lastStop = '';
	let finished = false;
	const stop = (message: string, runId: string | null = null): RunOutcome => {
		lastStop = message;
		return { exitCode: 2, runId, resultPath: null, message };
	};
	let runId: string | null = null;
	// The registration of this run once it is known: an error report names it too, so the board keeps the real reason instead of "the tool reported none"
	let runRegistration: string | undefined;
	let board: BoardLike | null = null;
	let scope: RunScope | null = null;
	let beat: ReturnType<typeof setInterval> | null = null;
	let uninstall: () => void = () => undefined;
	let claimed = false;
	let slot: { release(): void | Promise<void> } | null = null;
	// Everything the run must never print, filled in as it becomes known; the reasons that go to the board are redacted with it
	const needlesAll: string[] = [];
	let limitTimer: ReturnType<typeof setTimeout> | null = null;
	let limitHit = false;
	// A run the worker's scheduler holds is stopped, timed out or given up on by the scheduler, which gives it back or reports it by id
	const schedulerOwns = () => Boolean(o.scheduled && o.signal?.aborted);
	const reasonFor = (text: string) => redact(text, needlesAll).slice(0, 1900);
	try {
		if (o.claimed) claimed = true;
		if (!ORG_SLUG.test(o.org))
			return stop('--org takes an organisation slug: lowercase letters, digits and dashes.');
		assertName(o.item, 'item reference');
		assertName(o.key, 'check key');
		// -- THE FOLDER AND THE SCRIPT -- //
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
		// -- THE RUN -- //
		// A local run has a stand-in for the board that does nothing and has no address: no call can reach a network on any path of the run
		board = local
			? new LocalSink()
			: new RunnerBoard(o.server, o.runnerToken, o.fetch, () => ({
					'x-afb-tool-slots': slotsHeader(),
					...auditHeaders(),
					...registrationsHeaderFor(o.org)
				}));
		await sweepOrphans(o.log);
		let job: CheckJob | null = null;
		if (local) {
			runId = newLocalRunId();
			auditSafely(o.log, 'run-local-started', { run: runId, check: `${o.item}/${o.key}` });
		} else {
			runId = o.claimed?.id ?? o.runId ?? (await requestRunOnBoard(o));
			job = o.claimed ?? (await board.claim(runId));
			if (!job)
				return stop(
					`The board did not give this machine the run ${runId}. It is not queued for this machine, or this machine does not serve that project (check connect --project), or another tool took it.`,
					runId
				);
			claimed = true;
			auditSafely(o.log, 'run-claimed', { run: runId });
			if (job.item.ref !== o.item || job.check.key !== o.key) {
				await board.release([runId]).catch(() => undefined);
				claimed = false;
				return stop(
					`The run ${runId} is for ${job.item.ref} ${job.check.key}, not ${o.item} ${o.key}, so it was given back.`,
					runId
				);
			}
		}
		const thisBoard = board;
		const thisRun = runId;
		const abort = new AbortController();
		// A run the worker's scheduler holds is beaten (and limited) by the scheduler from the moment of its claim; its stop reaches this run through the signal
		if (o.signal) {
			if (o.signal.aborted) abort.abort();
			else o.signal.addEventListener('abort', () => abort.abort(), { once: true });
		}
		if (!o.scheduled) {
			beat = setInterval(() => {
				thisBoard.beat(thisRun).catch((e) => {
					// The board gave up on the run: stop working on it
					if (e instanceof BoardError && e.status === 409) abort.abort();
				});
			}, BEAT_EVERY_MS);
			beat.unref();
			// A run started by hand has the same limit the worker gives its runs
			const limit = runLimitMs();
			limitTimer = setTimeout(() => {
				limitHit = true;
				abort.abort();
			}, limit);
			limitTimer.unref();
		}
		scope = new RunScope(runId, o.log);
		scope.start();
		const thisScope = scope;
		// The worker's runs never install their own handlers: its stop reaches them through the signal, and each closes only its own scope. A handler per run
		// would finish every run as an error and end the whole process before the scheduler has given the others back
		if (!o.scheduled)
			uninstall = installSignalHandlers(scope, () => {
				void thisBoard
					.finish(thisRun, { result: 'error', reason: 'The run was stopped before it finished.' })
					.catch(() => undefined)
					.finally(() => process.exit(2));
			});
		// -- WHICH REGISTRATION, AND A PLACE ON THIS MACHINE -- //
		// A registration the board or the script names is chosen here, never guessed; a refusal ends the run with its code and the list
		const routed = job
			? configForRun(o, job, source, o.log, Boolean(o.claimed))
			: configForLocal(o, source);
		const cfg = routed.cfg;
		const registration = routed.registration;
		runRegistration = registration?.name;
		// The saved sign-in this run needs: --profile, else the script's "// afb-profile:" line, else the default. A named one that cannot be used ends the run before anything is built
		const wantedProfile = o.profile ?? profileHeader(source) ?? undefined;
		const signinNamed = Boolean(o.profile) || Boolean(wantedProfile) || Boolean(o.registration);
		if (registration && wantedProfile) {
			const early = chooseSignin({
				org: o.org,
				registration,
				scriptRegistration: routed.scriptRegistration,
				profile: wantedProfile,
				named: true,
				previewBaseUrl: registration.url ?? 'http://127.0.0.1',
				sealedHost: undefined
			});
			if (early.failure) throw new Error(early.failure);
		}
		// The heartbeat already runs, so a run that waits for a slot, the preflight or another run's build keeps beating and never looks stuck to the board
		// (a scheduled run already holds its slot)
		if (!o.scheduled)
			slot = await acquireSlot(
				{
					runId,
					kind: local ? 'local' : 'check',
					registration: registration?.name ?? job?.project.key ?? 'local'
				},
				{ signal: abort.signal }
			);
		await ensureBrowser(o.log);
		const preview = await startPreview(cfg, {
			runId,
			scope,
			log: o.log,
			signal: abort.signal,
			needles: needlesAll
		});
		needlesAll.push(...preview.secrets);
		if (preview.note) o.log(preview.note);
		// -- SIGN IN: A SAVED SIGN IN OF THIS REGISTRATION, ELSE THE RECIPE'S TEST USER -- //
		let state: unknown = null;
		// Only a sign in the owner SAVED counts for the picture rule: the recipe's test user belongs to a throwaway preview and holds nothing worth hiding
		let usedSavedSignIn = false;
		if (registration) {
			const choice = chooseSignin({
				org: o.org,
				registration,
				scriptRegistration: routed.scriptRegistration,
				profile: wantedProfile,
				named: signinNamed,
				previewBaseUrl: preview.baseUrl,
				sealedHost: sealedKey(preview.extraHosts),
				throwawayDatabase: preview.throwawayDatabase
			});
			if (choice.failure) throw new Error(choice.failure);
			state = choice.state;
			usedSavedSignIn = state !== null;
			if (choice.note) o.log(choice.note);
		}
		if (!state && preview.testUser) {
			o.log(`Signing in as ${preview.testUser.email.replace(/^(.).*(@.*)$/, '$1***$2')}...`);
			state = await signInWithPassword(preview.baseUrl, preview.testUser);
		}
		const needles = [
			...preview.secrets,
			...(preview.testUser ? [preview.testUser.password, preview.testUser.email] : []),
			...stateNeedles(state)
		];
		needlesAll.push(...needles);
		const runDir = join(runsDir(), runId);
		// The browser may reach this machine and the hosts of this registration only (a live site's hosts, the sealed test project's host); a live
		// site or a signed in run always has its own browser, and a live site never allows writes
		const extraHosts = [
			...new Set([
				...(cfg.url ? liveSiteGuardOptions(cfg).extraHosts : (cfg.extraHosts ?? [])),
				...(preview.extraHosts ?? [])
			])
		];
		const browser = await acquireBrowser({
			hosts: extraHosts,
			headed: o.headed,
			dedicated: Boolean(cfg.url) || state !== null
		});
		thisScope.add('browser', () => browser.release());
		const childJob: ChildJob = {
			baseUrl: preview.baseUrl,
			ws: browser.wsEndpoint(),
			storageState: state,
			checkFile: script,
			runDir,
			viewport: { width: 1280, height: 800 },
			extraHosts,
			needles
		};
		const ran = await runCheckInSandbox({
			job: childJob,
			scriptsRoot: scriptsDir(),
			log: o.log,
			signal: abort.signal
		});
		if (!ran.result) {
			const why = limitHit
				? limitSentence(runLimitMs())
				: redact(ran.stderr || 'The check did not finish.', needlesAll).slice(-1200);
			// A run the scheduler stopped is given back by the scheduler, not reported here
			if (!schedulerOwns()) {
				await board.finish(runId, {
					result: 'error',
					reason: reasonFor(`The check did not finish. ${why}`),
					registration: runRegistration
				});
				finished = true;
				claimed = false;
			}
			return stop(`The check did not finish. ${why}`, runId);
		}
		// -- REPORT -- //
		const ids: string[] = [];
		// Pictures of a signed in run are not uploaded unless the owner opted in for the registration: a compressed picture cannot be searched for a secret
		const uploadPictures = pictureUploadAllowed(
			registration ?? { uploadSignedInPictures: false },
			usedSavedSignIn
		);
		if (local) o.log(`The pictures stay on this machine, in ${join(runDir, 'shots')}.`);
		else if (!uploadPictures)
			o.log('The pictures of a signed in run are not uploaded for this registration.');
		for (const s of uploadPictures && !local ? pickShots(ran.result.steps) : []) {
			if (!s.shot) continue;
			// The child wrote this file, so it is only read when it is a plain JPEG inside the shots folder (never a link it planted to a key file)
			const read = readPlainFile(join(runDir, 'shots'), s.shot, {
				maxBytes: MAX_SHOT_BYTES,
				magic: JPEG_MAGIC
			});
			if ('refused' in read) {
				o.log(`  A picture was not uploaded: ${read.refused}.`);
				continue;
			}
			const bytes = read.bytes;
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
		const wire = registration ? withBranch(registration) : null;
		const report: RunReport = sanitiseReport({
			result: result.result,
			...(registration
				? {
						registration: registration.name,
						...(registration.repo ? { repoName: basename(registration.repo) } : {}),
						...(wire?.branch ? { branch: wire.branch } : {})
					}
				: {}),
			durationMs: Math.min(result.durationMs, 24 * 3600 * 1000),
			url: preview.baseUrl.slice(0, 300),
			commit: preview.commit,
			diffHash: preview.diffHash,
			...(result.result === 'pass'
				? {}
				: { reason: reasonFor(result.reason ?? 'The check failed.') }),
			...(preview.commit ? {} : { unverified: true }),
			log: redact(result.log, needlesAll).slice(0, 390_000),
			evidence: ids
		});
		// A run the scheduler stopped is given back by the scheduler: what it found is not reported
		if (schedulerOwns()) return stop('The run was stopped.', runId);
		await board.finish(runId, report);
		finished = true;
		claimed = false;
		auditSafely(o.log, local ? 'run-local-finished' : 'run-finished', {
			run: runId,
			result: result.result
		});
		const resultFile = join(runDir, 'result.json');
		return {
			exitCode: result.result === 'pass' ? 0 : 1,
			runId,
			// The last line `RESULT <path>` is printed only when the file is there
			resultPath: existsSync(resultFile) ? resultFile : null,
			message:
				result.result === 'pass'
					? 'The check passed.'
					: `The check failed: ${result.reason ?? 'see the log'}`
		};
	} catch (e) {
		const said = e instanceof Error ? e.message : String(e);
		const reason = limitHit ? limitSentence(runLimitMs()) : said;
		// Nothing that reaches the board is unredacted: not a build log tail, not the message of an error
		if (board && runId && claimed && !schedulerOwns()) {
			await board
				.finish(runId, {
					result: 'error',
					reason: reasonFor(reason),
					registration: runRegistration
				})
				.catch(() => undefined);
			finished = true;
		}
		return stop(reasonFor(reason), runId);
	} finally {
		if (beat) clearInterval(beat);
		if (limitTimer) clearTimeout(limitTimer);
		uninstall();
		if (scope) await scope.close();
		// The slot goes back to the machine, and a pool container that no run needs any more is removed (a worker keeps it warm)
		try {
			await slot?.release();
		} catch {
			/* A slot that cannot be released is cleared by its stale heartbeat */
		}
		// A local run never removes the pool a running worker keeps warm for its board runs
		const workerRuns = local && lockHolderPid('machine-watch') !== null;
		if (!o.claimed && !workerRuns) await closePoolIfIdle().catch(() => undefined);
		// A run that `check watch` already claimed must never be left running when this ends early (no script, a changed folder, a refusal)
		if (o.claimed && !finished && !schedulerOwns()) {
			const b = board ?? new RunnerBoard(o.server, o.runnerToken, o.fetch);
			await b
				.finish(o.claimed.id, {
					result: 'error',
					reason: reasonFor(lastStop || 'The run stopped early.')
				})
				.catch(() => undefined);
		}
	}
}
