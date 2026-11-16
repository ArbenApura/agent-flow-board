// THE ORGANISATION A COMMAND WAS ASKED FOR IS CHECKED EARLY, WITH A PLAIN MESSAGE, AND THE ORGANISATION IS SENT WITH THE SIGN IN CODE (AFB-20261116-1440)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { deviceLogin } from './device.js';
import { checkOrgAccess } from './orgAccess.js';

// -- CONSTANTS -- //

const SERVER = 'https://board.test';

// -- FUNCTIONS -- //

const answering = (status: number) => async () => new Response('{}', { status });

describe('checkOrgAccess', () => {
	it('says plainly when nothing is saved, with the command to run', async () => {
		const r = await checkOrgAccess({
			server: SERVER,
			org: 'acme',
			token: null,
			fetch: answering(200)
		});
		expect(r).toEqual({
			ok: false,
			message: `Not signed in to acme on ${SERVER}. Run: agent-flow-board login --json --server ${SERVER} --org acme`
		});
	});

	it('tells an expired sign in (401) from one that is not valid for the organisation (403)', async () => {
		const expired = await checkOrgAccess({
			server: SERVER,
			org: 'acme',
			token: 'afp_x',
			fetch: answering(401)
		});
		const other = await checkOrgAccess({
			server: SERVER,
			org: 'acme',
			token: 'afp_x',
			fetch: answering(403)
		});
		expect(!expired.ok && expired.message).toMatch(/expired or was revoked/);
		// One wording for "another organisation" and "no such organisation", so nothing can be probed
		expect(!other.ok && other.message).toMatch(
			/not valid for acme, or there is no such organisation/
		);
	});

	it('reads a 404 for a malformed organisation address the same as no such organisation', async () => {
		const r = await checkOrgAccess({
			server: SERVER,
			org: 'acme',
			token: 'afp_x',
			fetch: answering(404)
		});
		expect(!r.ok && r.message).toMatch(/not valid for acme, or there is no such organisation/);
	});

	it('names AFB_TOKEN instead of a login that could not help', async () => {
		const r = await checkOrgAccess({
			server: SERVER,
			org: 'acme',
			token: 'afp_x',
			fetch: answering(403),
			fromEnv: true
		});
		expect(!r.ok && r.message).toMatch(/AFB_TOKEN/);
		expect(!r.ok && r.message).not.toMatch(/Run: agent-flow-board login/);
	});

	it('lets the command go on when the board cannot be reached, or answers anything but a refusal', async () => {
		const down = async () => {
			throw new Error('offline');
		};
		expect(
			await checkOrgAccess({ server: SERVER, org: 'acme', token: 'afp_x', fetch: down })
		).toEqual({ ok: true });
		expect(
			await checkOrgAccess({ server: SERVER, org: 'acme', token: 'afp_x', fetch: answering(500) })
		).toEqual({ ok: true });
		expect(
			await checkOrgAccess({ server: SERVER, org: 'acme', token: 'afp_x', fetch: answering(200) })
		).toEqual({ ok: true });
	});

	it('never asks the board about a runner token, which /mcp does not accept', async () => {
		let asked = false;
		const r = await checkOrgAccess({
			server: SERVER,
			org: 'acme',
			token: 'afx_runner',
			fetch: async () => {
				asked = true;
				return new Response('{}', { status: 401 });
			}
		});
		expect(r).toEqual({ ok: true });
		expect(asked).toBe(false);
	});
});

describe('deviceLogin and the organisation', () => {
	/** A board that approves at once and keeps the body of the code request. */
	function board(startStatus = 200) {
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
			if (input.endsWith('/oauth/device/code')) {
				bodies.push(JSON.parse(String(init?.body)));
				return startStatus === 200
					? Response.json({
							device_code: 'dc',
							user_code: 'ABCD-1234',
							verification_uri: `${SERVER}/device`,
							expires_in: 600,
							interval: 1
						})
					: Response.json(
							{ error: 'invalid_request', error_description: 'org must be an organisation slug.' },
							{ status: startStatus }
						);
			}
			return Response.json({ access_token: 'afb_token', expires_in: 3600 });
		};
		return { bodies, fetchImpl };
	}

	it('sends the organisation with the code, and nothing else new', async () => {
		const { bodies, fetchImpl } = board();
		const lines: string[] = [];
		await deviceLogin(SERVER, fetchImpl, (l) => lines.push(l), {
			org: 'acme',
			wait: async () => undefined
		});
		expect(bodies[0]).toEqual({ client_name: 'agent-flow-board bridge', org: 'acme' });
		expect(lines.some((l) => l.includes('only the organisation acme'))).toBe(true);
		// The pinned wording of the terminal stays
		expect(lines[0]).toContain(`open ${SERVER}/device and type this code: ABCD-1234`);
	});

	it('sends no org field when none was asked for, and keeps line one of login --json the same', async () => {
		const { bodies, fetchImpl } = board();
		let first: Record<string, unknown> = {};
		await deviceLogin(SERVER, fetchImpl, () => undefined, {
			pkce: true,
			wait: async () => undefined,
			onCode: (c) => (first = c)
		});
		expect(bodies[0]).not.toHaveProperty('org');
		expect(Object.keys(first).sort()).toEqual([
			'expiresInSeconds',
			'userCode',
			'verificationUri',
			'verifier'
		]);
	});

	it('says why the server refused the code instead of a bare number', async () => {
		const { fetchImpl } = board(400);
		await expect(
			deviceLogin(SERVER, fetchImpl, () => undefined, {
				org: 'Bad Org',
				wait: async () => undefined
			})
		).rejects.toThrow('org must be an organisation slug.');
	});
});
