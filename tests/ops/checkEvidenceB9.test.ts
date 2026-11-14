// EVIDENCE STORAGE RULES (STEP B.9, AFB-20261113-1008)
// Per-run limits for picture pairs and diff reports, step pinning past retention, MOCKUP_KEY_PREFIX storage, missing pair refusal,
// uploadSignedInPictures enforcement, public-item refusal, escaped diff text, and sandbox + nosniff serving headers.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { exportOrg } from '../../src/lib/server/backup/dump';
import { attachment, checkRun, step } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { isMockupKey } from '../../src/lib/server/mockups/keys';
import {
	addAttachment,
	deleteAttachment,
	serveAttachmentResponse,
	setAttachmentVisibility
} from '../../src/lib/server/ops/attachments';
import {
	MAX_COMPARE_DIFF_BYTES,
	MAX_RUN_DIFF_REPORTS,
	MAX_RUN_PICTURE_PAIRS,
	claimCheckJob,
	escapeDiffText,
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
import { purgeTrash } from '../../src/lib/server/ops/history';
import { createItem, trashItem } from '../../src/lib/server/ops/items';
import { addPhase } from '../../src/lib/server/ops/plan';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('B.9 evidence storage and signed-in picture rules', () => {
	let db: TestDb;
	let w: World;
	let store: ReturnType<typeof memoryStorage>;
	let token: string;
	let services: { storage: ReturnType<typeof memoryStorage>; baseUrl: string };
	let auth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		store = memoryStorage();
		services = { storage: store, baseUrl: 'http://localhost:5180' };
		await saveEnvironment(
			{ ...w.ctx('admin'), services },
			{ project: w.projectKey, name: 'preview', url: 'http://localhost:5180', kind: 'preview' }
		);
		const created = await createRunner(w.ctx('admin'), {
			kind: 'local',
			name: 'b9-runner',
			projects: [w.projectKey]
		});
		token = created.token;
		auth = (await authenticateRunner(db, token))!;
	}, 120_000);

	afterAll(() => db?.stop());

	const as = (who: keyof World['people']) => ({ ...w.ctx(who), services });

	async function newQueuedRun(visibility: 'public' | 'private' = 'private') {
		const created = await createItem(as('member'), {
			project: w.projectKey,
			title: `Item-${Math.random().toString(36).slice(2, 8)}`,
			visibility,
			manualChecks: [{ key: 'M1', text: 'Visual check', auto: true }]
		});
		const ref = created.item.ref;
		await addPhase(as('member'), {
			item: ref,
			key: 'A',
			title: 'Phase A',
			steps: [{ key: 'A.1', text: 'Build screen' }]
		});
		await saveCheck(as('member'), {
			item: ref,
			key: 'M1',
			script: 'compare()',
			requiredTarget: 'preview'
		});
		await requestRun(as('member'), { item: ref, key: 'M1', target: 'preview', step: 'A.1' });
		const job = (await claimCheckJob(db, auth, services))!;
		return { ref, itemId: created.item.id, job };
	}

	it('enforces per-run limits for picture pairs and diff reports and stores keys under MOCKUP_KEY_PREFIX', async () => {
		const { job } = await newQueuedRun('private');
		const ids: string[] = [];
		for (let i = 0; i < MAX_RUN_PICTURE_PAIRS; i++) {
			const m = await storeRunArtifact(
				db,
				auth,
				job.id,
				{ filename: `mockup-screen-${i}.jpg`, caption: `Mockup ${i}`, bytes: JPEG_BYTES },
				services
			);
			const a = await storeRunArtifact(
				db,
				auth,
				job.id,
				{ filename: `app-screen-${i}.jpg`, caption: `App ${i}`, bytes: JPEG_BYTES },
				services
			);
			ids.push(m.attachmentId, a.attachmentId);
		}
		// 5th pair picture is refused
		await expect(
			storeRunArtifact(
				db,
				auth,
				job.id,
				{ filename: 'mockup-screen-extra.jpg', caption: 'Extra', bytes: JPEG_BYTES },
				services
			)
		).rejects.toMatchObject({ code: 'INVALID' });

		// Derived evidence uses MOCKUP_KEY_PREFIX and is included in org backup
		const [att] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(attachment).where(eq(attachment.id, ids[0]))
		);
		expect(isMockupKey(att.storageKey)).toBe(true);
		const dump = await exportOrg(adminFromExecutor(db.admin), store, w.orgId);
		expect(
			dump.frames.some(
				(f) => f.type === 'file' && (f.json as { key: string }).key === att.storageKey
			)
		).toBe(true);

		// Oversized diff report is refused
		await expect(
			storeRunArtifact(
				db,
				auth,
				job.id,
				{
					filename: 'compare-diff.json',
					caption: 'Too large',
					bytes: new Uint8Array(MAX_COMPARE_DIFF_BYTES + 16)
				},
				services
			)
		).rejects.toMatchObject({ code: 'INVALID' });

		// Diff report count limit
		for (let i = 0; i < MAX_RUN_DIFF_REPORTS; i++) {
			await storeRunArtifact(
				db,
				auth,
				job.id,
				{
					filename: `compare-diff-${i}.json`,
					caption: `Diff ${i}`,
					bytes: Buffer.from(JSON.stringify({ schema: 1, pairs: [] }), 'utf8')
				},
				services
			);
		}
		await expect(
			storeRunArtifact(
				db,
				auth,
				job.id,
				{
					filename: 'compare-diff-extra.json',
					caption: 'Extra diff',
					bytes: Buffer.from(JSON.stringify({ schema: 1, pairs: [] }), 'utf8')
				},
				services
			)
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('refuses finishing a compare run with a missing pair half with MISSING_PICTURE_PAIR', async () => {
		const { job } = await newQueuedRun('private');
		const m = await storeRunArtifact(
			db,
			auth,
			job.id,
			{ filename: 'mockup-home-1280px.jpg', caption: 'Mockup', bytes: JPEG_BYTES },
			services
		);
		await expect(
			finishCheckRun(db, auth, job.id, { result: 'pass', evidence: [m.attachmentId] }, services)
		).rejects.toMatchObject({ code: 'MISSING_PICTURE_PAIR' });

		const apiRes = await handleRunnerApi(
			{
				method: 'POST',
				path: `/runner/runs/${job.id}/finish`,
				headers: new Headers({ authorization: `Bearer ${token}` }),
				query: {},
				body: Buffer.from(JSON.stringify({ result: 'pass', evidence: [m.attachmentId] })),
				session: null
			},
			{ handle: db, storage: store, baseUrl: 'http://localhost:5180' }
		);
		expect(apiRes.status).toBe(400);
		expect((apiRes.body as { error: { code: string } }).error.code).toBe('MISSING_PICTURE_PAIR');
	});

	it('enforces uploadSignedInPictures approval, refuses signed-in pictures/diff text on public items, escapes diff text, and serves with sandbox + nosniff', async () => {
		const pub = await newQueuedRun('public');
		const priv = await newQueuedRun('private');
		const diffPayload = Buffer.from(
			JSON.stringify({
				schema: 1,
				signedIn: true,
				rankedLines: ['[HIGH] title: mockup="<b>Mock</b>" app="<script>alert(1)</script>"'],
				pairs: [
					{
						screen: 'home',
						state: 'default',
						width: 1280,
						diff: {
							mismatches: [
								{ ref: 'title', mockupValue: '<b>Mock</b>', appValue: '<script>alert(1)</script>' }
							],
							notCompared: []
						}
					}
				]
			}),
			'utf8'
		);
		const summaryPayload = Buffer.from(
			JSON.stringify({
				schema: 1,
				signedIn: true,
				signedInPicturesWithheld: true,
				pairCount: 1,
				totalMismatches: 1,
				totalNotCompared: 0,
				pairs: [
					{
						screen: 'home',
						state: 'default',
						width: 1280,
						passed: false,
						mismatchCount: 1,
						notComparedCount: 0,
						mockupHash: 'abc',
						appHash: 'def'
					}
				]
			}),
			'utf8'
		);

		// Public item refuses signed-in pictures & diff text even if uploadSignedInPictures is true
		await expect(
			storeRunArtifact(
				db,
				auth,
				pub.job.id,
				{
					filename: 'app-home-1280px.jpg',
					caption: 'Signed in app',
					bytes: JPEG_BYTES,
					signedIn: true,
					uploadSignedInPictures: true
				},
				services
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			storeRunArtifact(
				db,
				auth,
				pub.job.id,
				{
					filename: 'compare-diff.json',
					caption: 'Signed in diff',
					bytes: diffPayload,
					signedIn: true,
					uploadSignedInPictures: true
				},
				services
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// Private item without uploadSignedInPictures approval refuses pictures & unredacted diff text, allows hashes & counts only
		await expect(
			storeRunArtifact(
				db,
				auth,
				priv.job.id,
				{
					filename: 'app-home-1280px.jpg',
					caption: 'Signed in app',
					bytes: JPEG_BYTES,
					signedIn: true,
					uploadSignedInPictures: false
				},
				services
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			storeRunArtifact(
				db,
				auth,
				priv.job.id,
				{
					filename: 'compare-diff.json',
					caption: 'Signed in diff',
					bytes: diffPayload,
					signedIn: true,
					uploadSignedInPictures: false
				},
				services
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const summaryAtt = await storeRunArtifact(
			db,
			auth,
			priv.job.id,
			{
				filename: 'compare-summary.json',
				caption: 'Hashes & counts',
				bytes: summaryPayload,
				signedIn: true,
				uploadSignedInPictures: false
			},
			services
		);

		// Private item WITH uploadSignedInPictures approval accepts signed-in picture & diff report
		const mAtt = await storeRunArtifact(
			db,
			auth,
			priv.job.id,
			{
				filename: 'mockup-home-1280px.jpg',
				caption: 'Mockup',
				bytes: JPEG_BYTES,
				signedIn: true,
				uploadSignedInPictures: true
			},
			services
		);
		const aAtt = await storeRunArtifact(
			db,
			auth,
			priv.job.id,
			{
				filename: 'app-home-1280px.jpg',
				caption: 'App',
				bytes: JPEG_BYTES,
				signedIn: true,
				uploadSignedInPictures: true
			},
			services
		);
		await expect(
			setAttachmentVisibility(as('member'), aAtt.attachmentId, 'public')
		).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});

		// Serving check-evidence attachment sets sandbox + nosniff headers matching src/routes/pictures
		const res = await serveAttachmentResponse(as('member'), mAtt.attachmentId);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-security-policy')).toBe(
			"default-src 'none'; img-src 'self' data:; sandbox"
		);
		expect(res.headers.get('vary')).toBe('cookie');
		expect(res.headers.get('cache-control')).toBe('private, no-cache');
		const sumRes = await serveAttachmentResponse(as('member'), summaryAtt.attachmentId);
		expect(sumRes.status).toBe(200);
		expect(sumRes.headers.get('content-security-policy')).toContain('sandbox');

		// Direct member upload cannot spoof check-evidence kind or public check-evidence visibility
		await expect(
			addAttachment(
				as('member'),
				{
					item: priv.itemId,
					filename: 'spoof.jpg',
					caption: 'Spoof',
					kind: 'check-evidence',
					visibility: 'public'
				},
				JPEG_BYTES
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// Leading-whitespace spoofing cannot bypass signed-in uploadSignedInPictures gate
		await expect(
			storeRunArtifact(
				db,
				auth,
				priv.job.id,
				{
					filename: ' compare-diff.json',
					caption: 'Whitespace spoofed diff',
					bytes: diffPayload,
					signedIn: true,
					uploadSignedInPictures: false
				},
				services
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });

		// Storing signed-in diff JSON WITH approval escapes HTML markup inside diff text
		const xssDiffPayload = new TextEncoder().encode(
			JSON.stringify({
				signedIn: true,
				rankedLines: ['<script>alert("xss")</script>'],
				pairs: [
					{
						diff: {
							mismatches: [{ ref: 'card', mockupValue: '<b>a</b>', appValue: '<i>b</i>' }]
						}
					}
				]
			})
		);
		const storedDiff = await storeRunArtifact(
			db,
			auth,
			priv.job.id,
			{
				filename: 'compare-diff.json',
				caption: 'Approved escaped diff',
				bytes: xssDiffPayload,
				signedIn: true,
				uploadSignedInPictures: true
			},
			services
		);
		const diffRes = await serveAttachmentResponse(as('member'), storedDiff.attachmentId);
		const diffBody = await diffRes.text();
		expect(diffBody).toContain('&lt;script&gt;');
		expect(diffBody).not.toContain('<script>');

		// Invalid UUID returns NOT_FOUND (not 500) and matching ETag returns 304 without body
		await expect(serveAttachmentResponse(as('member'), 'not-a-uuid')).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		const etagRes = await serveAttachmentResponse(
			as('member'),
			mAtt.attachmentId,
			res.headers.get('etag')
		);
		expect(etagRes.status).toBe(304);

		// Escaped diff text neutralizes HTML markup
		const escaped = escapeDiffText('<script>alert("xss")</script> & \'tag\'');
		expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;tag&#39;');
	});

	it('pins check runs and their evidence referenced by a step past retention while pruning unpinned old runs', async () => {
		const pinned = await newQueuedRun('private');
		const mPinned = await storeRunArtifact(
			db,
			auth,
			pinned.job.id,
			{ filename: 'mockup-pinned.jpg', caption: 'Pinned mockup', bytes: JPEG_BYTES },
			services
		);
		const aPinned = await storeRunArtifact(
			db,
			auth,
			pinned.job.id,
			{ filename: 'app-pinned.jpg', caption: 'Pinned app', bytes: JPEG_BYTES },
			services
		);
		await finishCheckRun(
			db,
			auth,
			pinned.job.id,
			{ result: 'pass', evidence: [mPinned.attachmentId, aPinned.attachmentId] },
			services
		);
		// Ensure A.1 explicitly references pinned.job.id
		await recordSteps(as('member'), {
			item: pinned.ref,
			marks: [
				{ key: 'A.1', mark: 'done', evidence: { checkRunId: pinned.job.id, target: 'preview' } }
			]
		});

		// Also pin secondary runIds on step.evidence
		const secondaryRun = await newQueuedRun('private');
		const mSecondary = await storeRunArtifact(
			db,
			auth,
			secondaryRun.job.id,
			{ filename: 'mockup-secondary.jpg', caption: 'Secondary mockup', bytes: JPEG_BYTES },
			services
		);
		const aSecondary = await storeRunArtifact(
			db,
			auth,
			secondaryRun.job.id,
			{ filename: 'app-secondary.jpg', caption: 'Secondary app', bytes: JPEG_BYTES },
			services
		);
		await finishCheckRun(
			db,
			auth,
			secondaryRun.job.id,
			{ result: 'pass', evidence: [mSecondary.attachmentId, aSecondary.attachmentId] },
			services
		);
		await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx
				.update(step)
				.set({
					evidence: {
						checkRunId: pinned.job.id,
						runIds: [pinned.job.id, secondaryRun.job.id],
						target: 'preview'
					}
				})
				.where(eq(step.itemId, secondaryRun.itemId))
		);

		// Cannot delete check-evidence attachment pinned by a live step (primary or secondary runIds)
		await expect(deleteAttachment(as('member'), mPinned.attachmentId)).rejects.toMatchObject({
			code: 'CONFLICT'
		});
		await expect(deleteAttachment(as('member'), mSecondary.attachmentId)).rejects.toMatchObject({
			code: 'CONFLICT'
		});

		// Unpinned run on another active item
		const unpinned = await newQueuedRun('private');
		const mOld = await storeRunArtifact(
			db,
			auth,
			unpinned.job.id,
			{ filename: 'mockup-old.jpg', caption: 'Old mockup', bytes: JPEG_BYTES },
			services
		);
		const aOld = await storeRunArtifact(
			db,
			auth,
			unpinned.job.id,
			{ filename: 'app-old.jpg', caption: 'Old app', bytes: JPEG_BYTES },
			services
		);
		await finishCheckRun(
			db,
			auth,
			unpinned.job.id,
			{ result: 'fail', evidence: [mOld.attachmentId, aOld.attachmentId] },
			services
		);

		const [pinnedAttRow] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(attachment).where(eq(attachment.id, mPinned.attachmentId))
		);
		const [oldAttRow] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(attachment).where(eq(attachment.id, mOld.attachmentId))
		);

		// Age both runs past 30 days retention
		await withTenant(db, { orgId: w.orgId }, async (tx) => {
			await tx.execute(
				sql`update check_run set created_at = now() - interval '45 days', finished_at = now() - interval '45 days' where id in (${pinned.job.id}, ${unpinned.job.id})`
			);
		});

		await purgeTrash(as('admin'));

		// Pinned run & evidence survive
		const checkPinned = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.id, pinned.job.id))
		);
		expect(checkPinned.length).toBe(1);
		expect(store.files.has(pinnedAttRow.storageKey)).toBe(true);

		// Unpinned old run & its evidence were pruned
		const checkOld = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.id, unpinned.job.id))
		);
		expect(checkOld.length).toBe(0);
		expect(store.files.has(oldAttRow.storageKey)).toBe(false);
		const [pinnedStep] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(step).where(eq(step.itemId, pinned.itemId))
		);
		expect((pinnedStep.evidence as { checkRunId?: string } | null)?.checkRunId).toBe(pinned.job.id);

		// Soft-trashed item within 30 days keeps its pinned run & evidence alive across purgeTrash
		await trashItem(as('member'), pinned.itemId);
		await purgeTrash(as('admin'));
		const stillAlive = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(checkRun).where(eq(checkRun.id, pinned.job.id))
		);
		expect(stillAlive.length).toBe(1);
		expect(store.files.has(pinnedAttRow.storageKey)).toBe(true);
	});

	it('escapes waived diff entries and re-verifies compare-summary bytes on signedIn finishCheckRun', async () => {
		const waivedRun = await newQueuedRun('private');
		const m1 = await storeRunArtifact(
			db,
			auth,
			waivedRun.job.id,
			{
				filename: 'mockup-waived.jpg',
				caption: 'Mockup',
				bytes: JPEG_BYTES,
				signedIn: true,
				uploadSignedInPictures: true
			},
			services
		);
		const a1 = await storeRunArtifact(
			db,
			auth,
			waivedRun.job.id,
			{
				filename: 'app-waived.jpg',
				caption: 'App',
				bytes: JPEG_BYTES,
				signedIn: true,
				uploadSignedInPictures: true
			},
			services
		);
		const diffBytes = Buffer.from(
			JSON.stringify({
				passed: true,
				summary: '<b>done</b>',
				pairs: [
					{
						diff: {
							waived: [
								{
									ref: 'hero',
									appSelector: '.hero',
									property: 'color',
									mockupValue: '<script>1</script>',
									appValue: '<img onerror=x>',
									severity: 'low',
									waived: { kind: 'free', reason: '<svg onload=1>' }
								}
							]
						}
					}
				]
			})
		);
		const d1 = await storeRunArtifact(
			db,
			auth,
			waivedRun.job.id,
			{
				filename: 'compare-diff.json',
				caption: 'Diff',
				bytes: diffBytes,
				signedIn: true,
				uploadSignedInPictures: true
			},
			services
		);
		await finishCheckRun(
			db,
			auth,
			waivedRun.job.id,
			{
				result: 'pass',
				signedIn: true,
				uploadSignedInPictures: true,
				evidence: [m1.attachmentId, a1.attachmentId, d1.attachmentId]
			},
			services
		);
		const [diffAtt] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(attachment).where(eq(attachment.id, d1.attachmentId))
		);
		const storedDiff = JSON.parse(
			Buffer.from(store.files.get(diffAtt.storageKey)!.bytes).toString()
		);
		expect(storedDiff.pairs[0].diff.waived[0].mockupValue).toBe('&lt;script&gt;1&lt;/script&gt;');
		expect(storedDiff.pairs[0].diff.waived[0].appValue).toBe('&lt;img onerror=x&gt;');
		expect(storedDiff.pairs[0].diff.waived[0].waived.reason).toBe('&lt;svg onload=1&gt;');

		// Summary uploaded without signedIn flag containing extra raw keys is refused when finishCheckRun sets signedIn: true
		const sneaky = await newQueuedRun('private');
		const badSummary = await storeRunArtifact(
			db,
			auth,
			sneaky.job.id,
			{
				filename: 'compare-summary.json',
				caption: 'Summary',
				bytes: Buffer.from(JSON.stringify({ schema: 1, passed: false, rawLeak: 'secret-text' }))
			},
			services
		);
		await expect(
			finishCheckRun(
				db,
				auth,
				sneaky.job.id,
				{
					result: 'fail',
					signedIn: true,
					uploadSignedInPictures: false,
					evidence: [badSummary.attachmentId]
				},
				services
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
});
