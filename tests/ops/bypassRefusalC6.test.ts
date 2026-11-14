// PHASE C.6 TESTS: EVIDENCE GATE BYPASS REFUSAL & NO SIDE EFFECTS ON FAILURE (AFB-20261113-1008)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
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
import { createItem, getItem, updateItem } from '../../src/lib/server/ops/items';
import { listEvents, undoChange } from '../../src/lib/server/ops/history';
import { publishMockup, readMockupHtml } from '../../src/lib/server/ops/mockups';
import { setMockupKit } from '../../src/lib/server/ops/mockupSettings';
import { addPhase, addSteps, updateStep } from '../../src/lib/server/ops/plan';
import { updateProject } from '../../src/lib/server/ops/projects';
import { setStatus } from '../../src/lib/server/ops/status';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { evidenceWaive } from '../../src/lib/server/ops/visibleSteps';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const MOCKUP_HTML = `<!doctype html>
<html>
<head>
<!--afb-kit-->
<meta name="afb-config" content='{"screens":[["home","Home"]],"options":[]}'>
</head>
<body><main data-screen="home">Home</main></body>
</html>`;

describe('C.6 bypass refusals across role, token, gate switches, and mismatched compare runs', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;
	let services: { storage: ReturnType<typeof memoryStorage>; baseUrl: string };
	let auth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;

	const as = (
		who: keyof World['people'],
		extra?: {
			kind?: 'person' | 'agent';
			tokenId?: string;
			tokenCaps?: ('read' | 'write' | 'manage')[];
		}
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
			{ project: w.projectKey, builtFromCommit: 'c600001', summary: 'kit' },
			Buffer.from('<!--afb-kit:start--><style>body{}</style><!--afb-kit:end-->', 'utf8')
		);
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'preview',
			url: 'http://localhost:5180',
			kind: 'preview'
		});
		const createdRunner = await createRunner(as('admin'), {
			kind: 'local',
			name: 'c6-runner',
			projects: [w.projectKey]
		});
		auth = (await authenticateRunner(db, createdRunner.token))!;
		await updateProject(as('owner'), {
			project: w.projectKey,
			visualEvidenceGate: true,
			screenGlobs: ['src/routes/**', 'src/lib/ui/**']
		});
	}, 120_000);

	afterAll(() => db?.stop());

	it('refuses agent/token/non-owner attempts to waive evidence, flip gate switches, or reuse failing runs', async () => {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Bypass guard item',
			sliceGate: true,
			phases: [
				{
					key: 'A',
					title: 'UI',
					steps: [{ key: 'A.1', text: 'Build UI card', files: ['src/lib/ui/Card.svelte'] }]
				}
			],
			manualChecks: [{ key: 'M1', text: 'Visual check', auto: true }]
		});
		const ref = created.ref;
		const pub = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Card mockup' },
			Buffer.from(MOCKUP_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub.mockup.id);

		// 1. Agent or API token acting as owner cannot waive visual evidence
		await expect(
			evidenceWaive(as('owner', { kind: 'agent' }), { item: ref, key: 'A.1', reason: 'Agent try' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		await expect(
			evidenceWaive(as('owner', { tokenId: 'tok_owner', tokenCaps: ['manage'] }), {
				item: ref,
				key: 'A.1',
				reason: 'Token try'
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// 2. Non-owner live sessions (admin, member, viewer) cannot waive visual evidence
		for (const role of ['admin', 'member', 'viewer'] as const) {
			await expect(
				evidenceWaive(as(role), { item: ref, key: 'A.1', reason: 'Non-owner try' })
			).rejects.toMatchObject({ code: 'FORBIDDEN' });
		}

		// 3. Agents / tokens cannot turn off project visualEvidenceGate or screenGlobs
		await expect(
			updateProject(as('owner', { kind: 'agent' }), {
				project: w.projectKey,
				visualEvidenceGate: false
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		await expect(
			updateProject(as('owner', { tokenId: 'tok_admin', tokenCaps: ['manage'] }), {
				project: w.projectKey,
				screenGlobs: ['never/match/**']
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// 4. Agents / tokens cannot turn off item.sliceGate
		await expect(
			updateItem(as('owner', { kind: 'agent' }), { item: ref, sliceGate: false })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// 5. Failing compare run with mismatches cannot satisfy visible step evidence
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
			{ filename: 'mockup-home-1280px.jpg', caption: 'Mockup', bytes: JPEG_BYTES },
			services
		);
		const aShot = await storeRunArtifact(
			db,
			auth,
			job.id,
			{ filename: 'app-home-1280px.jpg', caption: 'App', bytes: JPEG_BYTES },
			services
		);
		const badDiff = await storeRunArtifact(
			db,
			auth,
			job.id,
			{
				filename: 'compare-diff.json',
				caption: 'Drift found',
				bytes: Buffer.from(
					JSON.stringify({
						schema: 1,
						passed: false,
						mockupId: pub.mockup.id,
						mockupVersion: pub.version.number,
						totalMismatches: 1,
						pairs: [
							{
								screen: 'home',
								state: 'default',
								width: 1280,
								diff: { passed: false, mismatches: [{ ref: 'hero' }], notCompared: [] }
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
			{
				result: 'fail',
				reason: 'Visual drift',
				evidence: [mShot.attachmentId, aShot.attachmentId, badDiff.attachmentId]
			},
			services
		);

		await expect(
			recordSteps(
				as('member', { kind: 'agent' }),
				{
					item: ref,
					marks: [
						{
							key: 'A.1',
							mark: 'done',
							evidence: { checkRunId: job.id, diffReportId: badDiff.attachmentId }
						}
					]
				},
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// Verify step remained open (no side effects behind refusal)
		const unchanged = await getItem(as('member'), ref);
		expect(unchanged.phases[0]?.steps[0]?.state).toBe('open');
	});

	it('refuses structural bypasses via step_update, mark superseded, setStatus IN REVIEW, and undo on sliceGate or visible steps', async () => {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Structural bypass item',
			sliceGate: true,
			phases: [
				{
					key: 'A',
					title: 'Visible phase',
					steps: [
						{
							key: 'A.1',
							text: 'Build UI dialog',
							visible: true,
							files: ['src/lib/ui/Modal.svelte'],
							screens: ['home'],
							widths: [1280]
						}
					]
				}
			]
		});
		const ref = created.ref;
		const pub = await publishMockup(
			as('member'),
			{ project: w.projectKey, item: ref, title: 'Modal mockup' },
			Buffer.from(MOCKUP_HTML, 'utf8')
		);
		await readMockupHtml(as('member'), pub.mockup.id);

		// 1. Agents cannot strip visibility, drop files/screens/widths, reword, or remove visible steps via updateStep
		for (const patch of [
			{ item: ref, key: 'A.1', visible: false },
			{ item: ref, key: 'A.1', visible: null },
			{ item: ref, key: 'A.1', files: [] },
			{ item: ref, key: 'A.1', screens: [] },
			{ item: ref, key: 'A.1', widths: [] },
			{ item: ref, key: 'A.1', text: 'Reworded quietly' },
			{ item: ref, key: 'A.1', remove: true }
		]) {
			await expect(updateStep(as('member', { kind: 'agent' }), patch)).rejects.toMatchObject({
				code: 'FORBIDDEN'
			});
		}

		// 2. Agents cannot supersede a visible step without compare evidence or owner waiver
		await expect(
			recordSteps(
				as('member', { kind: 'agent' }),
				{
					item: ref,
					marks: [
						{ key: 'A.1', mark: 'superseded', supersededBy: 'AFB-999', note: 'Replaced elsewhere' }
					]
				},
				{ agentGate: true }
			)
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// 3. Cannot move gated item with open visible steps to IN REVIEW
		await expect(
			setStatus(as('member', { kind: 'agent' }), {
				item: ref,
				status: 'IN REVIEW',
				note: 'Skipping compare check'
			})
		).rejects.toMatchObject({ code: 'VISUAL_EVIDENCE_REQUIRED' });

		// 4. Undo cannot turn off sliceGate (after live person toggled it) or undo visible step creation under sliceGate
		const nonSlice = await createItem(as('owner'), {
			project: w.projectKey,
			title: 'Toggle sliceGate undo test',
			sliceGate: false,
			phases: [{ key: 'A', title: 'S1', steps: [{ key: 'A.1', text: 'Backend task' }] }]
		});
		await updateItem(as('owner'), { item: nonSlice.ref, sliceGate: true });
		const sliceEvents = await listEvents(as('owner'), {
			project: w.projectKey,
			item: nonSlice.ref
		});
		const sliceEvent = sliceEvents.find((e) => e.verb === 'item.update');
		expect(sliceEvent).toBeTruthy();
		await expect(undoChange(as('owner', { kind: 'agent' }), sliceEvent!.id)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const sliceAfter = await getItem(as('owner'), nonSlice.ref);
		expect(sliceAfter.item.sliceGate).toBe(true);

		// Live owner temporarily disables visualEvidenceGate -> sliceGate alone still blocks undoing visible step creation
		await updateProject(as('owner'), { project: w.projectKey, visualEvidenceGate: false });
		try {
			await addSteps(as('member'), {
				item: nonSlice.ref,
				phase: 'A',
				steps: [{ key: 'A.2', text: 'Visible slice gate step', visible: true }]
			});
			const evs = await listEvents(as('owner'), { project: w.projectKey, item: nonSlice.ref });
			const createEv = evs.find((e) => e.verb === 'step.create');
			expect(createEv).toBeTruthy();
			await expect(undoChange(as('member', { kind: 'agent' }), createEv!.id)).rejects.toMatchObject(
				{ code: 'VISUAL_EVIDENCE_REQUIRED' }
			);
			const afterCreateUndo = await getItem(as('owner'), nonSlice.ref);
			expect(afterCreateUndo.phases[0]?.steps.map((s) => s.key)).toEqual(['A.1', 'A.2']);
		} finally {
			await updateProject(as('owner'), { project: w.projectKey, visualEvidenceGate: true });
		}

		// 5. Agents cannot pre-mark visible: false before a mockup is linked (via createItem, addPhase, addSteps, or updateStep)
		const beforeItem = await getItem(as('member'), ref);
		const preLinkRef = (
			await createItem(as('member', { kind: 'agent' }), {
				project: w.projectKey,
				title: 'Pre-mockup bypass check',
				phases: [
					{
						key: 'A',
						title: 'Screen build',
						steps: [{ key: 'A.1', text: 'Render screen', files: ['src/lib/board/ItemLine.svelte'] }]
					}
				]
			})
		).ref;
		await expect(
			createItem(as('member', { kind: 'agent' }), {
				project: w.projectKey,
				title: 'Agent pre-suppressed item',
				phases: [
					{
						key: 'A',
						title: 'Screen build',
						steps: [
							{
								key: 'A.1',
								text: 'Render hidden screen',
								files: ['src/lib/board/ItemLine.svelte'],
								visible: false
							}
						]
					}
				]
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			addPhase(as('member', { kind: 'agent' }), {
				item: preLinkRef,
				key: 'B',
				title: 'Blocked phase',
				steps: [{ key: 'B.1', text: 'Pre-suppressed', visible: false }]
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			addSteps(as('member', { kind: 'agent' }), {
				item: preLinkRef,
				phase: 'A',
				steps: [{ key: 'A.2', text: 'Pre-suppressed step', visible: false }]
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			updateStep(as('member', { kind: 'agent' }), {
				item: preLinkRef,
				key: 'A.1',
				visible: false
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// Verify zero side effects persisted behind any of the refusals
		const preAfter = await getItem(as('member'), preLinkRef);
		expect(preAfter.phases.map((p) => p.key)).toEqual(['A']);
		expect(preAfter.phases[0]?.steps.map((s) => s.key)).toEqual(['A.1']);
		expect(preAfter.phases[0]?.steps[0]?.visible).toBeNull();
		const afterItem = await getItem(as('member'), ref);
		expect(afterItem.item.status).toBe(beforeItem.item.status);
		expect(afterItem.phases[0]?.steps[0]?.state).toBe('open');
		expect(afterItem.phases[0]?.steps[0]?.text).toBe(beforeItem.phases[0]?.steps[0]?.text);
	});
});
