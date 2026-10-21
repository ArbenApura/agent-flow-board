#!/usr/bin/env node
// agent-flow-board mcp --server <url> [--org <slug>]   forward MCP over stdio to the server (to /mcp/<slug> with --org)
// agent-flow-board login --server <url> [--org <slug>] sign in by device code
// agent-flow-board logout --server <url> [--org <slug>]
// agent-flow-board queue list | retry <id> | drop <id>
// agent-flow-board hook claude|antigravity|gemini [event]   one hook event from stdin, one JSON object to stdout
// agent-flow-board hooks print claude|antigravity|gemini [--org <slug>]   the settings to paste into the tool
// agent-flow-board git-hook install|uninstall|check          the warn-only post-commit hook

// -- DEP-MODULES -- //
import { join } from 'node:path';
import { runBridge } from './bridge.js';
import { ADAPTERS, runHook } from './hooks/adapters.js';
import { callHook } from './hooks/call.js';
import {
	checkCommit,
	installGitHook,
	lastCommitMessage,
	uninstallGitHook
} from './hooks/gitHook.js';
import { hookSettings } from './hooks/settings.js';
import { deviceLogin, type Fetch } from './device.js';
import { Queue } from './queue.js';
import { accountKey, configDir, pickStore } from './tokenStore.js';

// -- FUNCTIONS -- //

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const cmd = args[0];
const log = (s: string) => process.stderr.write(s + '\n');

function serverUrl(): string {
	const s = flag('--server') ?? process.env.AFB_SERVER;
	if (!s) {
		log('Say which server to use: --server https://board.example.com (or set AFB_SERVER).');
		process.exit(2);
	}
	return s.replace(/\/$/, '');
}

/** An organisation slug as the app writes it. Anything else is ignored by a hook and refused by the other commands. */
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;

/** The organisation this run is for (--org), or undefined for the plain server sign in as before. */
function orgFlag(strict = true): string | undefined {
	const o = flag('--org');
	if (o === undefined) return undefined;
	if (ORG_SLUG.test(o)) return o;
	if (strict) {
		log('--org takes an organisation slug: lowercase letters, digits and dashes.');
		process.exit(2);
	}
	return undefined;
}

const store = pickStore();
/**
 * The saved sign in for a server and organisation. Only the MCP bridge (legacy true) also tries an older sign in saved under the plain
 * host, because /mcp/<slug> answers 403 if it is the wrong organisation. Hooks have no such check, so they never borrow it.
 */
const tokenFor = (server: string, org?: string, legacy = false): string | null =>
	process.env.AFB_TOKEN ??
	store.get(accountKey(server, org)) ??
	(org && legacy ? store.get(accountKey(server)) : null);
const queue = new Queue(join(configDir(), 'queue.json'));
const fetchImpl: Fetch = (input, init) => fetch(input, init);

async function readStdin(): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	const text = Buffer.concat(chunks).toString('utf8').trim();
	try {
		return text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Asks the organisation's own address whether this sign in belongs to it. Only a 403 means another organisation. */
async function belongsToOrg(server: string, org: string, token: string): Promise<boolean> {
	try {
		const res = await fetchImpl(`${server}/mcp/${org}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${token}`
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
		});
		// Only a refusal means another organisation, or no valid sign in
		return res.status !== 403 && res.status !== 401;
	} catch {
		// The board cannot be reached right now: keep the sign in, the first call checks again
		return true;
	}
}

async function main() {
	if (cmd === 'hook') {
		// A hook prints exactly one JSON object and always exits 0, so it can never break the tool that runs it
		let out: Record<string, unknown> = {};
		try {
			const adapter = ADAPTERS[args[1] ?? ''];
			const server = (flag('--server') ?? process.env.AFB_SERVER ?? '').replace(/\/$/, '');
			if (adapter && server) {
				const token = tokenFor(server, orgFlag(false));
				out = await runHook(adapter, args[2] ?? '', await readStdin(), (event) =>
					callHook({ server, token, fetch: fetchImpl }, event)
				);
			}
		} catch {
			out = {};
		}
		process.stdout.write(JSON.stringify(out));
		return;
	}
	if (cmd === 'hooks' && args[1] === 'print') {
		const text = hookSettings(args[2] ?? '', serverUrl());
		if (!text) {
			log('Say which tool: claude, antigravity or gemini.');
			process.exit(2);
		}
		process.stdout.write(text + '\n');
		return;
	}
	if (cmd === 'git-hook') {
		const repo = flag('--dir') ?? process.cwd();
		if (args[1] === 'install') {
			const r = installGitHook(repo);
			log(r.created ? `Installed ${r.path}.` : `Already installed in ${r.path}.`);
		} else if (args[1] === 'uninstall') {
			log(uninstallGitHook(repo) ? 'Removed.' : 'Nothing to remove.');
		} else if (args[1] === 'check') {
			// Warn only: print the warning to the terminal and never fail the commit
			const warning = checkCommit(lastCommitMessage(repo));
			if (warning) log(warning);
		} else {
			log('Usage: agent-flow-board git-hook install|uninstall|check [--dir <repo>]');
			process.exit(2);
		}
		return;
	}
	if (cmd === 'queue') {
		const sub = args[1];
		if (sub === 'retry' && args[2])
			log(queue.retry(args[2]) ? 'Queued again.' : 'No such queued write.');
		else if (sub === 'drop' && args[2])
			log(queue.drop(args[2]) ? 'Dropped.' : 'No such queued write.');
		else
			for (const e of queue.list())
				log(
					`${e.id}  ${e.state.padEnd(6)}  ${e.name}  ${e.key}${e.reason ? `  held: ${e.reason}` : ''}`
				);
		return;
	}
	if (cmd === 'logout') {
		const server = serverUrl();
		const org = orgFlag();
		store.delete(accountKey(server, org));
		// An older sign in under the plain host may be what this organisation was using, so it goes too
		if (org) store.delete(accountKey(server));
		log('Signed out.');
		return;
	}
	if (cmd !== 'mcp' && cmd !== 'login') {
		log(
			'Usage: agent-flow-board mcp|login|logout --server <url>, or queue list|retry <id>|drop <id>'
		);
		process.exit(2);
	}
	const server = serverUrl();
	const org = orgFlag();
	const account = accountKey(server, org);
	const login = async () => {
		const r = await deviceLogin(server, fetchImpl, log);
		// The device approval lets the person choose the organisation, so it is checked against the one asked for before it is kept
		if (org && !(await belongsToOrg(server, org, r.token))) {
			throw new Error(
				`That sign in is for a different organisation than ${org}. It was not saved. Run the sign in again and choose ${org} when the approval page asks.`
			);
		}
		store.set(account, r.token);
		log('Signed in.');
		return r.token;
	};
	if (cmd === 'login') {
		await login();
		return;
	}
	await runBridge({
		server,
		org,
		fetch: fetchImpl,
		getToken: () => tokenFor(server, org, true),
		login,
		queue,
		stdin: process.stdin,
		stdout: process.stdout,
		log
	});
}

main().catch((e) => {
	log(String(e instanceof Error ? e.message : e));
	process.exit(1);
});
