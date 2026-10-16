// THE HOSTED RUNNER SUPERVISOR: ONE THROWAWAY, LOCKED DOWN CONTAINER PER RUN (SPEC 10, L1)
// The supervisor holds the runner token and takes a run itself. It then starts a fresh container for that one run and hands it the
// run key and the job on standard input, so neither is in the environment or the command line a script could read. The runner
// token never enters the container: a script that ran there could otherwise take other projects' runs and read their test
// accounts. The container has no volume, a read only file system, no capabilities, limited memory, CPU and processes, and a
// deadline after which the supervisor kills it. Which networks it can reach is the operator's firewall (docs).

// -- DEP-MODULES -- //
import { spawn } from 'node:child_process';
// -- MODULES -- //
import type { RunnerApi } from './api';

// -- TYPES -- //

export type ContainerOptions = {
	image: string;
	name: string;
	server: string;
	/** A docker network that reaches the board and the sites under test but not your private network. */
	network?: string;
	memory?: string;
	cpus?: string;
	/** Where a hosted run gets the project's code, when its build command needs it. */
	repoUrl?: string;
	repoRef?: string;
};

// -- FUNCTIONS -- //

/**
 * The arguments of `docker run` for one run. Standard input stays open (-i) to carry the run key and the job. The server
 * address is the only setting in the environment.
 */
export function dockerArgs(o: ContainerOptions): string[] {
	const env = ['-e', `AFB_SERVER_URL=${o.server}`];
	if (o.repoUrl) env.push('-e', `AFB_REPO_URL=${o.repoUrl}`);
	if (o.repoRef) env.push('-e', `AFB_REPO_REF=${o.repoRef}`);
	return [
		'run',
		'--rm',
		'-i',
		'--name',
		o.name,
		'--read-only',
		'--tmpfs',
		'/tmp:rw,size=1g',
		'--tmpfs',
		'/home/pwuser:rw,size=512m',
		'--cap-drop',
		'ALL',
		'--security-opt',
		'no-new-privileges',
		'--pids-limit',
		'512',
		'--memory',
		o.memory ?? '2g',
		'--cpus',
		o.cpus ?? '2',
		...(o.network ? ['--network', o.network] : []),
		...env,
		o.image,
		'start',
		'--hosted',
		'--stdin-job'
	];
}

/** A container is killed this long after it starts, a little after the server gives up on a run. */
const DEADLINE_MS = 35 * 60_000;

/** Takes waiting runs one at a time and starts one container for each, until stopped. */
export async function supervise(opts: {
	api: RunnerApi;
	container: Omit<ContainerOptions, 'name'>;
	intervalMs: number;
	log: (line: string) => void;
	stopped: () => boolean;
	deadlineMs?: number;
}) {
	let n = 0;
	let backoff = opts.intervalMs;
	while (!opts.stopped()) {
		let taken: Awaited<ReturnType<RunnerApi['claimWithKey']>> | null = null;
		try {
			taken = await opts.api.claimWithKey();
		} catch (e) {
			opts.log(`Cannot reach the server: ${(e as Error).message}`);
		}
		if (taken?.job && !taken.runKey) {
			// The server has no master key, so no container can be given the run: it is handed back, not left held
			opts.log(
				'The server cannot make a key for this run (AFB_MASTER_KEY is not set). Giving the run back.'
			);
			await opts.api.release().catch(() => undefined);
			await new Promise((r) => setTimeout(r, Math.max(opts.intervalMs, 15_000)));
			continue;
		}
		if (taken?.job && taken.runKey) {
			const { job, runKey } = taken;
			const name = `afb-run-${Date.now().toString(36)}-${++n}`;
			opts.log(`Taking ${job.kind} ${job.id.slice(0, 8)}. Starting ${name}`);
			const started = Date.now();
			await new Promise<void>((resolve) => {
				const child = spawn('docker', dockerArgs({ ...opts.container, name }), {
					stdio: ['pipe', 'inherit', 'inherit']
				});
				const kill = setTimeout(() => {
					opts.log(`${name} ran past its deadline and is being stopped.`);
					spawn('docker', ['kill', name], { stdio: 'ignore' });
				}, opts.deadlineMs ?? DEADLINE_MS);
				// The runner stays Online while its container works, which can take many minutes
				const beat = setInterval(() => void opts.api.peek().catch(() => undefined), 30_000);
				child.stdin.on('error', () => undefined);
				child.stdin.end(JSON.stringify({ server: opts.container.server, runKey, job }) + '\n');
				child.on('close', () => {
					clearTimeout(kill);
					clearInterval(beat);
					resolve();
				});
				child.on('error', (e) => {
					clearTimeout(kill);
					clearInterval(beat);
					opts.log(`Docker did not start: ${e.message}`);
					resolve();
				});
			});
			// A container that stopped without reporting leaves its run held, so it is given back, not left until it times out
			await opts.api.release().catch(() => undefined);
			// A container that dies at once (a missing image) must not turn this into a tight loop
			if (Date.now() - started < 5000) {
				backoff = Math.min(backoff * 2, 60_000);
				await new Promise((r) => setTimeout(r, backoff));
			} else backoff = opts.intervalMs;
			continue;
		}
		backoff = opts.intervalMs;
		await new Promise((r) => setTimeout(r, opts.intervalMs));
	}
}
