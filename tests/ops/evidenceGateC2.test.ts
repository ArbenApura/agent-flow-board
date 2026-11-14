// PHASE C.2 & C.3 TESTS: VISUAL EVIDENCE GATE ON VISIBLE STEPS & OWNER WAIVER (AFB-20261113-1008)

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
import { createItem, getItem } from '../../src/lib/server/ops/items';
import { recordMockupRead } from '../../src/lib/server/ops/mockupReads';
import { publishMockup, readMockupHtml } from '../../src/lib/server/ops/mockups';
import { setMockupKit } from '../../src/lib/server/ops/mockupSettings';
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
<meta name="afb-config" content='{"screens":[["board","Board"]],"options":[{"key":"mode","label":"Mode","values":[["light","Light"]]}]}'>
</head>
<body><main data-screen="board" data-ref="board-root">Board</main></body>
</html>`;

describe('C.2 & C.3 visual evidence gate and owner waiver', () => {
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
			{ project: w.projectKey, builtFromCommit: 'c200001', summary: 'kit' },
			Buffer.from('<!--afb-kit:start--><style>body{}</style><!--afb-kit:end-->', 'utf8')
		);
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'preview',
			url: 'http://localhost:5180',
			kind: 'preview'
		});
		const runnerCreated = await createRunner(as('admin'), {
			kind: 'local',
			name: 'c2-runner',
			projects: [w.projectKey]
		});
		auth = (await authenticateRunner(db, runnerCreated.token))!;
		await updateProject(as('owner'), {
			project: w.projectKey,
			visualEvidenceGate: true,
			screenGlobs: ['src/routes/**', 'src/lib/board/**']
		});
	}, 120_000);

	afterAll(() => db?.stop());

	it('refuses ticking or waiving visible steps without passed compare evidence, then allows with passed compare run or owner waiver', async () => {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Evidence gated item',
			phases: [
				{
					key: 'A',
					title: 'Screen work',
					steps: [
						{ key: 'A.1', text: 'Server helper', files: ['src/lib/server/ops/foo.ts'] },
						{
							key: 'A.2',
							text: 'Render board view',
							files: ['src/lib/board/ItemLine.svelte'],
							screens: ['board'],
							widths: [1280]
						},
						{
							key: 'A.3',
							text: 'Render secondary banner',
							files: ['src/lib/board/Banner.svelte']
						}
					]
				}
			],
			manualChecks: [{ key: 'M1', text: 'Compare board screen', auto: true }]
		});
		const ref = created.ref;
		const pub = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Board mockup' },
			Buffer.from(MOCKUP_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub.mockup.id);

		// Non-visible step closes freely for an agent
		await recordSteps(
			as('member', { kind: 'agent' }),
			{ item: ref, marks: [{ key: 'A.1', mark: 'done' }] },
			{ agentGate: true }
		);

		// Visible step without compare evidence fails with VISUAL_EVIDENCE_REQUIRED + nextCommand
		let missingErr: unknown;
		try {
			await recordSteps(
				as('member', { kind: 'agent' }),
				{ item: ref, marks: [{ key: 'A.2', mark: 'done' }] },
				{ agentGate: true }
			);
		} catch (e) {
			missingErr = e;
		}
		expect(missingErr).toMatchObject({
			code: 'VISUAL_EVIDENCE_REQUIRED',
			details: {
				reason: 'visual-evidence',
				step: 'A.2',
				nextCommand: expect.stringContaining(`agent-flow-board check compare --item ${ref}`)
			}
		});

		// Agent cannot waive a visible step via mark: 'waived'
		await expect(
			recordSteps(
				as('member', { kind: 'agent' }),
				{ item: ref, marks: [{ key: 'A.2', mark: 'waived', reason: 'skip' }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({
			code: 'VISUAL_EVIDENCE_REQUIRED'
		});

		// Run & store a real passing compare run with paired pictures and compare-diff.json
		await saveCheck(as('member'), {
			item: ref,
			key: 'M1',
			script: 'compare()',
			requiredTarget: 'preview'
		});
		await requestRun(as('member'), { item: ref, key: 'M1', target: 'preview', step: 'A.2' });
		const job = (await claimCheckJob(db, auth, services))!;
		const mShot = await storeRunArtifact(
			db,
			auth,
			job.id,
			{ filename: 'mockup-board-1280px.jpg', caption: 'Mockup board', bytes: JPEG_BYTES },
			services
		);
		const aShot = await storeRunArtifact(
			db,
			auth,
			job.id,
			{ filename: 'app-board-1280px.jpg', caption: 'App board', bytes: JPEG_BYTES },
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
								screen: 'board',
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

		// Agent closes A.2 with valid compare run evidence
		await recordSteps(
			as('member', { kind: 'agent' }),
			{
				item: ref,
				marks: [
					{
						key: 'A.2',
						mark: 'done',
						evidence: { checkRunId: job.id, diffReportId: diffAtt.attachmentId }
					}
				]
			},
			{ agentGate: true }
		);

		// Owner waives A.3 directly in live web session
		await evidenceWaive(as('owner'), {
			item: ref,
			key: 'A.3',
			reason: 'Tested visually on device during review'
		});

		const finalItem = await getItem(as('member'), ref);
		expect(finalItem.item.percent).toBe(100);
		expect(finalItem.item.health.verifiedPercent).toBe(100);
		expect(finalItem.item.health.flags).not.toContain('unverified-visually');
	});

	it('refuses mismatched mockup/version, screen/width gaps, manual/zero-compared runs, and stale runs after code edits (including omitted or rotated session)', async () => {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Negative compare cases',
			phases: [
				{
					key: 'A',
					title: 'Screens',
					steps: [
						{
							key: 'A.1',
							text: 'Render board @ 1280px',
							files: ['src/lib/board/Neg.svelte'],
							screens: ['board'],
							widths: [1280]
						}
					]
				}
			],
			manualChecks: [{ key: 'M1', text: 'Compare board', auto: true }]
		});
		const ref = created.ref;
		const pub1 = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Board v1' },
			Buffer.from(MOCKUP_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub1.mockup.id);

		const makeDiffRun = async (reportObj: Record<string, unknown>) => {
			await saveCheck(as('member'), {
				item: ref,
				key: 'M1',
				script: 'compare()',
				requiredTarget: 'preview'
			});
			await requestRun(as('member'), { item: ref, key: 'M1', target: 'preview' });
			const job = (await claimCheckJob(db, auth, services))!;
			const att = await storeRunArtifact(
				db,
				auth,
				job.id,
				{
					filename: 'compare-diff.json',
					caption: 'Diff',
					bytes: Buffer.from(JSON.stringify(reportObj), 'utf8')
				},
				services
			);
			await finishCheckRun(
				db,
				auth,
				job.id,
				{ result: 'pass', evidence: [att.attachmentId] },
				services
			);
			return { runId: job.id, diffReportId: att.attachmentId };
		};

		// 1. Manual/zero-compared report refused even if report says passed: true
		const zeroRun = await makeDiffRun({
			schema: 1,
			passed: true,
			mockupId: pub1.mockup.id,
			mockupVersion: pub1.version.number,
			totalMismatches: 0,
			totalNotCompared: 1,
			pairs: [
				{
					screen: 'board',
					state: 'default',
					width: 1280,
					diff: { passed: true, comparedCount: 0, mismatches: [], notCompared: [{ ref: '*' }] }
				}
			]
		});
		await expect(
			recordSteps(
				as('member', { kind: 'agent' }),
				{ item: ref, marks: [{ key: 'A.1', mark: 'done', evidence: zeroRun }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// 2. Screen/width mismatch refused
		const wrongWidthRun = await makeDiffRun({
			schema: 1,
			passed: true,
			mockupId: pub1.mockup.id,
			mockupVersion: pub1.version.number,
			totalMismatches: 0,
			pairs: [
				{
					screen: 'board',
					state: 'default',
					width: 390,
					diff: { passed: true, comparedCount: 2, mismatches: [], notCompared: [] }
				}
			]
		});
		await expect(
			recordSteps(
				as('member', { kind: 'agent' }),
				{ item: ref, marks: [{ key: 'A.1', mark: 'done', evidence: wrongWidthRun }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// 3. Valid run captured before a code edit becomes stale even when caller omits sessionId or rotates session
		const goodRun = await makeDiffRun({
			schema: 1,
			passed: true,
			mockupId: pub1.mockup.id,
			mockupVersion: pub1.version.number,
			totalMismatches: 0,
			pairs: [
				{
					screen: 'board',
					state: 'default',
					width: 1280,
					diff: { passed: true, comparedCount: 3, mismatches: [], notCompared: [] }
				}
			]
		});
		const s1 = await startSession(as('member', { kind: 'agent' }), { tool: 'claude-code' });
		const ctx1 = as('member', { kind: 'agent', sessionId: s1.sessionId });
		await claim(ctx1, s1.sessionId, ref);
		const part1 = await readMockupHtml(ctx1, pub1.mockup.id);
		await recordMockupRead(ctx1, {
			mockup: pub1.mockup.id,
			version: part1.version,
			offset: 0,
			served: part1.length,
			length: part1.length,
			delivered: true
		});
		await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx
				.update(session)
				.set({ codeTouchedAt: new Date(Date.now() + 60_000) })
				.where(eq(session.id, s1.sessionId))
		);

		// Omitted sessionId still blocked by active claimed session's codeTouchedAt
		await expect(
			recordSteps(
				as('member', { kind: 'agent' }),
				{ item: ref, marks: [{ key: 'A.1', mark: 'done', evidence: goodRun }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// Fresh rotated session s2 still blocked by open claimed session s1's codeTouchedAt
		const s2 = await startSession(as('member', { kind: 'agent' }), { tool: 'claude-code' });
		const ctx2 = as('member', { kind: 'agent', sessionId: s2.sessionId });
		const part2 = await readMockupHtml(ctx2, pub1.mockup.id);
		await recordMockupRead(ctx2, {
			mockup: pub1.mockup.id,
			version: part2.version,
			offset: 0,
			served: part2.length,
			length: part2.length,
			delivered: true
		});
		await expect(
			recordSteps(
				ctx2,
				{ item: ref, marks: [{ key: 'A.1', mark: 'done', evidence: goodRun }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// Clear s1's codeTouchedAt, then publish v2 mockup -> v1 run refused as outdated mockup version
		await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.update(session).set({ codeTouchedAt: null }).where(eq(session.id, s1.sessionId))
		);
		const pub2 = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Board v2' },
			Buffer.from(MOCKUP_HTML.replace('Board</main>', 'Board v2</main>'), 'utf8')
		);
		const partV2 = await readMockupHtml(ctx2, pub2.mockup.id);
		await recordMockupRead(ctx2, {
			mockup: pub2.mockup.id,
			version: partV2.version,
			offset: 0,
			served: partV2.length,
			length: partV2.length,
			delivered: true
		});
		await expect(
			recordSteps(
				ctx2,
				{ item: ref, marks: [{ key: 'A.1', mark: 'done', evidence: goodRun }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// Missing comparedCount or missing notComparedCount fails closed with VISUAL_EVIDENCE_REQUIRED
		const missingCountsRun = await makeDiffRun({
			schema: 1,
			passed: true,
			mockupId: pub1.mockup.id,
			mockupVersion: pub1.version.number,
			totalMismatches: 0,
			totalNotCompared: 0,
			pairs: [{ screen: 'board', state: 'default', width: 1280, passed: true, mismatchCount: 0 }]
		});
		await expect(
			recordSteps(
				ctx2,
				{ item: ref, marks: [{ key: 'A.1', mark: 'done', evidence: missingCountsRun }] },
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// 4. Live person session can tick without compare evidence (creates honest unverified gap)
		await recordSteps(as('owner'), { item: ref, marks: [{ key: 'A.1', mark: 'done' }] });
		const liveItem = await getItem(as('owner'), ref);
		expect(liveItem.item.percent).toBe(100);
		expect(liveItem.item.health?.flags).toContain('unverified-visually');
	});
});
