// PHASE C.4 TESTS: VERTICAL-SLICE GATE, CLAIM WAITING STATE, AND UNBLOCK ON VERIFICATION/WAIVER (AFB-20261113-1008)

// IMPORTED DEP-MODULES
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { session } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { claim, startSession } from '../../src/lib/server/mcp/sessions';
import {
	claimCheckJob,
	finishCheckRun,
	requestRun,
	saveCheck,
	storeRunArtifact
} from '../../src/lib/server/ops/checks';
import {
	authenticateRunner,
	createRunner,
	saveEnvironment
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { recordMockupRead } from '../../src/lib/server/ops/mockupReads';
import { publishMockup, readMockupHtml } from '../../src/lib/server/ops/mockups';
import { setMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { addPhase } from '../../src/lib/server/ops/plan';
import { updateProject } from '../../src/lib/server/ops/projects';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { evidenceWaive } from '../../src/lib/server/ops/visibleSteps';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const MOCKUP_HTML = `<!doctype html>
<html>
<head>
<!--afb-kit-->
<meta name="afb-config" content='{"screens":[["slice","Slice"]],"options":[]}'>
</head>
<body><main data-screen="slice">Vertical Slice</main></body>
</html>`;

describe('C.4 opt-in vertical-slice gate and claim waiting lifecycle', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;
	let services: { storage: ReturnType<typeof memoryStorage>; baseUrl: string };
	let auth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;

	const as = (
		who: keyof World['people'],
		extra?: { kind?: 'person' | 'agent'; sessionId?: string }
	) => ({
		...w.ctx(who, extra),
		services
	});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		store = memoryStorage();
		services = { storage: store, baseUrl: 'http://localhost:5180' };
		await setMockupKit(
			as('admin'),
			{ project: w.projectKey, builtFromCommit: 'c400001', summary: 'kit' },
			Buffer.from('<!--afb-kit:start--><style>body{}</style><!--afb-kit:end-->', 'utf8')
		);
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'preview',
			url: 'http://localhost:5180',
			kind: 'preview'
		});
		const r = await createRunner(as('admin'), {
			kind: 'local',
			name: 'c4-runner',
			projects: [w.projectKey]
		});
		auth = (await authenticateRunner(db, r.token))!;
		await updateProject(as('owner'), {
			project: w.projectKey,
			visualEvidenceGate: true,
			screenGlobs: ['src/routes/**', 'src/lib/board/**']
		});
	}, 120_000);

	afterAll(() => db?.stop());

	it('holds phase 2 steps & marks agent claim waiting until phase 1 visible step is verified, then clears cleanly', async () => {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Vertical slice item',
			sliceGate: true,
			phases: [
				{
					key: 'A',
					title: 'Vertical slice 1',
					steps: [{ key: 'A.1', text: 'Build slice screen', files: ['src/routes/+page.svelte'] }]
				},
				{
					key: 'B',
					title: 'Second wave',
					steps: [
						{ key: 'B.1', text: 'Write follow-up helper', files: ['src/lib/server/ops/bar.ts'] }
					]
				}
			],
			manualChecks: [{ key: 'M1', text: 'Compare slice 1', auto: true }]
		});
		const ref = created.ref;
		const pub = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Slice mockup' },
			Buffer.from(MOCKUP_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub.mockup.id);

		const sess = await startSession(as('member', { kind: 'agent' }), { tool: 'claude-code' });
		const agentCtx = as('member', { kind: 'agent', sessionId: sess.sessionId });
		const part = await readMockupHtml(agentCtx, pub.mockup.id);
		await recordMockupRead(agentCtx, {
			mockup: pub.mockup.id,
			version: part.version,
			offset: 0,
			served: part.length,
			length: part.length,
			delivered: true
		});

		// Claiming Phase B while Phase A visible step A.1 is unverified sets waiting blocker
		await claim(agentCtx, sess.sessionId, ref, 'B');
		const [heldSession] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select({ waiting: session.waiting }).from(session).where(eq(session.id, sess.sessionId))
		);
		expect(heldSession?.waiting).toMatchObject({ kind: 'approval', target: ref });

		// Closing B.1 is refused with VISUAL_EVIDENCE_REQUIRED (slice-gate)
		await expect(
			recordSteps(
				agentCtx,
				{ item: ref, marks: [{ key: 'B.1', mark: 'done' }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// Supply passing compare run for A.1 and close A.1 -> waiting blocker clears and B.1 succeeds
		await saveCheck(as('member'), {
			item: ref,
			key: 'M1',
			script: 'compare()',
			requiredTarget: 'preview'
		});
		await requestRun(as('member'), { item: ref, key: 'M1', target: 'preview', step: 'A.1' });
		const job = (await claimCheckJob(db, auth, services))!;
		const mShot = await storeRunArtifact(
			db,
			auth,
			job.id,
			{ filename: 'mockup-slice-1280px.jpg', caption: 'Mockup', bytes: JPEG_BYTES },
			services
		);
		const aShot = await storeRunArtifact(
			db,
			auth,
			job.id,
			{ filename: 'app-slice-1280px.jpg', caption: 'App', bytes: JPEG_BYTES },
			services
		);
		const diffAtt = await storeRunArtifact(
			db,
			auth,
			job.id,
			{
				filename: 'compare-diff.json',
				caption: 'Compare diff',
				bytes: Buffer.from(
					JSON.stringify({
						schema: 1,
						passed: true,
						mockupId: pub.mockup.id,
						mockupVersion: pub.version.number,
						totalMismatches: 0,
						pairs: [
							{
								screen: 'slice',
								state: 'default',
								width: 1280,
								diff: { passed: true, comparedCount: 1, mismatches: [], notCompared: [] }
							}
						]
					}),
					'utf8'
				)
			},
			services
		);
		await finishCheckRun(
			db,
			auth,
			job.id,
			{ result: 'pass', evidence: [mShot.attachmentId, aShot.attachmentId, diffAtt.attachmentId] },
			services
		);

		await recordSteps(
			agentCtx,
			{
				item: ref,
				marks: [
					{
						key: 'A.1',
						mark: 'done',
						evidence: { checkRunId: job.id, diffReportId: diffAtt.attachmentId }
					}
				]
			},
			{ agentGate: true }
		);

		const [clearedSession] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select({ waiting: session.waiting }).from(session).where(eq(session.id, sess.sessionId))
		);
		expect(clearedSession?.waiting).toBeNull();

		await recordSteps(
			agentCtx,
			{ item: ref, marks: [{ key: 'B.1', mark: 'done' }] },
			{ agentGate: true }
		);

		// Also verify owner waiver unlocks a held slice directly
		const created2 = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Vertical slice owner waive unlock',
			sliceGate: true,
			phases: [
				{
					key: 'A',
					title: 'Slice 1',
					steps: [{ key: 'A.1', text: 'Visible route', files: ['src/routes/about/+page.svelte'] }]
				},
				{
					key: 'B',
					title: 'Slice 2',
					steps: [{ key: 'B.1', text: 'Backend follow-up', files: ['src/lib/server/ops/x.ts'] }]
				}
			]
		});
		const pub2 = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: created2.ref, title: 'Slice 2 mockup' },
			Buffer.from(MOCKUP_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub2.mockup.id);
		await evidenceWaive(as('owner'), {
			item: created2.ref,
			key: 'A.1',
			reason: 'Owner verified visually'
		});
		const sess2 = await startSession(as('member', { kind: 'agent' }), { tool: 'claude-code' });
		const agentCtx2 = as('member', { kind: 'agent', sessionId: sess2.sessionId });
		const part2 = await readMockupHtml(agentCtx2, pub2.mockup.id);
		await recordMockupRead(agentCtx2, {
			mockup: pub2.mockup.id,
			version: part2.version,
			offset: 0,
			served: part2.length,
			length: part2.length,
			delivered: true
		});
		await recordSteps(
			agentCtx2,
			{ item: created2.ref, marks: [{ key: 'B.1', mark: 'done' }] },
			{ agentGate: true }
		);

		// Verify a second independent session and dynamically added phase are also held until Phase 1 is verified
		const created3 = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Vertical slice dynamic phase + parallel session',
			sliceGate: true,
			phases: [
				{
					key: 'A',
					title: 'Slice 1',
					steps: [{ key: 'A.1', text: 'Visible home page', files: ['src/routes/+page.svelte'] }]
				}
			]
		});
		const pub3 = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: created3.ref, title: 'Slice 3 mockup' },
			Buffer.from(MOCKUP_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub3.mockup.id);
		await addPhase(as('member'), {
			item: created3.ref,
			key: 'C',
			title: 'Dynamic Slice 2',
			steps: [{ key: 'C.1', text: 'Follow-up migration' }]
		});
		const parallelSess = await startSession(as('member', { kind: 'agent' }), {
			tool: 'claude-code'
		});
		const parallelCtx = as('member', { kind: 'agent', sessionId: parallelSess.sessionId });
		const part3 = await readMockupHtml(parallelCtx, pub3.mockup.id);
		await recordMockupRead(parallelCtx, {
			mockup: pub3.mockup.id,
			version: part3.version,
			offset: 0,
			served: part3.length,
			length: part3.length,
			delivered: true
		});
		await expect(
			recordSteps(
				parallelCtx,
				{ item: created3.ref, marks: [{ key: 'C.1', mark: 'done' }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({
			code: 'VISUAL_EVIDENCE_REQUIRED',
			details: { reason: 'slice-gate', gateStep: 'A.1', blockedStep: 'C.1' }
		});
	});
});
