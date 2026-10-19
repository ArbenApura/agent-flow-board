// OLD TOOLS KEEP WORKING (AFB-20261019-0510 STEP 5.3): everything added to the checks and the runner API is additive. A tool built before the heartbeat, the codes and the
// wait option claims, runs and finishes exactly as before, and the shapes it reads only gained fields.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import {
	TOOL_PROTOCOL_HEADER,
	TOOL_PROTOCOL_MIN,
	authenticateRunner,
	registerToolRunner
} from '../../src/lib/server/ops/environments';
import { itemChecks, requestRun, saveCheck } from '../../src/lib/server/ops/checks';
import { createItem } from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';
/** The keys of a run as every reader had them before 2026-10-19. A reader of these keys must still find every one. */
const OLD_RUN_KEYS = [
	'id',
	'target',
	'requestedTarget',
	'url',
	'commit',
	'diffHash',
	'durationMs',
	'result',
	'flaky',
	'reason',
	'stepKey',
	'evidence',
	'requestedBy',
	'createdAt',
	'startedAt',
	'finishedAt'
];
const OLD_REQUEST_KEYS = ['run', 'unavailable', 'offer', 'target'];

// -- FUNCTIONS -- //

describe('a tool from before the heartbeat', () => {
	let db: TestDb;
	let w: World;
	let token = '';
	const storage = memoryStorage('compat-storage-secret-0123456789abcdef');
	const as = (who: 'admin' | 'member') => ({
		...w.ctx(who),
		services: { masterKey: MASTER, storage, runnerQueueMinutes: 10 }
	});
	const call = (method: string, path: string, body = '', headers: Record<string, string> = {}) =>
		handleRunnerApi(
			{
				method,
				path: `/runner${path}`,
				query: {},
				headers: new Headers({ authorization: `Bearer ${token}`, ...headers }),
				body: new TextEncoder().encode(body),
				session: null
			},
			{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		token = (await registerToolRunner(as('admin'), { name: 'Old PC afb-checks' })).token;
		await authenticateRunner(db, token);
	}, 240_000);
	afterAll(() => db?.stop());

	it('claims, runs and finishes with the calls it always had, never beats, and is not swept at ten minutes', async () => {
		const made = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Compat item',
			phases: [
				{
					key: '1',
					title: 'Build',
					steps: [{ text: 'Run it', requiredTarget: 'preview' as const }]
				}
			],
			manualChecks: [{ key: 'M1', text: 'Works' }]
		});
		await saveCheck(as('member'), { item: made.ref, key: 'M1', script: 's' });
		const asked = await requestRun(as('member'), {
			item: made.ref,
			key: 'M1',
			target: 'preview',
			step: '1.1'
		});
		// What a reader of the answer had before is still there, and only fields were added
		for (const k of OLD_REQUEST_KEYS) expect(asked, k).toHaveProperty(k);
		for (const k of OLD_RUN_KEYS) expect(asked.run, k).toHaveProperty(k);
		const claimed = await call('POST', '/claim', '', {
			[TOOL_PROTOCOL_HEADER]: String(TOOL_PROTOCOL_MIN)
		});
		expect(claimed.status).toBe(200);
		const job = (
			claimed.body as { job: { id: string; kind: string; check: { key: string; script: string } } }
		).job;
		expect(job).toMatchObject({
			id: asked.run.id,
			kind: 'check',
			check: { key: 'M1', script: 's' }
		});
		// It runs for twenty minutes without a single beat: the longer rule keeps it
		await db.admin.exec(
			`update check_run set started_at = now() - interval '20 minutes' where id = '${job.id}'`
		);
		const view = (await itemChecks(as('member'), made.ref)).checks[0].runs[0];
		expect(view.result).toBe('running');
		for (const k of OLD_RUN_KEYS) expect(view, k).toHaveProperty(k);
		const done = await call(
			'POST',
			`/runs/${job.id}/finish`,
			JSON.stringify({ result: 'pass', durationMs: 1200 }),
			{ [TOOL_PROTOCOL_HEADER]: '1' }
		);
		expect(done.status).toBe(200);
		expect((await itemChecks(as('member'), made.ref)).checks[0].runs[0].result).toBe('pass');
		const beats = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from check_run where last_beat_at is not null`
		);
		expect(beats[0].n).toBe(0);
	});

	it('is still refused with the plain upgrade line when it is older than the board allows, and one that names no version is unchanged', async () => {
		const tooOld = await call('POST', '/peek', '', {
			[TOOL_PROTOCOL_HEADER]: String(TOOL_PROTOCOL_MIN - 1)
		});
		expect(tooOld.status).toBe(426);
		expect(JSON.stringify(tooOld.body)).toMatch(/too old for this board/);
		expect((await call('POST', '/peek')).status).toBe(200);
		expect(
			(await call('POST', '/peek', '', { [TOOL_PROTOCOL_HEADER]: String(TOOL_PROTOCOL_MIN + 1) }))
				.status
		).toBe(200);
	});
});
