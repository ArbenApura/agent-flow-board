// THE AGENT HANDLES BRIDGE APPROVALS ON ITS OWN, ALWAYS ON (AFB-20261115-1229): INSTANT APPROVAL, CLAIM ONCE, THE OWNER'S LIVE ROLE AT REQUEST AND AT CLAIM, AND THE WAYS A PROMPT-INJECTED AGENT COULD TRY TO WIDEN IT. Each negative control is a named test.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { approvalList } from '../../src/lib/server/ops/approvals';
import { registerToolRunner } from '../../src/lib/server/ops/environments';
import { getOrgSettings, updateOrgSettings } from '../../src/lib/server/ops/settings';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- TYPES -- //

type Body = {
	requests: { id: string; status: string; target: string }[];
	batchId: string | null;
	link?: string | null;
	claimed: { action: string; target: string; decidedVia: string; decidedBy: string }[];
	cancelled: number;
};

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('the agent handles approvals on its own', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage();
	const services = {
		masterKey: MASTER,
		storage,
		runnerQueueMinutes: 10,
		baseUrl: 'http://board.test'
	};
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const call = async (bearer: string, path: string, body: unknown = {}) => {
		const res = await handleRunnerApi(
			{
				method: 'POST',
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${bearer}` }),
				body: new TextEncoder().encode(JSON.stringify(body)),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		);
		return res as unknown as { status: number; body: Body };
	};
	let n = 0;
	const rid = () => `req-${Date.now().toString(36)}-${++n}-abcdef`;
	const ask = (token: string, entries: { action: string; target: string }[], extra = {}) =>
		call(token, '/approvals', { requestId: rid(), entries, ...extra });
	const setRole = (who: 'admin' | 'owner', role: string) =>
		db.admin.exec(
			`update member set role = '${role}' where org_id = '${w.orgId}' and user_id = '${w.people[who]}'`
		);
	let laptop: string; // owned by the admin
	let desk: string; // owned by the admin too
	let ownerBox: string; // owned by the owner

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		laptop = (await registerToolRunner(as('admin'), { name: 'Laptop' })).token;
		desk = (await registerToolRunner(as('admin'), { name: 'Desk' })).token;
		ownerBox = (await registerToolRunner(as('owner'), { name: 'Owner box' })).token;
	}, 240_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('a request is approved at once with no switch, claimed once, and the history says auto', async () => {
		const asked = await ask(laptop, [{ action: 'secrets', target: 'MangoMan/HAPRM' }], {
			why: 'Import the test keys'
		});
		expect(asked.status).toBe(200);
		expect(asked.body.requests[0]).toMatchObject({ target: 'mangoman/haprm', status: 'approved' });
		// There is no settings page to point at any more
		expect(asked.body.link ?? null).toBeNull();
		const id = asked.body.requests[0]!.id;
		const poll = await call(laptop, '/approvals/poll', { ids: [id] });
		expect(poll.body.requests[0]!.status).toBe('approved');
		const first = await call(laptop, '/approvals/claim', { ids: [id] });
		expect(first.body.claimed).toHaveLength(1);
		expect(first.body.claimed[0]).toMatchObject({ action: 'secrets', decidedVia: 'auto' });
		expect((await call(laptop, '/approvals/claim', { ids: [id] })).body.claimed).toHaveLength(0);
		const events = await db.admin.query<{ verb: string }>(
			`select verb from event where verb = 'approval.auto'`
		);
		expect(events.length).toBeGreaterThanOrEqual(1);
	});

	it('the owner machine is approved at once too, and nobody turned anything on', async () => {
		expect((await ask(ownerBox, [{ action: 'roots', target: '/o/1' }])).status).toBe(200);
	});

	it('claims once when two claims run in parallel', async () => {
		const asked = await ask(laptop, [{ action: 'register', target: 'parallel.example.com' }]);
		const id = asked.body.requests[0]!.id;
		const [a, b] = await Promise.all([
			call(laptop, '/approvals/claim', { ids: [id] }),
			call(laptop, '/approvals/claim', { ids: [id] })
		]);
		expect(a.body.claimed.length + b.body.claimed.length).toBe(1);
	});

	it('a second ask for the same target is the same row and a retry of the same ask is the same rows', async () => {
		const one = await ask(laptop, [{ action: 'pictures', target: 'haprm' }]);
		const two = await ask(laptop, [{ action: 'pictures', target: 'HAPRM' }]);
		expect(two.body.requests[0]!.id).toBe(one.body.requests[0]!.id);
		const requestId = rid();
		const a = await call(laptop, '/approvals', {
			requestId,
			entries: [{ action: 'adopt-env', target: 'x' }]
		});
		const b = await call(laptop, '/approvals', {
			requestId,
			entries: [{ action: 'adopt-env', target: 'x' }]
		});
		expect(b.body.requests[0]!.id).toBe(a.body.requests[0]!.id);
	});

	it('a batch yields exactly its entries, all approved, and 21 entries are refused', async () => {
		const asked = await ask(laptop, [
			{ action: 'roots', target: '/work/a' },
			{ action: 'register', target: 'batch.example.com' },
			{ action: 'secrets', target: 'o/BATCH' }
		]);
		expect(asked.body.batchId).toBeTruthy();
		const ids = asked.body.requests.map((r) => r.id);
		expect(asked.body.requests.every((r) => r.status === 'approved')).toBe(true);
		expect((await call(laptop, '/approvals/claim', { ids })).body.claimed).toHaveLength(3);
		const many = Array.from({ length: 21 }, (_, i) => ({ action: 'roots', target: `/cap/${i}` }));
		expect((await ask(laptop, many)).status).toBe(400);
	});

	it('caps what an auto-approved agent can open in an hour: 10 sign-in windows, then a plain stop', async () => {
		for (let i = 0; i < 10; i++)
			expect((await ask(desk, [{ action: 'login', target: `acme/site${i}` }])).status).toBe(200);
		const over = await ask(desk, [{ action: 'login', target: 'acme/site-over' }]);
		expect(over.status).toBe(429);
		expect(JSON.stringify(over.body)).toMatch(/too many/);
	});

	it('cancel and claim and poll belong to the asking machine only', async () => {
		const asked = await ask(laptop, [{ action: 'secrets', target: 'a/other' }]);
		const id = asked.body.requests[0]!.id;
		expect((await call(desk, '/approvals/cancel', { ids: [id] })).body.cancelled).toBe(0);
		expect((await call(desk, '/approvals/claim', { ids: [id] })).body.claimed).toHaveLength(0);
		expect((await call(desk, '/approvals/poll', { ids: [id] })).body.requests).toHaveLength(0);
		expect((await call(laptop, '/approvals/cancel', { ids: [id] })).body.cancelled).toBe(1);
	});

	it('an approved row past its time cannot be claimed', async () => {
		const asked = await ask(laptop, [{ action: 'register', target: 'late.example.com' }]);
		const id = asked.body.requests[0]!.id;
		await db.admin.exec(
			`update bridge_approval set expires_at = now() - interval '1 minute' where id = '${id}'`
		);
		expect((await call(laptop, '/approvals/claim', { ids: [id] })).body.claimed).toHaveLength(0);
	});

	it('an owner demoted between the request and the claim claims nothing, and the row is claimable again once the role is back', async () => {
		const asked = await ask(laptop, [{ action: 'secrets', target: 'demoted/after-ask' }]);
		const id = asked.body.requests[0]!.id;
		// The tool's token stops working the moment its owner cannot manage (runner auth), and the claim re-checks the same role itself
		await setRole('admin', 'viewer');
		const during = await call(laptop, '/approvals/claim', { ids: [id] });
		expect(during.status).toBe(401);
		expect(during.body.claimed ?? []).toHaveLength(0);
		await setRole('admin', 'admin');
		expect((await call(laptop, '/approvals/claim', { ids: [id] })).body.claimed).toHaveLength(1);
	});

	it('a request from an owner who lost manage is refused, and nothing in the answer sends anybody to a switch', async () => {
		await setRole('admin', 'viewer');
		const r = await ask(laptop, [{ action: 'roots', target: '/demoted' }]);
		await setRole('admin', 'admin');
		expect(r.status).toBe(401);
		expect(JSON.stringify(r.body)).not.toMatch(/switch|Agent access/);
		// Nothing was made for it
		expect(
			await db.admin.query(`select 1 from bridge_approval where target = '/demoted'`)
		).toHaveLength(0);
	});

	it('a machine with no owner cannot be approved', async () => {
		const lone = (await registerToolRunner(as('admin'), { name: 'Lone' })).token;
		await db.admin.exec(`update runner set owner_id = null where name = 'Lone'`);
		expect(
			(await ask(lone, [{ action: 'roots', target: '/ownerless' }])).status
		).toBeGreaterThanOrEqual(400);
	});

	it('a request approves the machine’s old waiting rows and leaves an org event for them', async () => {
		const [{ id: runnerId }] = await db.admin.query<{ id: string }>(
			`select id from runner where name = 'Laptop'`
		);
		await db.admin.exec(
			`insert into bridge_approval (org_id, runner_id, request_id, action, target, content_hash, status, expires_at)
			 values ('${w.orgId}', '${runnerId}', 'old-waiting-1', 'roots', '/old-waiting', 'x', 'pending', now() + interval '10 minutes')`
		);
		const before = await db.admin.query(`select 1 from event where verb = 'approval.auto'`);
		const r = await ask(laptop, [{ action: 'pictures', target: 'sweep-trigger' }]);
		expect(r.status).toBe(200);
		const [old] = await db.admin.query<{ status: string; decided_via: string }>(
			`select status, decided_via from bridge_approval where request_id = 'old-waiting-1'`
		);
		expect(old).toMatchObject({ status: 'approved', decided_via: 'auto' });
		const after = await db.admin.query(`select 1 from event where verb = 'approval.auto'`);
		// One event for the swept rows and one for the new batch
		expect(after.length - before.length).toBeGreaterThanOrEqual(2);
	});

	// -- NEGATIVE CONTROLS FOR A PROMPT-INJECTED AGENT -- //

	it('NEG no deciding or switching route exists over the runner token', async () => {
		for (const path of [
			'/approvals/decide',
			'/approvals/approve',
			'/approvals/switch',
			'/approvals/enable',
			'/org/settings'
		]) {
			const r = await call(laptop, path, { on: true, decision: 'approve' });
			expect(r.status).toBeGreaterThanOrEqual(400);
		}
	});

	it('NEG an old autoApproveBy key stays in the record but never reaches a settings read, and a limits save keeps it', async () => {
		await db.admin.exec(
			`update org set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('autoApproveBy', jsonb_build_object('${w.people.admin}', jsonb_build_object('at', 'old'))) where id = '${w.orgId}'`
		);
		await updateOrgSettings(as('admin'), { tokenMaxDays: 21 });
		const row = await db.admin.query<{ s: Record<string, unknown> }>(
			`select settings as s from org where id = '${w.orgId}'`
		);
		expect(Object.keys((row[0]!.s.autoApproveBy ?? {}) as object)).toContain(w.people.admin);
		expect(row[0]!.s.tokenMaxDays).toBe(21);
		const mine = await getOrgSettings(as('admin'));
		expect(JSON.stringify(mine)).not.toContain('autoApproveBy');
		expect(mine).not.toHaveProperty('autoApprove');
		expect(JSON.stringify(await getOrgSettings(as('member')))).not.toContain(w.people.admin);
	});

	it('NEG a run key and a bogus token are refused', async () => {
		const keyed = await call('afrun_runs.x.y.z', '/approvals', {
			requestId: rid(),
			entries: [{ action: 'roots', target: '/x' }]
		});
		expect(keyed.status).toBeGreaterThanOrEqual(400);
		expect((await ask('afx_nope', [{ action: 'roots', target: '/x' }])).status).toBe(401);
	});

	it('approval_list is only a stub for older skill texts: always on, no link, no history, in any org', async () => {
		const mine = await approvalList(as('admin'));
		expect(mine).toEqual({ enabled: true, link: null, history: [] });
		const other = {
			handle: db,
			orgId: w.other.orgId,
			services,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		expect(await approvalList(other)).toEqual({ enabled: true, link: null, history: [] });
		expect(JSON.stringify(mine)).not.toMatch(/ciphertext|password|token_hash/i);
	});

	it('a runner delete removes its rows', async () => {
		const tmp = (await registerToolRunner(as('admin'), { name: 'Temp' })).token;
		const r = await ask(tmp, [{ action: 'roots', target: '/tmp/x' }]);
		expect(r.status).toBe(200);
		const [{ runner_id }] = await db.admin.query<{ runner_id: string }>(
			`select runner_id from bridge_approval where id = '${r.body.requests[0]!.id}'`
		);
		await db.admin.exec(`delete from runner where id = '${runner_id}'`);
		expect(
			await db.admin.query(`select 1 from bridge_approval where runner_id = '${runner_id}'`)
		).toHaveLength(0);
	});
});
