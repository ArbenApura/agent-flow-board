#!/usr/bin/env -S node --import tsx
// afb-runner start --server <url> --token <afx_...> [--trust-running] [--repo <dir>] [--config <file>] [--state <dir>] [--interval <ms>]
//                  [--hosted | --trust-all] [--once] [--max-jobs <n>]
// afb-runner supervise --server <url> --token <afx_...> [--image afb-runner] [--network <docker network>] [--memory 2g] [--cpus 2]
//                      a hosted runner: one throwaway container per waiting run
// afb-runner approve [--yes]       show the commands and scripts waiting for the owner's yes, and approve or reject them
// afb-runner status                show what is approved and what is waiting
//
// A hosted container is started by the supervisor with --stdin-job: it reads one line of JSON (server, run key, job) from standard
// input, runs that one job with the run key and exits. It never holds the runner token.
//
// A local runner works in the folder you start it in (or --repo), reads afb.runner.json there, and asks its owner before it runs
// a command or a script it has not seen. A hosted runner (--hosted) runs in a throwaway container and needs no approval.
// The token is read from --token or AFB_RUNNER_TOKEN. It is never printed.

// -- DEP-MODULES -- //
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from '@playwright/test';
// -- MODULES -- //
import { ApiError, RunnerApi, type Job } from './api';
import { Approvals } from './approvals';
import { runCheckJob } from './checks';
import { loadConfig } from './config';
import { runShotsJob } from './shots';
import { supervise } from './supervisor';
import { Targets } from './targets';

