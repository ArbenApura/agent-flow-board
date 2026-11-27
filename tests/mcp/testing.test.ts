// THE TESTING MCP TOOLS THROUGH A REAL CLIENT (AFB-20261127-0438): THE QA MAP TOOLS ARE GONE, A CASE IS WRITTEN, ADOPTED, RUN WITH
// PROOF AND READ BACK, A READER CANNOT WRITE, AND NOTHING A READER GETS CARRIES A STORAGE KEY

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createItem } from '../../src/lib/server/ops/items';
import { createToken } from '../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../support/db';
import { call, connect } from '../support/mcp';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const ALL = ['read', 'comment', 'write', 'complete', 'delete', 'manage'] as const;
/** A small PNG-looking file with a real header, 1280 px wide, made different by its last byte. */
const b64 = (n: number) => {
	const b = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
	b[11] = 13;
	b.write('IHDR', 12, 'ascii');
	b.writeUInt32BE(1280, 16);
	b.writeUInt32BE(800, 20);
	b[30] = n % 256;
	return b.toString('base64');
};
const CASE = {
	area: 'apps/web/auth',
	kind: 'ui',
	title: 'A member signs in and lands on the board',
	steps: [{ action: 'Open the sign-in page' }, { action: 'Sign in as the test member' }],
	checks: [{ kind: 'url', expect: '/board' }],
	devices: [{ device: 'laptop', width: 1280, height: 800 }]
};

// -- FUNCTIONS -- //

describe('testing tools', () => {
	let db: TestDb;
	let w: World;
	let member: Awaited<ReturnType<typeof connect>>;
	let reader: Awaited<ReturnType<typeof connect>>;
	let ref = '';
	let sessionId = '';
	let readerSession = '';

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const deps = {
			handle: db,
			storage: memoryStorage('mcp-testing-secret-0123456789abc'),
			baseUrl: BASE
		};
		const tokenFor = async (who: keyof World['people'], permissions: string[], name: string) =>
			(await createToken(w.ctx(who), { name, permissions: permissions as never })).token;
		member = await connect(deps, await tokenFor('member', ALL.slice(0, 5), 'member-agent'));
		reader = await connect(deps, await tokenFor('member', ['read'], 'reader-agent'));
		ref = (
			await createItem(w.ctx('member'), { project: w.projectKey, title: 'Testing tools', ...PLAN })
		).ref;
		sessionId = (await call(member, 'session_start', { tool: 'claude-code' })).sessionId;
		readerSession = (await call(reader, 'session_start', { tool: 'claude-code' })).sessionId;
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	it('lists the testing tools and none of the QA map tools', async () => {
		const names = (await member.listTools()).tools.map((t) => t.name);
		for (const n of [
			'testcase_list',
			'testcase_save',
			'testcase_retire',
			'test_plan_cases',
			'test_run_start',
			'test_result',
			'test_run_finish',
			'test_surfaces'
		])
			expect(names).toContain(n);
		for (const n of ['qa_map_get', 'qa_map_merge', 'qa_plan_link', 'qa_run_start', 'qa_result'])
			expect(names).not.toContain(n);
	});

	it('writes a case for a plan, runs it with proof and reads it back', async () => {
		const saved = await call(member, 'testcase_save', {
			sessionId,
			project: w.projectKey,
			plan: ref,
			...CASE
		});
		expect(saved.case.key).toBe('TC-AUTH-01');
		expect(saved.case.version).toBe(1);

		const started = await call(member, 'test_run_start', {
			sessionId,
			project: w.projectKey,
			item: ref,
			objective: 'The sign-in case of this plan'
		});
		expect(started.item).toBe(ref);
		const done = await call(member, 'test_result', {
			sessionId,
			run: started.run,
			results: [
				{
					case: 'TC-AUTH-01',
					device: 'laptop',
					status: 'pass',
					actual: 'Landed on the board.',
					proofs: [{ data: b64(1) }]
				}
			]
		});
		expect(done.saved).toHaveLength(1);
		const finished = await call(member, 'test_run_finish', { sessionId, run: started.run });
		expect(finished.state).toBe('finished');

		const one = await call(member, 'testcase_list', { project: w.projectKey, case: 'TC-AUTH-01' });
		expect(JSON.stringify(one)).toContain('Landed on the board.');
		const sheet = await call(reader, 'testcase_list', { project: w.projectKey });
		expect(JSON.stringify(sheet)).toContain('TC-AUTH-01');
		// Nothing a reader gets carries a storage key
		expect(JSON.stringify(sheet)).not.toMatch(/storage|testproofs\//);
		expect(JSON.stringify(one)).not.toMatch(/storageKey|testproofs\//);
	});

	it('refuses a UI pass with no picture, and a reader that tries to write', async () => {
		const started = await call(member, 'test_run_start', {
			sessionId,
			project: w.projectKey,
			item: ref
		});
		const bare = await call(member, 'test_result', {
			sessionId,
			run: started.run,
			results: [{ case: 'TC-AUTH-01', device: 'laptop', status: 'pass', actual: 'ok' }]
		});
		expect(bare.error?.code).toBe('PROOF_REQUIRED');
		const byReader = await call(reader, 'testcase_save', {
			sessionId: readerSession,
			project: w.projectKey,
			...CASE,
			title: 'A reader writes a case'
		});
		expect(byReader.error).toBeDefined();
	});
});
