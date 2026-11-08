// CONNECTING THIS MACHINE TO A BOARD AS A CHECK RUNNER
// One device sign in under the client name afb-checks (an agent approves it with tool_connection_approve and the verifier, or a person types the
// code on the /device page), one call that makes this machine a runner of the organisation, then only the runner token is kept. The personal
// token is forgotten at once. The runner token has its own entry in the token store, apart from the sign in of the hooks and MCP.

// -- DEP-MODULES -- //
import { hostname } from 'node:os';
// -- TYPES -- //
import type { Fetch } from '../device.js';
import type { TokenStore } from '../tokenStore.js';
// -- MODULES -- //
import { deviceLogin } from '../device.js';
import { accountKey } from '../tokenStore.js';

// -- CONSTANTS -- //

/** The client name the board approves with the manage permission, used once to make the runner. */
export const TOOL_CLIENT_NAME = 'afb-checks';

// -- FUNCTIONS -- //

/** The token store entry of the runner token for a server and organisation. */
export const runnerAccount = (server: string, org: string) => `${accountKey(server, org)}.checks`;

/**
 * A name for this machine's runner. A repeat of the same owner and name replaces the old token on the board, so this name is different from the
 * one the standalone afb-checks tool uses on the same machine: connecting the bridge must never cut that tool off.
 */
export function runnerName(): string {
	const host =
		hostname()
			.replace(/[^A-Za-z0-9 ._-]/g, '')
			.slice(0, 36) || 'this-machine';
	return `${host} agent-flow-board`.slice(0, 60);
}

/** The runner token for a server and organisation, or null when this machine has not been connected. AFB_CHECKS_TOKEN overrides it, for tests. */
export function loadRunnerToken(store: TokenStore, server: string, org: string): string | null {
	return process.env.AFB_CHECKS_TOKEN ?? store.get(runnerAccount(server, org));
}

export type ConnectOptions = {
	server: string;
	org: string;
	/** Board project keys to serve. Left out, every project of the organisation the person may use. */
	projects?: string[];
	/** Print the code and verifier as one JSON line on stdout for an agent, and a second line when connected. */
	json: boolean;
	store: TokenStore;
	fetch: Fetch;
	log: (line: string) => void;
	out: (line: string) => void;
	/** Test hook: replaces the wait between polls. */
	wait?: (ms: number) => Promise<unknown>;
};

/** Makes this machine a runner of the organisation. Never prints a token. */
export async function connectChecks(
	options: ConnectOptions
): Promise<{ name: string; served: string }> {
	const url = new URL(options.server);
	if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
		throw new Error(
			'The board address must start with https:// (only an address on this machine may use http).'
		);
	const personal = await deviceLogin(options.server, options.fetch, options.log, {
		name: TOOL_CLIENT_NAME,
		pkce: true,
		wait: options.wait,
		onCode: (c) => {
			if (options.json)
				options.out(
					JSON.stringify({
						event: 'code',
						userCode: c.userCode,
						verificationUri: c.verificationUri,
						verifier: c.verifier,
						expiresIn: c.expiresInSeconds
					})
				);
			else
				options.log(
					'On that page choose your organisation and tick "Change project settings" (manage). This is used once, to make this machine a runner.'
				);
		}
	});
	const name = runnerName();
	const projects = options.projects?.length ? options.projects : undefined;
	const res = await options.fetch(
		`${options.server}/api/v1/orgs/${encodeURIComponent(options.org)}/runners/tool`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${personal.token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ name, ...(projects ? { projects } : {}) }),
			signal: AbortSignal.timeout(30_000)
		}
	);
	const body = (await res.json().catch(() => ({}))) as {
		token?: string;
		error?: { message?: string };
	};
	if (!res.ok || !body.token)
		throw new Error(
			body.error?.message ?? `The board answered ${res.status} when making this machine a runner.`
		);
	options.store.set(runnerAccount(options.server, options.org), body.token);
	const served = projects ? projects.join(', ') : 'every project of the organisation you may use';
	if (options.json)
		options.out(
			JSON.stringify({
				event: 'connected',
				server: options.server,
				org: options.org,
				name,
				projects: projects ?? 'all'
			})
		);
	else options.log(`Connected as "${name}". It serves ${served}.`);
	return { name, served };
}
