// PHASE 11: THE "UI CHANGES" TABLE (NOW OPTIONAL), MEASURE RUNS, AND THE AUTOMATIC CAPTURE: NO PAGES NAMED, A REPEAT OF AN UNCHANGED TREE, PRUNING, AND WHO MAY SEE WHICH SHOTS (L39, L40, L41)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { attachment, designScale, uiShotRun } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { saveCheck } from '../../src/lib/server/ops/checks';
import {
	authenticateRunner,
	createRunner,
	registerToolRunner,
	saveEnvironment
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import {
	claimShotsJob,
	finishShotsRun,
	getScale,
	getShotsRun,
	itemShots,
	listUiChanges,
	requestMeasure,
	requestShots,
	saveUiChanges,
	shotsAccounts,
	storeShotImage,
	waitForShotsRun
} from '../../src/lib/server/ops/uiShots';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const TABLE = `
| Page | State | Themes | Accounts | Siblings | Levels | Viewports |
|---|---|---|---|---|---|---|
| \`/acme/CKT/health\` | none | both | default | \`/acme/CKT/tasks\` | title, section, button-primary | 1440, 390 |
| \`/acme/CKT/settings\` | none | light | default | \`/acme/CKT/tasks\` | title | 1440 |
`;
const m = (fontSize: number, height = 44, radius = 8) => ({
	fontSize,
	fontWeight: 600,
	height,
	width: 200,
	radius
});
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

// -- FUNCTIONS -- //

describe('UI shots', () => {
	const make = makePostgres;
	let db: TestDb;
	let w: World;
	let n = 0;
	const storage = memoryStorage();
	const services = {
		masterKey: 'test-master-key-for-the-vault-0123456789abcdef',
		storage,
		baseUrl: 'http://x',
		runnerQueueMinutes: 10
	};
	const as = (who: 'owner' | 'admin' | 'member' | 'viewer') => ({ ...w.ctx(who), services });
	const newItem = (extra = {}) =>
		createItem(as('member'), {
			project: w.projectKey,
			title: `Shots item ${++n}`,
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Build the page' }] }],
			manualChecks: [{ key: 'M1', text: 'It looks right', auto: true }],
			...extra
		});
	let auth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;
	let toolAuth: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;
	let toolId = '';
	// The tool counts as online when it was seen in the last minute or so
	const toolOnline = (on: boolean) =>
		db.admin.exec(
			`update runner set last_seen_at = now() - interval '${on ? 0 : 60} minutes' where id = '${toolId}'`
		);
	const runRow = (id: string) =>
		withTenant(
			db,
			{ orgId: w.orgId },
			async (tx) => (await tx.select().from(uiShotRun).where(eq(uiShotRun.id, id)))[0]
		);

	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'preview',
			url: 'http://localhost:5180',
			kind: 'preview'
		});
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'demo',
			url: 'https://demo.example.com',
			kind: 'deployed'
		});
		await saveEnvironment(as('admin'), {
			project: w.projectKey,
			name: 'live',
			url: 'https://app.example.com',
			kind: 'deployed',
			production: true
		});
		const made = await createRunner(as('admin'), {
			name: 'Laptop',
			kind: 'local',
			projects: [w.projectKey]
		});
		auth = (await authenticateRunner(db, made.token))!;
		const tool = await registerToolRunner(as('admin'), {
			name: 'Shots afb-checks',
			projects: [w.projectKey]
		});
		toolId = tool.id;
		toolAuth = (await authenticateRunner(db, tool.token))!;
		await toolOnline(true);
	}, 240_000);
	afterAll(() => db?.stop());

	it('saves a table of rows, replacing the old one, and refuses a bad row without changing anything', async () => {
		const it1 = await newItem();
		expect((await saveUiChanges(as('member'), { item: it1.ref, markdown: TABLE })).saved).toBe(2);
		const rows = await listUiChanges(as('member'), it1.ref);
		expect(rows.map((r) => r.page)).toEqual(['/acme/CKT/health', '/acme/CKT/settings']);
		expect(rows[0].themes).toEqual(['light', 'dark']);
		const bad = TABLE.replace('title, section, button-primary', 'title, headline');
		await expect(saveUiChanges(as('member'), { item: it1.ref, markdown: bad })).rejects.toThrow(
			/Row 1: Unknown level/
		);
		const outside = TABLE.replace('`/acme/CKT/health`', '`https://example.com/`');
		await expect(saveUiChanges(as('member'), { item: it1.ref, markdown: outside })).rejects.toThrow(
			/inside the app/
		);
		await expect(
			saveUiChanges(as('member'), { item: it1.ref, markdown: TABLE, rows: [] })
		).rejects.toThrow();
		expect((await listUiChanges(as('member'), it1.ref)).length).toBe(2);
		await expect(
			saveUiChanges(as('viewer'), { item: it1.ref, markdown: TABLE })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await saveUiChanges(as('member'), { item: it1.ref, rows: [] });
		expect(await listUiChanges(as('member'), it1.ref)).toEqual([]);
		// A project that is not a web app refuses
		await db.admin.exec(`update project set web_app = false where id = '${w.projectId}'`);
		await expect(saveUiChanges(as('member'), { item: it1.ref, markdown: TABLE })).rejects.toThrow(
			/web app/
		);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
	});

	it('measures the design scale from reference pages, leaves out a level seen on too few pages and keeps the rest', async () => {
		await expect(requestMeasure(as('admin'), w.projectKey)).rejects.toThrow(
			/at least 3 reference pages/
		);
		await db.admin.exec(
			`update project set reference_pages = '{/p1,/p2,/p3,/p4}' where id = '${w.projectId}'`
		);
		await expect(requestMeasure(as('member'), w.projectKey)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const asked = await requestMeasure(as('admin'), w.projectKey);
		expect(asked.state).toBe('queued');
		const job = (await claimShotsJob(db, auth, services))!;
		expect(job.kind).toBe('measure');
		expect(job.project.referencePages).toEqual(['/p1', '/p2', '/p3', '/p4']);
		const results = ['/p1', '/p2', '/p3', '/p4'].flatMap((page, i) =>
			[1440, 390].map((viewport) => ({
				page,
				state: '',
				theme: 'light',
				viewport,
				side: 'after' as const,
				values: {
					title: m(viewport === 1440 ? 24 : 20),
					button: i < 2 ? m(14, 44) : null,
					'button-primary': m(14, 44)
				}
			}))
		);
		const done = await finishShotsRun(db, auth, job.id, { state: 'done', results });
		expect(done.scaleSaved).toBe(true);
		expect(done.flags.some((f) => f.level === 'button' && f.kind === 'unused')).toBe(true);
		const scale = await getScale(as('member'), w.projectKey);
		const desktop = scale.scales.find((s) => s.theme === 'light' && s.viewport === 1440)!;
		expect(desktop.levels.title).toEqual({ fontSize: 24 });
		expect(desktop.levels.button).toBeUndefined();
		expect(desktop.seenOn.button).toBe(2);
		expect(scale.scales.find((s) => s.viewport === 390)!.levels.title).toEqual({ fontSize: 20 });
	});

	/** One whole capture the way the tool makes it: ask, claim, upload one picture, report. */
	const capture = async (
		itemRef: string,
		extra: { hash?: string; notes?: string[]; force?: boolean } = {}
	) => {
		const asked = await requestShots(as('member'), { item: itemRef, force: extra.force });
		const job = (await claimShotsJob(db, toolAuth, services))!;
		const img = await storeShotImage(
			db,
			toolAuth,
			job.id,
			{ filename: 'after-health-light-1440.jpg', caption: 'After', bytes: JPEG },
			services
		);
		const done = await finishShotsRun(db, toolAuth, job.id, {
			state: 'done',
			afterCommit: 'abc1234',
			beforeCommit: 'def5678',
			beforeTarget: 'base',
			diffHash: extra.hash ?? `h${++n}`,
			changedPaths: ['src/lib/Card.svelte'],
			notes: extra.notes ?? [],
			results: [
				{
					page: '/acme/CKT/health',
					state: '',
					theme: 'light',
					viewport: 1440,
					side: 'after',
					values: { title: m(24) },
					image: img.attachmentId
				}
			]
		});
		return { asked, job, img, done };
	};
	const picture = (id: string) =>
		withTenant(
			db,
			{ orgId: w.orgId },
			async (tx) => (await tx.select().from(attachment).where(eq(attachment.id, id)))[0]
		);

	it('asks for a capture with no table: only the tool takes it, an agent that asks again gets the same run, and the job names no pages', async () => {
		const it2 = await newItem();
		const asked = await requestShots(as('member'), { item: it2.ref });
		expect(asked.state).toBe('queued');
		expect(asked.target).toBe('preview');
		expect(asked.existing).toBe(false);
		// An agent that retries is given the run that is already waiting, never a second build
		const again = await requestShots(as('member'), { item: it2.ref });
		expect(again.id).toBe(asked.id);
		expect(again.existing).toBe(true);
		// A local runner never takes a capture: finding the screens and building two versions is the tool's work
		expect(await claimShotsJob(db, auth, services)).toBeNull();
		const job = (await claimShotsJob(db, toolAuth, services))!;
		expect(job).toMatchObject({
			kind: 'shots',
			mode: 'auto',
			last: null,
			rows: [],
			beforeTarget: null,
			beforeUrl: null,
			afterUrl: '',
			readOnly: true
		});
		// The test accounts a held run may read are the project's declared ones: none here
		await expect(shotsAccounts(db, toolAuth, job.id, services)).resolves.toEqual({});
		await finishShotsRun(db, toolAuth, job.id, { state: 'failed', reason: 'stopped' });
	});

	it('a report with no pictures and no note is an out-of-date tool and is refused, never shown as a green empty run', async () => {
		const it3 = await newItem();
		await requestShots(as('member'), { item: it3.ref });
		const job = (await claimShotsJob(db, toolAuth, services))!;
		const refused = await finishShotsRun(db, toolAuth, job.id, { state: 'done', results: [] });
		// The run ends as failed with the reason, so the person sees it and can ask again at once
		expect(refused.state).toBe('failed');
		const failedRow = await runRow(job.id);
		expect(failedRow.state).toBe('failed');
		expect(failedRow.reason).toMatch(/empty report/);
		const again = await requestShots(as('member'), { item: it3.ref });
		expect(again.existing).toBe(false);
		// A report that says why it has nothing to show is a real answer
		const job2 = (await claimShotsJob(db, toolAuth, services))!;
		const done = await finishShotsRun(db, toolAuth, job2.id, {
			state: 'done',
			notes: ['No screen changed in this item.']
		});
		expect(done.state).toBe('done');
		const view = await itemShots(as('member'), it3.ref);
		expect(view.runs[0]).toMatchObject({ state: 'done', screens: 0 });
		expect(view.runs[0].notes).toEqual(['No screen changed in this item.']);
	});

	it('stores the notes, the base commit as Before and the pictures, and drops a picture the tool names that is not this run’s own', async () => {
		const mine = await newItem();
		const other = await newItem();
		const foreign = await capture(other.ref);
		// What this item's checks cover tells which changed files belong to other work
		await saveCheck(as('member'), {
			item: mine.ref,
			key: 'M1',
			script: 's',
			coveredPaths: ['web/src/routes/settings']
		});
		await requestShots(as('member'), { item: mine.ref });
		const job = (await claimShotsJob(db, toolAuth, services))!;
		const own = await storeShotImage(
			db,
			toolAuth,
			job.id,
			{ filename: 'a.jpg', caption: 'After', bytes: JPEG },
			services
		);
		const page = {
			page: '/acme/CKT/health',
			state: '',
			theme: 'light',
			viewport: 1440,
			values: { title: m(24) }
		};
		const done = await finishShotsRun(db, toolAuth, job.id, {
			state: 'done',
			afterCommit: 'abc1234',
			beforeCommit: 'def5678',
			beforeTarget: 'base',
			diffHash: 'own-hash',
			changedPaths: ['web/src/routes/settings/+page.svelte', 'web/src/routes/other/+page.svelte'],
			notes: ['New screens have no Before: /acme/CKT/new'],
			results: [
				{ ...page, side: 'after', image: own.attachmentId },
				// The picture of another item's capture, named by the tool: it must be dropped
				{ ...page, side: 'before', image: foreign.img.attachmentId }
			]
		});
		expect(done.state).toBe('done');
		const stored = await runRow(job.id);
		expect(stored.foreignPaths).toEqual(['web/src/routes/other/+page.svelte']);
		expect(stored.beforeTarget).toBe('base');
		expect(stored.beforeCommit).toBe('def5678');
		expect(stored.imageAttachmentIds).toEqual([own.attachmentId]);
		expect(stored.reason).toBe('New screens have no Before: /acme/CKT/new');
		expect(stored.results.find((x) => x.side === 'before')?.image).toBeUndefined();
		// No flags without table rows: a capture carries pictures, not measurements against a table
		expect(stored.flags).toEqual([]);
		const att = await picture(own.attachmentId);
		expect(att.visibility).toBe('private');
		expect(att.kind).toBe('ui-shot');
		await expect(
			storeShotImage(
				db,
				toolAuth,
				job.id,
				{ filename: 'x.png', caption: 'png', bytes: JPEG },
				services
			)
		).rejects.toThrow(/running|JPEG/);
		const view = await itemShots(as('member'), mine.ref);
		expect(view.canSeePictures).toBe(true);
		expect(view.runs[0].screens).toBe(1);
		expect(view.runs[0].notes).toEqual(['New screens have no Before: /acme/CKT/new']);
		// The tab can tell a screen that looks the same before and after by the checksums of its pictures
		expect(view.sums[own.attachmentId]).toMatch(/^[0-9a-f]{16,}$/);
		expect((await picture(foreign.img.attachmentId)).deletedAt).toBeNull();
	});

	it('an unchanged tree is a repeat: the tool is told the last capture, a repeat holds no pictures of its own, and a forged repeat is refused', async () => {
		const it4 = await newItem();
		const first = await capture(it4.ref, { hash: 'tree-1' });
		expect(first.job.last).toBeNull();
		await requestShots(as('member'), { item: it4.ref });
		const job = (await claimShotsJob(db, toolAuth, services))!;
		expect(job.last).toEqual({ hash: 'tree-1', runId: first.job.id });
		// A repeat that names a capture with another hash is not believed
		const forged = await finishShotsRun(db, toolAuth, job.id, {
			state: 'done',
			diffHash: 'tree-2',
			reusedFrom: first.job.id
		});
		expect(forged.state).toBe('failed');
		expect((await runRow(job.id)).reason).toMatch(/not a capture of this tree/);
		await requestShots(as('member'), { item: it4.ref });
		const job3 = (await claimShotsJob(db, toolAuth, services))!;
		const done = await finishShotsRun(db, toolAuth, job3.id, {
			state: 'done',
			diffHash: 'tree-1',
			reusedFrom: first.job.id,
			notes: ['Nothing changed since the last capture.']
		});
		expect(done.state).toBe('done');
		const stored = await runRow(job3.id);
		expect(stored.results).toEqual([]);
		expect(stored.imageAttachmentIds).toEqual([]);
		expect(stored.diffHash).toBe('tree-1');
		// The pictures of the first capture are still there
		expect((await picture(first.img.attachmentId)).deletedAt).toBeNull();
		// The Capture screens button forces fresh pictures: the tool is not told the last capture
		await requestShots(as('member'), { item: it4.ref, force: true });
		const forcedJob = (await claimShotsJob(db, toolAuth, services))!;
		expect(forcedJob.last).toBeNull();
		// A repeat is never accepted for a capture that asked for fresh pictures
		const refused = await finishShotsRun(db, toolAuth, forcedJob.id, {
			state: 'done',
			diffHash: 'tree-1',
			reusedFrom: first.job.id
		});
		expect(refused.state).toBe('failed');
	});

	it('upgrades a waiting capture to fresh pictures when the button is pressed, and does not repeat a capture whose old version could not be built', async () => {
		const it8 = await newItem();
		const plain = await requestShots(as('member'), { item: it8.ref });
		expect((await runRow(plain.id)).force).toBe(false);
		const pressed = await requestShots(as('member'), { item: it8.ref, force: true });
		expect(pressed.id).toBe(plain.id);
		expect((await runRow(plain.id)).force).toBe(true);
		// A capture with no Before (the old version did not build) is not the last capture the tool may repeat
		const job = (await claimShotsJob(db, toolAuth, services))!;
		const img = await storeShotImage(
			db,
			toolAuth,
			job.id,
			{ filename: 'a.jpg', caption: 'After', bytes: JPEG },
			services
		);
		await finishShotsRun(db, toolAuth, job.id, {
			state: 'done',
			diffHash: 'no-before',
			notes: ['No Before: the old version was not built.'],
			results: [
				{
					page: '/acme/CKT/health',
					state: '',
					theme: 'light',
					viewport: 1440,
					side: 'after',
					values: {},
					image: img.attachmentId
				}
			]
		});
		await requestShots(as('member'), { item: it8.ref });
		expect((await claimShotsJob(db, toolAuth, services))!.last).toBeNull();
	});

	it('keeps the newest 3 captures, never lets failed runs push a good one out, and deletes only this item’s own pictures', async () => {
		const it5 = await newItem();
		const bystander = await newItem();
		const kept = await capture(bystander.ref);
		const made = [];
		for (let i = 0; i < 5; i++) made.push(await capture(it5.ref));
		const runsOf = () =>
			withTenant(db, { orgId: w.orgId }, (tx) =>
				tx.select().from(uiShotRun).where(eq(uiShotRun.itemId, it5.id))
			);
		const withPictures = async () =>
			(await runsOf()).filter((r) => r.state === 'done' && r.imageAttachmentIds.length);
		expect(await withPictures()).toHaveLength(3);
		// The two oldest captures' pictures are deleted; the three newest and another item's picture are not
		expect((await picture(made[0].img.attachmentId)).deletedAt).not.toBeNull();
		expect((await picture(made[1].img.attachmentId)).deletedAt).not.toBeNull();
		for (const c of made.slice(2)) expect((await picture(c.img.attachmentId)).deletedAt).toBeNull();
		expect((await picture(kept.img.attachmentId)).deletedAt).toBeNull();
		// Failed runs never push a good capture out
		for (let i = 0; i < 2; i++) {
			await requestShots(as('member'), { item: it5.ref });
			const job = (await claimShotsJob(db, toolAuth, services))!;
			await finishShotsRun(db, toolAuth, job.id, {
				state: 'failed',
				reason: 'The page did not open'
			});
		}
		expect(await withPictures()).toHaveLength(3);
		// Only the newest of them is kept
		expect((await runsOf()).filter((r) => r.state === 'failed')).toHaveLength(1);
		// A new capture drops the failure that came before it
		const fresh = await capture(it5.ref);
		expect(await withPictures()).toHaveLength(3);
		expect((await picture(fresh.img.attachmentId)).deletedAt).toBeNull();
		expect((await runsOf()).filter((r) => r.state === 'failed')).toHaveLength(0);
	});

	it('says plainly when no tool is online, and a capture nobody takes while none is online stops waiting after two minutes', async () => {
		const it6 = await newItem();
		await toolOnline(false);
		const asked = await requestShots(as('member'), { item: it6.ref });
		expect(asked.unavailable).toBe(true);
		expect(asked.reason).toMatch(/capture tool is not connected/);
		expect(asked.reason).not.toMatch(/environment|production|hosted/i);
		expect((await itemShots(as('member'), it6.ref)).canRun).toBe(false);
		// Queued while a tool was online, then the tool went away: after two minutes it says so
		await toolOnline(true);
		const queued = await requestShots(as('member'), { item: it6.ref });
		expect(queued.state).toBe('queued');
		await db.admin.exec(
			`update ui_shot_run set created_at = now() - interval '3 minutes' where id = '${queued.id}'`
		);
		await itemShots(as('member'), it6.ref);
		expect((await runRow(queued.id)).state).toBe('queued');
		await toolOnline(false);
		await itemShots(as('member'), it6.ref);
		const row = await runRow(queued.id);
		expect(row.state).toBe('unavailable');
		expect(row.reason).toMatch(/capture tool is not connected/);
		await toolOnline(true);
		expect((await itemShots(as('member'), it6.ref)).canRun).toBe(true);
	});

	it('waits for a capture: a finished one at once, an open one up to the seconds given, and says when it is not finished', async () => {
		const it7 = await newItem();
		const asked = await requestShots(as('member'), { item: it7.ref });
		const early = await waitForShotsRun(
			as('member'),
			{ run: asked.id, seconds: 1 },
			{ pollMs: 100 }
		);
		expect(early.finished).toBe(false);
		expect(early.run.state).toBe('queued');
		const job = (await claimShotsJob(db, toolAuth, services))!;
		await finishShotsRun(db, toolAuth, job.id, {
			state: 'done',
			notes: ['No screen changed in this item.']
		});
		const late = await waitForShotsRun(
			as('member'),
			{ run: asked.id, seconds: 5 },
			{ pollMs: 100 }
		);
		expect(late.finished).toBe(true);
		expect(late.run.state).toBe('done');
		expect((await getShotsRun(as('member'), asked.id)).item).toBe(it7.ref);
	});

	it('shows a private item to nobody who may not see it, and a viewer a summary with no pictures, pages, notes or paths', async () => {
		const open = await newItem();
		const secret = await newItem({ visibility: 'private' });
		const made = await capture(open.ref, { notes: ['New screens have no Before: /acme/CKT/new'] });
		await capture(secret.ref);
		await expect(itemShots(as('viewer'), secret.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(getShotsRun(as('viewer'), made.job.id)).resolves.toBeTruthy();
		const seen = await itemShots(as('viewer'), open.ref);
		expect(seen.canSeePictures).toBe(false);
		expect(seen.canRun).toBe(false);
		expect(seen.rows).toEqual([]);
		expect(seen.runs[0]).toMatchObject({
			state: 'done',
			screens: 1,
			results: [],
			notes: [],
			changedPaths: [],
			outsideCalls: 0,
			afterCommit: null,
			beforeCommit: null,
			diffHash: null,
			reason: null
		});
		const member = await itemShots(as('member'), open.ref);
		expect(member.runs[0].notes).toHaveLength(1);
		expect(member.runs[0].changedPaths).toEqual(['src/lib/Card.svelte']);
		const scales = await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(designScale));
		expect(scales.length).toBeGreaterThan(0);
	});
});
