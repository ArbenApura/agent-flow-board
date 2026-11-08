// CONNECTING AS A CHECK RUNNER: THE CODE GOES OUT FOR AN AGENT, ONLY THE RUNNER TOKEN IS KEPT, AND NO TOKEN IS EVER PRINTED

// -- DEP-MODULES -- //
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { connectChecks, loadRunnerToken, runnerAccount, runnerName } from './connect.js';
import { fileStore } from '../tokenStore.js';

// -- CONSTANTS -- //

const SERVER = 'https://board.test';
const PERSONAL = 'afp_personal_token_value_123456';
const RUNNER = 'afx_runner_token_value_abcdef';

// -- FUNCTIONS -- //

/** A board that approves at once and records what it was asked. */
function fakeBoard(opts: { registerStatus?: number } = {}) {
	const calls: { url: string; body: string; auth: string | null }[] = [];
	const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		calls.push({ url: input, body: String(init?.body ?? ''), auth: headers.get('authorization') });
		if (input.endsWith('/oauth/device/code'))
			return Response.json({
				device_code: 'dc',
				user_code: 'ABCD-1234',
				verification_uri: `${SERVER}/device`,
				expires_in: 600,
				interval: 1
			});
		if (input.endsWith('/oauth/token'))
			return Response.json({ access_token: PERSONAL, expires_in: 3600 });
		if (input.includes('/runners/tool')) {
			const status = opts.registerStatus ?? 200;
			return status === 200
				? Response.json({ token: RUNNER })
				: Response.json({ error: { message: 'You need the manage permission.' } }, { status });
		}
		return new Response('', { status: 404 });
	};
	return { calls, fetchImpl };
}

describe('check connect', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-connect-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('prints the code and the verifier for an agent, keeps only the runner token and never prints a token', async () => {
		const { calls, fetchImpl } = fakeBoard();
		const store = fileStore(dir);
		const lines: string[] = [];
		const out: string[] = [];
		await connectChecks({
			server: SERVER,
			org: 'arbenger',
			projects: ['AFB'],
			json: true,
			store,
			fetch: fetchImpl,
			log: (l) => lines.push(l),
			out: (l) => out.push(l),
			wait: async () => undefined
		});
		const first = JSON.parse(out[0]);
		expect(first).toMatchObject({ event: 'code', userCode: 'ABCD-1234' });
		expect(typeof first.verifier).toBe('string');
		expect(JSON.parse(out[1])).toMatchObject({
			event: 'connected',
			org: 'arbenger',
			projects: ['AFB']
		});
		// The runner token is kept, under its own entry, and the personal token is not
		expect(store.get(runnerAccount(SERVER, 'arbenger'))).toBe(RUNNER);
		expect(store.get('board.test/arbenger')).toBeNull();
		// The code was started under the client name the board approves, with a challenge and no token
		const start = calls.find((c) => c.url.endsWith('/oauth/device/code'));
		expect(JSON.parse(start?.body ?? '{}')).toMatchObject({
			client_name: 'afb-checks',
			code_challenge_method: 'S256'
		});
		// The runner is registered with the personal token once, with the projects asked for
		const reg = calls.find((c) => c.url.includes('/runners/tool'));
		expect(reg?.auth).toBe(`Bearer ${PERSONAL}`);
		expect(JSON.parse(reg?.body ?? '{}')).toMatchObject({ projects: ['AFB'] });
		// No token appears in anything printed
		const everything = [...lines, ...out].join('\n');
		expect(everything).not.toContain(PERSONAL);
		expect(everything).not.toContain(RUNNER);
	});

	it('uses a runner name different from the standalone tool, so it never cuts that tool off', () => {
		expect(runnerName()).toMatch(/ agent-flow-board$/);
		expect(runnerName()).not.toMatch(/afb-checks$/);
		expect(runnerName().length).toBeLessThanOrEqual(60);
	});

	it('refuses a plain http board that is not on this machine, and keeps nothing when the board refuses the runner', async () => {
		const store = fileStore(dir);
		await expect(
			connectChecks({
				server: 'http://board.example.com',
				org: 'arbenger',
				json: false,
				store,
				fetch: fakeBoard().fetchImpl,
				log: () => undefined,
				out: () => undefined
			})
		).rejects.toThrow(/https/);
		const refusing = fakeBoard({ registerStatus: 403 });
		await expect(
			connectChecks({
				server: SERVER,
				org: 'arbenger',
				json: false,
				store,
				fetch: refusing.fetchImpl,
				log: () => undefined,
				out: () => undefined,
				wait: async () => undefined
			})
		).rejects.toThrow(/manage permission/);
		expect(loadRunnerToken(store, SERVER, 'arbenger')).toBeNull();
	});
});
