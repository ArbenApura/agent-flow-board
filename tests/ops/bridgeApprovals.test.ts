// THE AGENT HANDLES BRIDGE APPROVALS ON ITS OWN: THE PERSON'S SWITCH, INSTANT APPROVAL, CLAIM ONCE, AND EVERY WAY A PROMPT-INJECTED AGENT COULD TRY TO TURN IT ON FOR ITSELF. Each negative control is a named test.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { approvalList, setAutoApprove } from '../../src/lib/server/ops/approvals';
import { registerToolRunner } from '../../src/lib/server/ops/environments';
import { getOrgSettings, updateOrgSettings } from '../../src/lib/server/ops/settings';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- TYPES -- //

type Body = {
	requests: { id: string; status: string; target: string }[];
	batchId: string | null;
	link: string | null;
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

	it('with the switch off a request is refused with a plain sentence that names the switch', async () => {
		const r = await ask(laptop, [{ action: 'secrets', target: 'mangoman/HAPRM' }]);
		expect(r.status).toBe(403);
		expect(JSON.stringify(r.body)).toMatch(/Agent access/);
		expect(JSON.stringify(r.body)).not.toMatch(/terminal/);
	});

	it('with the switch on a request is approved at once, claimed once, and the history says auto', async () => {
		await setAutoApprove(as('admin'), true);
		const asked = await ask(laptop, [{ action: 'secrets', target: 'MangoMan/HAPRM' }], {
			why: 'Import the test keys'
		});
		expect(asked.status).toBe(200);
		expect(asked.body.requests[0]).toMatchObject({ target: 'mangoman/haprm', status: 'approved' });
		expect(asked.body.link).toContain('/settings?tab=agent-access');
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
		expect(events.length).toBeGreaterThanOrEqual(2);
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

	it('the switch is per person: the owner turning theirs on does not cover the admin machines, and the admin machines still work', async () => {
		expect((await ask(ownerBox, [{ action: 'roots', target: '/o/1' }])).status).toBe(403);
		await setAutoApprove(as('owner'), true);
		expect((await ask(ownerBox, [{ action: 'roots', target: '/o/1' }])).status).toBe(200);
		await setAutoApprove(as('owner'), false);
		expect((await ask(ownerBox, [{ action: 'roots', target: '/o/2' }])).status).toBe(403);
		// The admin switch was not touched by the owner's changes
		expect((await ask(laptop, [{ action: 'pictures', target: 'still-on' }])).status).toBe(200);
	});

	it('turning the switch off withdraws unclaimed approvals, and a claim after that finds nothing', async () => {
		await setAutoApprove(as('admin'), false);
		expect((await ask(laptop, [{ action: 'secrets', target: 'after/off' }])).status).toBe(403);
		await setAutoApprove(as('admin'), true);
		const fresh = await ask(laptop, [{ action: 'secrets', target: 'withdraw/me' }]);
		const id = fresh.body.requests[0]!.id;
		await setAutoApprove(as('admin'), false);
		expect((await call(laptop, '/approvals/claim', { ids: [id] })).body.claimed).toHaveLength(0);
		await setAutoApprove(as('admin'), true);
	});

	it('a claim re-checks the switch: an auto row whose switch vanished is not claimable', async () => {
		const asked = await ask(laptop, [{ action: 'secrets', target: 'recheck/me' }]);
		const id = asked.body.requests[0]!.id;
		await db.admin.exec(
			`update org set settings = settings - 'autoApproveBy' where id = '${w.orgId}'`
		);
		expect((await call(laptop, '/approvals/claim', { ids: [id] })).body.claimed).toHaveLength(0);
		await setAutoApprove(as('admin'), true);
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

	it('NEG turning the switch on is refused for a token, an MCP session, a tool actor, an agent, a member and a viewer', async () => {
		await setAutoApprove(as('admin'), false);
		for (const extra of [
			{ tokenId: 't1' },
			{ sessionId: 's1' },
			{ tokenCaps: ['manage' as const] },
			{ tool: 'claude-code' }
		])
			await expect(
				setAutoApprove({ ...as('admin'), actor: { ...as('admin').actor, ...extra } }, true)
			).rejects.toThrow(/signed in/);
		await expect(
			setAutoApprove({ ...as('admin'), actor: { ...as('admin').actor, kind: 'agent' } }, true)
		).rejects.toThrow();
		await expect(setAutoApprove(as('member'), true)).rejects.toThrow();
		await expect(setAutoApprove(as('viewer'), true)).rejects.toThrow();
		expect((await ask(laptop, [{ action: 'roots', target: '/neg' }])).status).toBe(403);
		await setAutoApprove(as('admin'), true);
	});

	it('NEG the settings route cannot set the switch, and a limits save does not undo it', async () => {
		await updateOrgSettings(as('admin'), {
			autoApproveBy: { [w.people.member]: { at: 'x' } }
		} as never);
		await updateOrgSettings(as('admin'), { tokenMaxDays: 21 });
		const row = await db.admin.query<{ s: Record<string, unknown> }>(
			`select settings as s from org where id = '${w.orgId}'`
		);
		const keys = Object.keys((row[0]!.s.autoApproveBy ?? {}) as object);
		expect(keys).toContain(w.people.admin);
		expect(keys).not.toContain(w.people.member);
		expect(row[0]!.s.tokenMaxDays).toBe(21);
		// Switching off and then saving limits keeps it off
		await setAutoApprove(as('admin'), false);
		await updateOrgSettings(as('admin'), { tokenMaxDays: 30 });
		expect((await getOrgSettings(as('admin'))).autoApprove).toBe(false);
		await setAutoApprove(as('admin'), true);
	});

	it('NEG nobody sees who else turned theirs on', async () => {
		const mine = await getOrgSettings(as('admin'));
		expect(mine.autoApprove).toBe(true);
		expect(JSON.stringify(mine)).not.toContain('autoApproveBy');
		expect(JSON.stringify(await getOrgSettings(as('member')))).not.toContain(w.people.admin);
		expect((await getOrgSettings(as('member'))).autoApprove).toBe(false);
	});

	it('NEG a run key and a bogus token are refused', async () => {
		const keyed = await call('afrun_runs.x.y.z', '/approvals', {
			requestId: rid(),
			entries: [{ action: 'roots', target: '/x' }]
		});
		expect(keyed.status).toBeGreaterThanOrEqual(400);
		expect((await ask('afx_nope', [{ action: 'roots', target: '/x' }])).status).toBe(401);
	});

	it('NEG an owner who lost manage or whose machine has no owner cannot auto-approve', async () => {
		await db.admin.exec(
			`update member set role = 'viewer' where org_id = '${w.orgId}' and user_id = '${w.people.admin}'`
		);
		expect(
			(await ask(laptop, [{ action: 'roots', target: '/demoted' }])).status
		).toBeGreaterThanOrEqual(400);
		await db.admin.exec(
			`update member set role = 'admin' where org_id = '${w.orgId}' and user_id = '${w.people.admin}'`
		);
		const lone = (await registerToolRunner(as('admin'), { name: 'Lone' })).token;
		await db.admin.exec(`update runner set owner_id = null where name = 'Lone'`);
		expect(
			(await ask(lone, [{ action: 'roots', target: '/ownerless' }])).status
		).toBeGreaterThanOrEqual(400);
	});

	it('NEG another org sees nothing and its person cannot change our switch', async () => {
		const other = {
			handle: db,
			orgId: w.other.orgId,
			services,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		const theirs = await approvalList(other);
		expect(theirs.history).toHaveLength(0);
		expect(theirs.enabled).toBe(false);
		await setAutoApprove(other, true);
		const ours = await getOrgSettings(as('admin'));
		expect(ours.autoApprove).toBe(true);
		const rows = await db.admin.query<{ s: Record<string, unknown> }>(
			`select settings as s from org where id = '${w.orgId}'`
		);
		expect(Object.keys((rows[0]!.s.autoApproveBy ?? {}) as object)).not.toContain(w.other.userId);
	});

	it("the list shows only the person's own machines, and a member without manage sees none", async () => {
		const mine = await approvalList(as('admin'));
		expect(mine.canManage).toBe(true);
		expect(mine.history.length).toBeGreaterThan(0);
		expect(mine.history.every((h) => ['Laptop', 'Desk', 'Lone'].includes(h.machine))).toBe(true);
		const owner = await approvalList(as('owner'));
		expect(owner.history.every((h) => h.machine === 'Owner box')).toBe(true);
		const member = await approvalList(as('member'));
		expect(member.canManage).toBe(false);
		expect(member.history).toHaveLength(0);
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
