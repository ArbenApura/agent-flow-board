// `check watch`: TAKE QUEUED RUNS FROM EVERY CONNECTED BOARD (THE RUN BUTTON ON THE BOARD)
// One worker per machine. A queued run is taken only for a project that has a local binding (a folder where `check run` was used) and whose
// pinned files have not changed since: with none, the run ends "could not run" and the current directory is never a fallback.

// -- TYPES -- //
import type { Fetch } from '../device.js';
import type { TokenStore } from '../tokenStore.js';
import type { CheckJob } from './board.js';
// -- MODULES -- //
import { appendAudit } from './audit.js';
import { boundFolder, pinStatus } from './bind.js';
import { RunnerBoard } from './board.js';
import { listConnections } from './connections.js';
import { loadRunnerToken } from './connect.js';
import { machineLock } from './lock.js';
import { runCheck } from './run.js';
import { sweepOrphans } from './scope.js';

// -- CONSTANTS -- //

const POLL_MS = 5000;

// -- FUNCTIONS -- //

export type WatchOptions = {
	store: TokenStore;
	fetch: Fetch;
	log: (line: string) => void;
	parallel: number;
	/** Take what is queued now, finish it and return. */
	once: boolean;
	signal: AbortSignal;
};

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true }
		);
	});

/** Runs the worker until the signal aborts (or one pass with `once`). Returns how many runs it took. */
export async function watchChecks(o: WatchOptions): Promise<number> {
	const lock = machineLock('watch');
	if (!lock)
		throw new Error(
			'Another "check watch" is already running on this machine. Only one worker runs per machine.'
		);
	const slots = Math.max(1, Math.min(o.parallel, 8));
	const held = new Map<string, { board: RunnerBoard; done: Promise<void> }>();
	let taken = 0;
	try {
		await sweepOrphans(o.log);
		appendAudit('watch-start', { slots });
		do {
			// The connections are read again on every loop, so a new `check connect` is picked up without a restart
			for (const c of listConnections()) {
				if (held.size >= slots || o.signal.aborted) break;
				const token = loadRunnerToken(o.store, c.server, c.org);
				if (!token) continue;
				const board = new RunnerBoard(c.server, token, o.fetch, () => ({
					'x-afb-tool-slots': `${slots}:${held.size}`
				}));
				let job: CheckJob | null = null;
				try {
					if ((await board.peek()) > 0) job = await board.claimNext();
				} catch (e) {
					o.log(`${c.org}: ${e instanceof Error ? e.message : String(e)}`);
				}
				if (!job) continue;
				taken++;
				const claimed = job;
				const done = handle(o, c.server, c.org, token, claimed).finally(() =>
					held.delete(claimed.id)
				);
				held.set(claimed.id, { board, done });
			}
			if (o.once) break;
			await sleep(POLL_MS, o.signal);
		} while (!o.signal.aborted);
		await Promise.allSettled([...held.values()].map((h) => h.done));
		return taken;
	} finally {
		// Runs still held when the worker stops go back to the queue, only these, never another process's runs
		const byBoard = new Map<RunnerBoard, string[]>();
		for (const [id, h] of held) byBoard.set(h.board, [...(byBoard.get(h.board) ?? []), id]);
		for (const [board, ids] of byBoard) await board.release(ids).catch(() => undefined);
		appendAudit('watch-stop', { taken });
		lock.release();
	}
}

async function handle(
	o: WatchOptions,
	server: string,
	org: string,
	token: string,
	job: CheckJob
): Promise<void> {
	const board = new RunnerBoard(server, token, o.fetch);
	const fail = (reason: string) =>
		board.finish(job.id, { result: 'error', reason }).catch(() => undefined);
	const projectKey = job.project.key;
	const bound = boundFolder(org, projectKey);
	if (!bound)
		return void (await fail(
			`This machine has no folder for ${projectKey}. In the project's folder run: agent-flow-board check run ${job.item.ref} ${job.check.key} --org ${org}`
		));
	if (pinStatus(org, projectKey) !== 'ok')
		return void (await fail(
			`The files that decide what runs in ${bound.folder} changed since they were approved. In that folder run: agent-flow-board check run ${job.item.ref} ${job.check.key} --org ${org}`
		));
	o.log(`${org}: running ${job.item.ref} ${job.check.key} in ${bound.folder}`);
	const outcome = await runCheck({
		server,
		org,
		item: job.item.ref,
		key: job.check.key,
		dir: bound.folder,
		step: job.stepKey ?? undefined,
		claimed: job,
		runnerToken: token,
		personalToken: null,
		fetch: o.fetch,
		log: o.log
	});
	o.log(`${org}: ${job.item.ref} ${job.check.key}: ${outcome.message}`);
}
