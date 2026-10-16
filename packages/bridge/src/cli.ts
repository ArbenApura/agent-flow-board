#!/usr/bin/env node
// agent-flow-board mcp --server <url>   forward MCP over stdio to the server
// agent-flow-board login --server <url> sign in by device code
// agent-flow-board logout --server <url>
// agent-flow-board queue list | retry <id> | drop <id>
// agent-flow-board hook claude|antigravity|gemini [event]   one hook event from stdin, one JSON object to stdout
// agent-flow-board hooks print claude|antigravity|gemini    the settings to paste into the tool
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
import { configDir, pickStore } from './tokenStore.js';

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

const store = pickStore();
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

async function main() {
	if (cmd === 'hook') {
		// A hook prints exactly one JSON object and always exits 0, so it can never break the tool that runs it
		let out: Record<string, unknown> = {};
		try {
			const adapter = ADAPTERS[args[1] ?? ''];
			const server = (flag('--server') ?? process.env.AFB_SERVER ?? '').replace(/\/$/, '');
			if (adapter && server) {
				const token = process.env.AFB_TOKEN ?? store.get(new URL(server).host);
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
		store.delete(new URL(serverUrl()).host);
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
	const account = new URL(server).host;
	const login = async () => {
		const r = await deviceLogin(server, fetchImpl, log);
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
		fetch: fetchImpl,
		getToken: () => store.get(account),
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