// -- FUNCTIONS -- //

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const has = (name: string) => args.includes(name);
const say = (s: string) => process.stdout.write(s + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mode = has('--hosted') ? 'hosted' : has('--trust-all') ? 'trust-all' : 'local';
const state = resolve(flag('--state') ?? join(homedir(), '.afb-runner'));
const approvals = new Approvals(join(state, 'approvals.json'), mode);

/** Shows control and direction characters as visible escapes, so what the owner reads is what would run. */
/* eslint-disable no-control-regex -- finding control characters is the point of this pattern */
const visible = (text: string) =>
	text.replace(
		/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
		(c) => `\\u{${c.codePointAt(0)!.toString(16)}}`
	);

/* eslint-enable no-control-regex */

async function approve() {
	const list = approvals.pending();
	if (!list.length) return say('Nothing is waiting for approval.');
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	for (const e of list) {
		say(
			`\n${e.kind.toUpperCase()}  ${e.label}  (${e.at})\n${'-'.repeat(60)}\n${visible(e.text)}\n${'-'.repeat(60)}`
		);
		const yes = has('--yes') || /^y/i.test(await rl.question('Run this on this machine? [y/N] '));
		if (yes) approvals.approve(e.key);
		else approvals.reject(e.key);
		say(yes ? 'Approved.' : 'Rejected.');
	}
	rl.close();
}

/** For a hosted runner: gets the project's code into a throwaway folder. */
function checkoutHosted(): string {
	const url = process.env.AFB_REPO_URL;
	if (!url) return resolve(flag('--repo') ?? '.');
	const dir = mkdtempSync(join(tmpdir(), 'afb-repo-'));
	const r = spawnSync(
		'git',
		[
			'clone',
			'--depth',
			'1',
			...(process.env.AFB_REPO_REF ? ['--branch', process.env.AFB_REPO_REF] : []),
			url,
			dir
		],
		{ stdio: 'inherit' }
	);
	if (r.status !== 0) throw new Error('Could not get the project code from AFB_REPO_URL.');
	return dir;
}

/** The throwaway container of a hosted run: one job from standard input, one run key, then exit. */
async function startFromStdin() {
	let text = '';
	for await (const chunk of process.stdin) text += chunk;
	const input = JSON.parse(text.trim()) as { server: string; runKey: string; job: Job };
	if (!input.server || !input.runKey || !input.job)
		throw new Error('The job on standard input is incomplete.');
	const repo = checkoutHosted();
	// The clone address may carry a credential, and a script runs in this process
	delete process.env.AFB_REPO_URL;
	const config = loadConfig(repo, flag('--config'));
	const api = new RunnerApi(input.server, input.runKey);
	const targets = new Targets(repo, config, approvals, (l) => say(l));
	const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
	const deps = { api, browser, targets, approvals, config, log: (l: string) => say(l) };
	try {
		const job = input.job;
		say(`Running ${job.kind} ${job.id.slice(0, 8)} for ${job.project.key}`);
		if (job.kind === 'check') await runCheckJob(job, deps);
		else await runShotsJob(job, deps, repo);
		say('Finished.');
	} finally {
		targets.stopAll();
		await browser.close().catch(() => undefined);
	}
}

async function start() {
	if (has('--stdin-job')) return startFromStdin();
	const server = flag('--server') ?? process.env.AFB_SERVER_URL;
	const token = flag('--token') ?? process.env.AFB_RUNNER_TOKEN;
	if (!server || !token) {
		say(
			'Give the server and the runner token: --server https://board.example.com --token afx_... (or AFB_SERVER_URL and AFB_RUNNER_TOKEN).'
		);
		process.exit(2);
	}
	if (mode === 'trust-all')
		say(
			'Warning: --trust-all runs every command and script without asking. Use it only in tests and CI.'
		);
	const repo = mode === 'hosted' ? checkoutHosted() : resolve(flag('--repo') ?? '.');
	const config = loadConfig(repo, flag('--config'));
	if (has('--trust-running')) config.trustRunning = true;
	const api = new RunnerApi(server, token);
	// A script runs in this process, so the token is kept out of its reach as far as the platform allows
	delete process.env.AFB_RUNNER_TOKEN;
	const targets = new Targets(repo, config, approvals, (l) => say(l));
	const browser = await chromium.launch({
		headless: true,
		args: mode === 'hosted' ? ['--no-sandbox'] : []
	});
	const deps = { api, browser, targets, approvals, config, log: (l: string) => say(l) };
	let stop = false;
	const shutdown = async () => {
		stop = true;
		targets.stopAll();
		await browser.close().catch(() => undefined);
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	const interval = Number(flag('--interval') ?? 3000);
	const maxJobs = Number(flag('--max-jobs') ?? 0);
	let done = 0;
	try {
		// Runs this runner held when it last stopped are given back, so they are not stuck until they time out
		const back = await api.release();
		if (back)
			say(`Gave back ${back} run${back === 1 ? '' : 's'} from the last time this runner stopped.`);
		say(`Runner ready (${mode}). Working in ${repo}`);
		while (!stop) {
			let job;
			try {
				job = await api.claim();
			} catch (e) {
				if (e instanceof ApiError && e.status === 401) throw e;
				say(`Cannot reach the server: ${(e as Error).message}`);
				await sleep(5000);
				continue;
			}
			if (!job) {
				if (has('--once')) break;
				await sleep(interval);
				continue;
			}
			say(
				`Taking ${job.kind} ${job.id.slice(0, 8)} for ${job.project.key}${'item' in job && job.item ? ` ${job.item.ref}` : ''}`
			);
			if (job.kind === 'check') await runCheckJob(job, deps);
			else await runShotsJob(job, deps, repo);
			say('Finished.');
			done++;
			if (maxJobs && done >= maxJobs) break;
		}
	} finally {
		targets.stopAll();
		await browser.close().catch(() => undefined);
	}
}

async function superviseCmd() {
	const server = flag('--server') ?? process.env.AFB_SERVER_URL;
	const token = flag('--token') ?? process.env.AFB_RUNNER_TOKEN;
	if (!server || !token) {
		say('Give the server and the runner token: --server https://board.example.com --token afx_...');
		process.exit(2);
	}
	const api = new RunnerApi(server, token);
	delete process.env.AFB_RUNNER_TOKEN;
	let stop = false;
	process.on('SIGINT', () => (stop = true));
	process.on('SIGTERM', () => (stop = true));
	say('Hosted runner supervisor ready. One container for each waiting run.');
	await supervise({
		api,
		container: {
			image: flag('--image') ?? 'afb-runner',
			server,
			network: flag('--network'),
			memory: flag('--memory'),
			cpus: flag('--cpus'),
			repoUrl: process.env.AFB_REPO_URL,
			repoRef: process.env.AFB_REPO_REF
		},
		intervalMs: Number(flag('--interval') ?? 5000),
		log: say,
		stopped: () => stop
	});
}

async function main() {
	if (cmd === 'start') return start();
	if (cmd === 'supervise') return superviseCmd();
	if (cmd === 'approve') return approve();
	if (cmd === 'status') {
		const p = approvals.pending();
		say(
			p.length
				? `${p.length} waiting for approval:\n${p.map((e) => `  ${e.kind}  ${e.label}`).join('\n')}`
				: 'Nothing is waiting for approval.'
		);
		return;
	}
	say('Commands: start, supervise, approve, status. See the top of packages/runner/src/cli.ts.');
	process.exit(cmd ? 2 : 0);
}

main().catch((e) => {
	say(`The runner stopped: ${(e as Error).message}`);
	process.exit(1);
});
