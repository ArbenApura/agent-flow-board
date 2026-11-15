// THE WHOLE FLOW ONCE: THE BRIDGE'S OWN CODE (askOwner, RunnerBoard, the local code store) TALKING TO THE REAL RUNNER API ON THE EMBEDDED SERVER. AGENT APPROVALS ARE ALWAYS ON, NO SWITCH.
// Unit tests of each half missed real defects before (AFB-20261108-0925), so this one joins them: request, instant approval, claim, mint, and a use of the code.

// IMPORTED DEP-MODULES
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { askOwner } from '../../packages/bridge/src/checks/askBoard';
import { consumeApprovalNote, peekApproval } from '../../packages/bridge/src/checks/approve';
import { RunnerBoard } from '../../packages/bridge/src/checks/board';
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { registerToolRunner } from '../../src/lib/server/ops/environments';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';

// -- FUNCTIONS -- //

describe('agent approvals, end to end', () => {
	let db: TestDb;
	let w: World;
	let home = '';
	let saved: string | undefined;
	const storage = memoryStorage();
	const services = {
		masterKey: MASTER,
		storage,
		runnerQueueMinutes: 10,
		baseUrl: 'http://board.test'
	};
	const as = (who: 'owner' | 'admin') => ({ ...w.ctx(who), services });

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		home = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-e2e-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(home, 'bridge-home');
	}, 240_000);
	afterAll(async () => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(home, { recursive: true, force: true });
		await db?.stop();
	});

	/** A fetch that goes straight into the runner API handler, like the network would. */
	const wire = (): typeof fetch => async (input, init) => {
		const url = new URL(String(input));
		const res = await handleRunnerApi(
			{
				method: init?.method ?? 'GET',
				path: url.pathname.replace('/api/v1', ''),
				query: {},
				headers: new Headers(init?.headers as HeadersInit),
				body: new TextEncoder().encode(String(init?.body ?? '')),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		);
		return new Response(JSON.stringify(res.body), { status: res.status });
	};

	it('an owner who lost manage: the agent gets one plain sentence and no switch to point at', async () => {
		const tool = await registerToolRunner(as('admin'), { name: 'E2E off' });
		const board = new RunnerBoard('http://board.test', tool.token, wire() as never);
		await db.admin.exec(
			`update member set role = 'member' where org_id = '${w.orgId}' and user_id = '${w.people.admin}'`
		);
		const refusal = await askOwner(board, {
			entries: [{ action: 'roots', target: home }],
			waitMinutes: 0,
			pollMs: 1,
			say: () => undefined
		}).then(
			() => '',
			(e: unknown) => (e instanceof Error ? e.message : String(e))
		);
		await db.admin.exec(
			`update member set role = 'admin' where org_id = '${w.orgId}' and user_id = '${w.people.admin}'`
		);
		// The tool's token stops working with its owner's manage role, so the agent is told to connect again, in one plain sentence
		expect(refusal).toMatch(/refused this machine's connection/);
		// The owner is never sent to a terminal while the board can approve (AFB-20261110-1448)
		expect(refusal).not.toMatch(/terminal|switch|Agent access/);
	});

	it('request, instant approval, claim, mint and use: a batch yields exactly its codes, each once, and the owner is never asked', async () => {
		const tool = await registerToolRunner(as('admin'), { name: 'E2E laptop' });
		const board = new RunnerBoard('http://board.test', tool.token, wire() as never);
		const lines: string[] = [];
		const result = await askOwner(board, {
			entries: [
				{ action: 'register', target: 'E2E.example.com' },
				{ action: 'secrets', target: 'acme/E2E' }
			],
			why: 'Set up the live checks',
			waitMinutes: 2,
			pollMs: 1,
			say: (l) => void lines.push(l),
			// Nothing may wait: if the agent ever sleeps, the approval did not come at once
			sleep: async () => {
				throw new Error('the agent waited for a click');
			}
		});
		expect(lines).toEqual([]);
		if (result.state !== 'approved') throw new Error('expected approved');
		expect(result.codes.map((c) => `${c.action}:${c.target}`).sort()).toEqual([
			'register:e2e.example.com',
			'secrets:acme/e2e'
		]);
		const secrets = result.codes.find((c) => c.action === 'secrets')!;
		const register = result.codes.find((c) => c.action === 'register')!;
		// Each code is for its own action and target only
		expect(peekApproval('secrets', 'acme/E2E', register.code)).toBe(false);
		const used = consumeApprovalNote('secrets', 'acme/E2E', secrets.code);
		expect(used.ok).toBe(true);
		expect(consumeApprovalNote('secrets', 'acme/E2E', secrets.code).ok).toBe(false);
		expect(peekApproval('register', 'e2e.example.com', register.code)).toBe(true);
		// Both rows were claimed once: a second claim by the same machine yields nothing
		const rows = await db.admin.query<{ status: string }>(
			`select b.status from bridge_approval b join runner r on r.id = b.runner_id where r.name = 'E2E laptop'`
		);
		expect(rows.map((r) => r.status)).toEqual(['claimed', 'claimed']);
	});
});
