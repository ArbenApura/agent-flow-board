// THE QA MAP TOOLS THROUGH A REAL CLIENT (AFB-20261125-0442): MAP, MERGE, RUN, RESULTS AND PLAN LINKS, WITH THE SESSION AND TOKEN LIMITS

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
const TOOLS = ['qa_map_get', 'qa_map_merge', 'qa_run_start', 'qa_result', 'qa_plan_link'];
const MAP = {
	journeys: [
		{
			key: 'new',
			name: 'New estimate',
			steps: [
				{
					key: 'open',
					page: '/planning',
					action: 'Click New estimate',
					expected: { screen: 'Brief form opens' },
					cases: [{ key: 'click', input: 'click', expected: 'Form opens' }]
				}
			]
		}
	]
};

// -- FUNCTIONS -- //

describe('qa tools', () => {
	let db: TestDb;
	let w: World;
	let member: Awaited<ReturnType<typeof connect>>;
	let reader: Awaited<ReturnType<typeof connect>>;
	let sessionId = '';

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const deps = {
			handle: db,
			storage: memoryStorage('mcp-qa-secret-0123456789abcdef01'),
			baseUrl: BASE
		};
		const tokenFor = async (who: keyof World['people'], permissions: string[], name: string) =>
			(await createToken(w.ctx(who), { name, permissions: permissions as never })).token;
		member = await connect(deps, await tokenFor('member', ALL.slice(0, 5), 'qa-agent'));
		reader = await connect(deps, await tokenFor('member', ['read'], 'qa-reader'));
		sessionId = (await call(member, 'session_start', { tool: 'claude-code' })).sessionId;
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	it('lists the five tools with short descriptions', async () => {
		const tools = (await member.listTools()).tools;
		for (const n of TOOLS) {
			const t = tools.find((x) => x.name === n);
			expect(t, n).toBeDefined();
			expect((t?.description ?? '').length, n).toBeLessThan(330);
		}
	});

	it('merges a feature, runs it, records a result with proof and links a plan', async () => {
		const merged = await call(member, 'qa_map_merge', {
			sessionId,
			requestId: 'qa-mcp-merge-1',
			project: w.projectKey,
			features: [
				{
					key: 'estimate',
					name: 'Event estimate',
					codeGlobs: ['src/planning/**'],
					sizes: [1440],
					map: MAP
				}
			]
		});
		expect(merged.features[0].created).toBe(true);
		const map = await call(member, 'qa_map_get', { sessionId, project: w.projectKey });
		expect(map.untrusted).toBe(true);
		expect(map.features[0].status).toBe('not_tested');
		const run = await call(member, 'qa_run_start', {
			sessionId,
			requestId: 'qa-mcp-run-1',
			project: w.projectKey,
			target: 'http://localhost:7174/planning',
			commit: 'abc1234'
		});
		expect(run.writes).toBe(false);
		const recorded = await call(member, 'qa_result', {
			sessionId,
			requestId: 'qa-mcp-res-1',
			run: run.run,
			results: [
				{
					feature: 'estimate',
					caseKey: 'new/open/click',
					outcome: 'works',
					width: 1440,
					mode: 'light',
					observed: 'The brief form opened'
				}
			],
			summary: 'One case, it works.',
			confidence: '1 check with proof'
		});
		expect(recorded.recorded).toBe(1);
		expect(recorded.report.confidence).toBe('1 check with proof');
		const after = await call(member, 'qa_map_get', {
			sessionId,
			project: w.projectKey,
			feature: 'estimate'
		});
		expect(after.features[0].status).toBe('works');
		const plan = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Touches planning',
			...PLAN
		});
		const linked = await call(member, 'qa_plan_link', {
			sessionId,
			requestId: 'qa-mcp-link-1',
			item: plan.ref,
			files: ['src/planning/+page.svelte']
		});
		expect(linked.features[0].key).toBe('estimate');
		expect(linked.features[0].baseline).toBe('works');
	});

	it('refuses a reader that tries to write and a target that is not allowed', async () => {
		const denied = await call(reader, 'qa_map_merge', {
			project: w.projectKey,
			features: [{ key: 'nope', name: 'Nope', map: MAP }]
		});
		expect(denied.error?.code).toBe('FORBIDDEN');
		const live = await call(member, 'qa_run_start', {
			sessionId,
			requestId: 'qa-mcp-run-2',
			project: w.projectKey,
			target: 'https://live.example.com'
		});
		expect(live.error?.code).toBe('INVALID');
	});
});
