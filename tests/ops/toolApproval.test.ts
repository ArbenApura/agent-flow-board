// AN AGENT APPROVES THE SIGN IN OF ITS OWN AFB-CHECKS TOOL (AFB-20261021-0341 PHASE 2). The approval is bound to the tool that started the code (a verifier whose
// hash the tool sent), needs the manage permission of the caller today and of the caller's token, gives only `manage`, is safe to repeat, counts refusals per
// caller token, and returns nothing secret. The person's own flow at /device is unchanged and is covered by tests/mcp/oauth.test.ts.

// IMPORTED TYPES
import type { Capability } from '../../src/lib/server/ops/context';
// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { approveToolConnection } from '../../src/lib/server/ops/environments';
import { isOAuthError, pollDevice, startDevice } from '../../src/lib/server/oauth/oauth';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('an agent approves the sign in of its own afb-checks tool', () => {
	let db: TestDb;
	let w: World;
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => w.ctx(who);
	/** The caller's own token: its stored permissions are an upper limit on the role. */
	const asToken = (who: 'admin' | 'member', tokenId: string, tokenCaps: Capability[]) =>
		w.ctx(who, { tokenId, tokenCaps });
	/** What the tool does: keeps a verifier, sends only its hash, and prints the code and the verifier. */
	async function toolStarts(client = 'afb-checks', withChallenge = true) {
		const verifier = randomBytes(32).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const started = await startDevice(db, 'http://board.test', {
			client_name: client,
			...(withChallenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {})
		});
		if (isOAuthError(started)) throw new Error(started.error_description);
		return { userCode: started.user_code, deviceCode: started.device_code, verifier };
	}
	const row = async (userCode: string) =>
		(
			await db.admin.query<{
				status: string;
				approved_by: string | null;
				approved_org_id: string | null;
				scopes: string[];
				challenge_hash: string | null;
			}>(
				`select status, approved_by, approved_org_id, scopes, challenge_hash from device_code where user_code = '${userCode.replace('-', '')}'`
			)
		)[0];

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 240_000);
	afterAll(() => db?.stop());

	it('refuses a challenge that is not the SHA-256 of a verifier, and stores the one that is', async () => {
		for (const bad of [
			{ code_challenge: 'short', code_challenge_method: 'S256' },
			{ code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' },
			{ code_challenge: 'a'.repeat(43) },
			{ code_challenge: 'a'.repeat(42) + '!', code_challenge_method: 'S256' }
		]) {
			const r = await startDevice(db, 'http://board.test', { client_name: 'afb-checks', ...bad });
			expect(isOAuthError(r) && r.error).toBe('invalid_request');
		}
		const t = await toolStarts();
		expect((await row(t.userCode)).challenge_hash).toBe(
			createHash('sha256').update(t.verifier).digest('base64url')
		);
		// The verifier itself is never stored
		const all = JSON.stringify(await db.admin.query('select * from device_code'));
		expect(all).not.toContain(t.verifier);
	});

	it("an admin approves the code its tool started: only manage is given, the org is the caller's, and the tool then receives its token by polling", async () => {
		const t = await toolStarts();
		const done = await approveToolConnection(as('admin'), {
			userCode: t.userCode,
			verifier: t.verifier
		});
		expect(done).toEqual({ ok: true, client: 'afb-checks' });
		// Nothing secret comes back
		expect(JSON.stringify(done)).not.toContain(t.verifier);
		expect(JSON.stringify(done)).not.toContain(t.deviceCode);
		const stored = await row(t.userCode);
		expect(stored).toMatchObject({
			status: 'approved',
			approved_by: w.people.admin,
			approved_org_id: w.orgId,
			scopes: ['manage']
		});
		const token = await pollDevice(db, t.deviceCode);
		expect(isOAuthError(token)).toBe(false);
		expect(token).toMatchObject({ token_type: 'Bearer', scope: 'manage' });
		// A token is handed over exactly once
		expect(isOAuthError(await pollDevice(db, t.deviceCode))).toBe(true);
	});

	it('the code may be typed the way the tool shows it, lower case and with the dash', async () => {
		const t = await toolStarts();
		expect(t.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
		await expect(
			approveToolConnection(as('owner'), {
				userCode: t.userCode.toLowerCase(),
				verifier: t.verifier
			})
		).resolves.toMatchObject({ ok: true });
	});

	it("needs manage today, in the role and in the caller's own token, and leaves the code pending when refused", async () => {
		const t = await toolStarts();
		await expect(
			approveToolConnection(as('member'), { userCode: t.userCode, verifier: t.verifier })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		// An admin whose token was limited to read and write may not approve, even though the role could
		await expect(
			approveToolConnection(
				asToken('admin', '00000000-0000-4000-8000-0000000000a1', ['read', 'write']),
				{ userCode: t.userCode, verifier: t.verifier }
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect((await row(t.userCode)).status).toBe('pending');
		// The same admin with a token that holds manage can
		await expect(
			approveToolConnection(
				asToken('admin', '00000000-0000-4000-8000-0000000000a2', ['read', 'write', 'manage']),
				{ userCode: t.userCode, verifier: t.verifier }
			)
		).resolves.toMatchObject({ ok: true });
	});

	it('a token limited to some projects may not approve: the tool would reach every project', async () => {
		const t = await toolStarts();
		const limited = w.ctx('admin', {
			tokenId: '00000000-0000-4000-8000-0000000000b1',
			tokenCaps: ['read', 'write', 'manage'],
			tokenProjects: [w.projectId]
		});
		await expect(
			approveToolConnection(limited, { userCode: t.userCode, verifier: t.verifier })
		).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: expect.stringMatching(/limited to some projects/)
		});
		expect((await row(t.userCode)).status).toBe('pending');
		// The same token without the limit can
		await expect(
			approveToolConnection(
				asToken('admin', '00000000-0000-4000-8000-0000000000b2', ['read', 'manage']),
				{
					userCode: t.userCode,
					verifier: t.verifier
				}
			)
		).resolves.toMatchObject({ ok: true });
	});

	it('a code its tool did not start is refused in one plain answer: a wrong verifier, no verifier on file, another client, an unknown, an expired, a denied and a used code', async () => {
		const mine = await toolStarts();
		const wrong = randomBytes(32).toString('base64url');
		const refused = (userCode: string, verifier: string) =>
			expect(approveToolConnection(as('admin'), { userCode, verifier })).rejects.toMatchObject({
				code: 'INVALID',
				message: expect.stringMatching(
					/not valid, has expired, was already used, or was not started by the tool/
				)
			});
		// The verifier of another tool
		await refused(mine.userCode, wrong);
		// A code asked for with no challenge (a person's flow): an agent never approves it
		const noChallenge = await toolStarts('afb-checks', false);
		await refused(noChallenge.userCode, mine.verifier);
		// A client with another name, even with a matching verifier
		const other = await toolStarts('Some other tool');
		await refused(other.userCode, other.verifier);
		// A code that was never made
		await refused('ZZZZ-ZZZZ', mine.verifier);
		// Expired
		const old = await toolStarts();
		await db.admin.exec(
			`update device_code set expires_at = now() - interval '1 minute' where user_code = '${old.userCode.replace('-', '')}'`
		);
		await refused(old.userCode, old.verifier);
		// Denied by a person
		const denied = await toolStarts();
		await db.admin.exec(
			`update device_code set status = 'denied' where user_code = '${denied.userCode.replace('-', '')}'`
		);
		await refused(denied.userCode, denied.verifier);
		// None of these became approved
		expect((await row(mine.userCode)).status).toBe('pending');
		expect((await row(noChallenge.userCode)).status).toBe('pending');
		expect((await row(other.userCode)).status).toBe('pending');
		// Approved once by the admin. Another person asking for the same code is refused, and nothing changes
		await approveToolConnection(as('admin'), { userCode: mine.userCode, verifier: mine.verifier });
		await expect(
			approveToolConnection(as('owner'), { userCode: mine.userCode, verifier: mine.verifier })
		).rejects.toMatchObject({ code: 'INVALID' });
		expect((await row(mine.userCode)).approved_by).toBe(w.people.admin);
	});

	it('a retry of an approval that already went through, with no request id, answers the same and counts no failure', async () => {
		const t = await toolStarts();
		const caller = asToken('admin', '00000000-0000-4000-8000-0000000000c1', ['read', 'manage']);
		const first = await approveToolConnection(caller, {
			userCode: t.userCode,
			verifier: t.verifier
		});
		// The answer was lost on the way back, so the agent asks again; the tool may even have collected its token meanwhile
		await pollDevice(db, t.deviceCode);
		for (let i = 0; i < 12; i++)
			await expect(
				approveToolConnection(caller, { userCode: t.userCode, verifier: t.verifier })
			).resolves.toEqual(first);
		// Another person's retry of the same code is still refused, and a wrong verifier still is
		await expect(
			approveToolConnection(as('owner'), { userCode: t.userCode, verifier: t.verifier })
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			approveToolConnection(caller, {
				userCode: t.userCode,
				verifier: randomBytes(32).toString('base64url')
			})
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('a malformed verifier or code is refused before the database is asked', async () => {
		await expect(
			approveToolConnection(as('admin'), { userCode: 'AB', verifier: 'x'.repeat(43) })
		).rejects.toThrow();
		await expect(
			approveToolConnection(as('admin'), { userCode: 'ABCD-EFGH', verifier: 'short' })
		).rejects.toThrow();
		await expect(
			approveToolConnection(as('admin'), { userCode: 'ABCD-EFGH', verifier: '!'.repeat(43) })
		).rejects.toThrow();
	});

	it('a repeat with the same request id is answered from the first and approves nothing twice; the same id for another code is a conflict', async () => {
		const a = await toolStarts();
		const b = await toolStarts();
		const ctx = { ...as('admin'), requestId: 'approve-request-0001', fingerprint: 'approve:a' };
		const first = await approveToolConnection(ctx, { userCode: a.userCode, verifier: a.verifier });
		const again = await approveToolConnection(ctx, { userCode: a.userCode, verifier: a.verifier });
		expect(again).toEqual(first);
		await expect(
			approveToolConnection(
				{ ...ctx, fingerprint: 'approve:b' },
				{ userCode: b.userCode, verifier: b.verifier }
			)
		).rejects.toMatchObject({ code: 'CONFLICT' });
		expect((await row(b.userCode)).status).toBe('pending');
	});

	it("refusals are counted per caller token, so an agent in a loop is stopped without touching the person's own budget or another caller", async () => {
		const loop = asToken('admin', '00000000-0000-4000-8000-0000000000a3', [
			'read',
			'write',
			'manage'
		]);
		const wrong = randomBytes(32).toString('base64url');
		for (let i = 0; i < 10; i++)
			await expect(
				approveToolConnection(loop, { userCode: 'QQQQ-QQQQ', verifier: wrong })
			).rejects.toMatchObject({
				code: 'INVALID'
			});
		await expect(
			approveToolConnection(loop, { userCode: 'QQQQ-QQQQ', verifier: wrong })
		).rejects.toMatchObject({
			code: 'RATE_LIMITED'
		});
		// Even a right code is refused while the limit holds for that token
		const t = await toolStarts();
		await expect(
			approveToolConnection(loop, { userCode: t.userCode, verifier: t.verifier })
		).rejects.toMatchObject({
			code: 'RATE_LIMITED'
		});
		// Another token of the same person is not stopped, and neither is the person's own session
		await expect(
			approveToolConnection(
				asToken('admin', '00000000-0000-4000-8000-0000000000a4', ['read', 'write', 'manage']),
				{ userCode: t.userCode, verifier: t.verifier }
			)
		).resolves.toMatchObject({ ok: true });
	});

	it("the approval is in the organisation's history, with who did it and no code or verifier", async () => {
		const t = await toolStarts();
		await approveToolConnection(as('admin'), { userCode: t.userCode, verifier: t.verifier });
		const events = await db.admin.query<{ verb: string; after: unknown }>(
			`select verb, after from event where org_id = '${w.orgId}' and verb = 'runner.approve' order by id desc limit 1`
		);
		expect(events).toHaveLength(1);
		const text = JSON.stringify(events[0]);
		expect(text).not.toContain(t.verifier);
		expect(text).not.toContain(t.userCode.replace('-', ''));
		expect(text).toContain('afb-checks');
	});

	// -- THE BRIDGE AS A SECOND CLIENT (AFB-20261108-0427, B.1 AND B.4) -- //

	describe('the bridge as a second client', () => {
		const BRIDGE = 'agent-flow-board bridge';

		it('an admin approves the bridge code: exactly read, comment and write, never manage, and the event names the client', async () => {
			const t = await toolStarts(BRIDGE);
			const done = await approveToolConnection(as('admin'), {
				userCode: t.userCode,
				verifier: t.verifier
			});
			expect(done).toEqual({ ok: true, client: BRIDGE });
			const stored = await row(t.userCode);
			expect(stored).toMatchObject({
				status: 'approved',
				approved_by: w.people.admin,
				approved_org_id: w.orgId
			});
			expect([...stored.scopes].sort()).toEqual(['comment', 'read', 'write']);
			expect(stored.scopes).not.toContain('manage');
			const token = await pollDevice(db, t.deviceCode);
			expect(isOAuthError(token)).toBe(false);
			expect((token as { scope: string }).scope.split(' ').sort()).toEqual([
				'comment',
				'read',
				'write'
			]);
			// Nothing secret in the answer or the history
			expect(JSON.stringify(done)).not.toContain(t.verifier);
			const [event] = await db.admin.query<{ after: unknown }>(
				`select after from event where org_id = '${w.orgId}' and verb = 'runner.approve' order by id desc limit 1`
			);
			expect(JSON.stringify(event)).toContain(BRIDGE);
			expect(JSON.stringify(event)).not.toContain(t.verifier);
			// Negative control: the afb-checks client still gets only manage
			const checks = await toolStarts();
			await approveToolConnection(as('admin'), {
				userCode: checks.userCode,
				verifier: checks.verifier
			});
			expect((await row(checks.userCode)).scopes).toEqual(['manage']);
		});

		it('refuses a member, a token limited to some projects, and a token that holds manage but not what the bridge is given', async () => {
			const t = await toolStarts(BRIDGE);
			await expect(
				approveToolConnection(as('member'), { userCode: t.userCode, verifier: t.verifier })
			).rejects.toMatchObject({ code: 'FORBIDDEN' });
			await expect(
				approveToolConnection(
					w.ctx('admin', {
						tokenId: '00000000-0000-4000-8000-0000000000c1',
						tokenCaps: ['read', 'write', 'manage'],
						tokenProjects: ['00000000-0000-4000-8000-0000000000d1']
					}),
					{ userCode: t.userCode, verifier: t.verifier }
				)
			).rejects.toMatchObject({ code: 'FORBIDDEN' });
			// Manage and no comment: the bridge would be given more than this token holds
			await expect(
				approveToolConnection(
					asToken('admin', '00000000-0000-4000-8000-0000000000c2', ['read', 'write', 'manage']),
					{ userCode: t.userCode, verifier: t.verifier }
				)
			).rejects.toMatchObject({ code: 'FORBIDDEN' });
			expect((await row(t.userCode)).status).toBe('pending');
			// Negative control: a token that holds all four can approve
			await expect(
				approveToolConnection(
					asToken('admin', '00000000-0000-4000-8000-0000000000c3', [
						'read',
						'comment',
						'write',
						'manage'
					]),
					{ userCode: t.userCode, verifier: t.verifier }
				)
			).resolves.toMatchObject({ ok: true, client: BRIDGE });
		});

		it('refuses another client name, a code with no challenge, and a wrong verifier, and leaves each code pending', async () => {
			const other = await toolStarts('agent-flow-board bridge 2');
			await expect(
				approveToolConnection(as('admin'), { userCode: other.userCode, verifier: other.verifier })
			).rejects.toMatchObject({ code: 'INVALID' });
			const noChallenge = await toolStarts(BRIDGE, false);
			await expect(
				approveToolConnection(as('admin'), {
					userCode: noChallenge.userCode,
					verifier: noChallenge.verifier
				})
			).rejects.toMatchObject({ code: 'INVALID' });
			const real = await toolStarts(BRIDGE);
			await expect(
				approveToolConnection(as('admin'), {
					userCode: real.userCode,
					verifier: randomBytes(32).toString('base64url')
				})
			).rejects.toMatchObject({ code: 'INVALID' });
			for (const t of [other, noChallenge, real])
				expect((await row(t.userCode)).status).toBe('pending');
			// Negative control: the right verifier approves the real code
			await expect(
				approveToolConnection(as('admin'), { userCode: real.userCode, verifier: real.verifier })
			).resolves.toMatchObject({ ok: true });
		});

		it('refuses an expired bridge code', async () => {
			const t = await toolStarts(BRIDGE);
			await db.admin.exec(
				`update device_code set expires_at = now() - interval '1 minute' where user_code = '${t.userCode.replace('-', '')}'`
			);
			await expect(
				approveToolConnection(as('admin'), { userCode: t.userCode, verifier: t.verifier })
			).rejects.toMatchObject({ code: 'INVALID' });
		});

		it('a repeated approval of the same bridge code is the same answer', async () => {
			const t = await toolStarts(BRIDGE);
			// Its own token, so the refusals counted for the person's other callers above do not apply
			const caller = asToken('admin', '00000000-0000-4000-8000-0000000000c4', [
				'read',
				'comment',
				'write',
				'manage'
			]);
			const first = await approveToolConnection(caller, {
				userCode: t.userCode,
				verifier: t.verifier
			});
			const again = await approveToolConnection(caller, {
				userCode: t.userCode,
				verifier: t.verifier
			});
			expect(again).toEqual(first);
		});
	});
});
