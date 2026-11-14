// TEST ACCOUNT SIGN INS TYPED ON THE BOARD: THE SERVER KEEPS CIPHERTEXT ONLY, LEASES IT TO THE ONE MACHINE IT WAS MADE FOR, AND NEVER RETURNS IT ANYWHERE ELSE.

// IMPORTED DEP-MODULES
import { createECDH, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { registerToolRunner } from '../../src/lib/server/ops/environments';
import { signinTargets, storeSignin, discardSignin } from '../../src/lib/server/ops/signins';
import { SIGNIN_ALG } from '../../src/lib/shared/signinCrypto';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';
const SECRET_WORD = 'plain-password-that-must-never-appear';

// -- TYPES -- //

type Out = { status: number; body: Record<string, unknown> };

// -- FUNCTIONS -- //

describe('test account sign ins from the board', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage();
	const services = { masterKey: MASTER, storage, runnerQueueMinutes: 10 };
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const call = async (bearer: string, path: string, body: unknown = {}) =>
		(await handleRunnerApi(
			{
				method: 'POST',
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${bearer}` }),
				body: new TextEncoder().encode(JSON.stringify(body)),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		)) as unknown as Out;
	const newKey = () => {
		const e = createECDH('prime256v1');
		e.generateKeys();
		return {
			keyId: randomBytes(9).toString('base64url'),
			publicKey: e.getPublicKey().toString('base64url')
		};
	};
	const pack = () => JSON.stringify({ v: 1, epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' });
	let laptop: { token: string; runnerId: string; key: ReturnType<typeof newKey> };
	let desktop: { token: string; runnerId: string; key: ReturnType<typeof newKey> };

	const regs = (list: { p: string; n: string }[]) =>
		Buffer.from(JSON.stringify(list)).toString('base64url');
	const callWith = async (
		bearer: string,
		path: string,
		headers: Record<string, string>,
		body: unknown = {}
	) =>
		(await handleRunnerApi(
			{
				method: 'POST',
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${bearer}`, ...headers }),
				body: new TextEncoder().encode(JSON.stringify(body)),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		)) as unknown as Out;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const make = async (name: string) => {
			const t = await registerToolRunner(as('admin'), { name });
			const key = newKey();
			// The machine holds the site HAPRM (reported in the registrations header)
			await callWith(t.token, '/peek', {
				'x-afb-tool-registrations': regs([{ p: w.projectKey, n: 'HAPRM' }])
			});
			const published = await call(t.token, '/signins/key', key);
			expect(JSON.stringify(published.body)).toContain('fingerprint');
			const [{ id }] = await db.admin.query<{ id: string }>(
				`select id from runner where name = '${name}'`
			);
			return { token: t.token, runnerId: id, key };
		};
		laptop = await make('Laptop');
		desktop = await make('Desktop');
	}, 240_000);
	afterAll(async () => {
		await db?.stop();
	});

	const input = (m = laptop, registration = 'HAPRM') => ({
		runnerId: m.runnerId,
		registration,
		keyId: m.key.keyId,
		alg: SIGNIN_ALG,
		ciphertext: pack()
	});

	it('shows the machines that published a key with a fingerprint, and never any ciphertext', async () => {
		await storeSignin(as('owner'), input());
		const t = await signinTargets(as('owner'));
		expect(t.machines.map((m) => m.name).sort()).toEqual(['Desktop', 'Laptop']);
		expect(t.machines[0]!.fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
		expect(t.stored).toEqual([
			expect.objectContaining({ registration: 'haprm', state: 'waiting' })
		]);
		expect(JSON.stringify(t)).not.toMatch(/ciphertext|CCCC/);
	});

	it('leases to the machine it was made for, once, and a second machine gets nothing', async () => {
		const other = await call(desktop.token, '/signins/lease', { registration: 'HAPRM' });
		expect((other.body.signins as unknown[]).length).toBe(0);
		const mine = await call(laptop.token, '/signins/lease', { registration: 'HAPRM' });
		const rows = mine.body.signins as { id: string; ciphertext: string; keyId: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.keyId).toBe(laptop.key.keyId);
		expect(mine.body.orgId).toBe(w.orgId);
		// A second fetch inside the lease gets none; after the lease it is available again
		expect(
			(
				(await call(laptop.token, '/signins/lease', { registration: 'HAPRM' })).body
					.signins as unknown[]
			).length
		).toBe(0);
		await db.admin.exec(
			`update bridge_signin_envelope set leased_at = now() - interval '3 minutes'`
		);
		expect(
			(
				(await call(laptop.token, '/signins/lease', { registration: 'HAPRM' })).body
					.signins as unknown[]
			).length
		).toBe(1);
	});

	it('another machine cannot acknowledge it, the owning one wipes the ciphertext and only pass or fail stays', async () => {
		const [{ id }] = await db.admin.query<{ id: string }>(
			`select id from bridge_signin_envelope limit 1`
		);
		expect(
			(await call(desktop.token, '/signins/ack', { id, result: 'pass' })).body.acknowledged
		).toBe(0);
		expect(
			(await call(laptop.token, '/signins/ack', { id, result: 'pass' })).body.acknowledged
		).toBe(1);
		const [row] = await db.admin.query<{ ciphertext: string; result: string }>(
			`select ciphertext, result from bridge_signin_envelope where id = '${id}'`
		);
		expect(row).toEqual({ ciphertext: '', result: 'pass' });
		const t = await signinTargets(as('owner'));
		expect(t.stored[0]).toMatchObject({ state: 'used', result: 'pass' });
	});

	it('nothing in the history or the event log holds the sign in', async () => {
		await storeSignin(as('owner'), { ...input(), ciphertext: pack() });
		const events = await db.admin.query<{ after: unknown }>(
			`select after from event where verb = 'signin.store'`
		);
		expect(events.length).toBeGreaterThan(0);
		expect(JSON.stringify(events)).not.toMatch(/CCCC|ciphertext|epk/);
		expect(JSON.stringify(events)).not.toContain(SECRET_WORD);
	});

	it('refuses a key published by a runner that is not a tool, and a replaced key removes older sign ins', async () => {
		const hosted = await call('afx_not-a-token', '/signins/key', newKey());
		expect(hosted.status).toBe(401);
		const fresh = newKey();
		const changed = await call(laptop.token, '/signins/key', fresh);
		expect(changed.body.changed).toBe(true);
		const left = await db.admin.query(
			`select 1 from bridge_signin_envelope where runner_id = '${laptop.runnerId}'`
		);
		expect(left).toHaveLength(0);
		laptop.key = fresh;
		expect(
			(await call(laptop.token, '/signins/key', { keyId: 'short', publicKey: 'x' })).status
		).toBe(400);
		const notOnCurve = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
		expect(
			(await call(laptop.token, '/signins/key', { keyId: 'abcdefgh1234', publicKey: notOnCurve }))
				.status
		).toBe(400);
	});

	it('stores only for a person with manage, for the machine key id it holds and a site it has', async () => {
		await expect(storeSignin(as('member'), input())).rejects.toThrow();
		await expect(
			storeSignin(as('owner'), { ...input(), keyId: 'stale-key-id-1234' })
		).rejects.toThrow(/changed its key/);
		await expect(storeSignin(as('owner'), input(laptop, 'NOSUCH'))).rejects.toThrow(
			/does not hold/
		);
		await expect(
			storeSignin(as('owner'), { ...input(), ciphertext: 'not json at all, but long enough' })
		).rejects.toThrow(/packed/);
		await expect(
			storeSignin(as('owner'), { ...input(), ciphertext: 'x'.repeat(3001) })
		).rejects.toThrow();
		await expect(
			storeSignin({ ...as('owner'), actor: { ...as('owner').actor, tokenId: 't' } }, input())
		).rejects.toThrow(/signed in/);
	});

	it('an expired row is gone, and the owner can discard one', async () => {
		await storeSignin(as('owner'), input());
		await db.admin.exec(
			`update bridge_signin_envelope set expires_at = now() - interval '1 minute'`
		);
		await signinTargets(as('owner'));
		expect(await db.admin.query(`select 1 from bridge_signin_envelope`)).toHaveLength(0);
		await storeSignin(as('owner'), input());
		expect((await discardSignin(as('owner'), laptop.runnerId, 'HAPRM')).discarded).toBe(1);
	});

	it('another organisation sees no machines', async () => {
		const other = {
			handle: db,
			orgId: w.other.orgId,
			services,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		expect((await signinTargets(other)).machines).toHaveLength(0);
		await expect(storeSignin(other, input())).rejects.toThrow();
	});
});
