// PHASE 11: THE "UI CHANGES" TABLE, SHOTS AND MEASURE RUNS, THE FLAGS THE SERVER WORKS OUT, AND WHO MAY SEE WHICH SHOTS (L39, L40, L41)

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
	saveEnvironment
} from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import {
	claimShotsJob,
	finishShotsRun,
	getScale,
	itemShots,
	listUiChanges,
	requestMeasure,
	requestShots,
	saveUiChanges,
	shotsAccounts,
	storeShotImage
} from '../../src/lib/server/ops/uiShots';
import { makePglite, makePostgres, type TestDb } from '../support/db';
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

describe.each([
	['pglite', makePglite],
	['postgres', makePostgres]
] as const)('UI shots on %s', (_name, make) => {
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

	it('runs shots: before on the demo site, never production, flags worked out on the server, pictures private', async () => {
		const it2 = await newItem();
		await saveUiChanges(as('member'), { item: it2.ref, markdown: TABLE });
		await saveCheck(as('member'), {
			item: it2.ref,
			key: 'M1',
			script: 's',
			coveredPaths: ['web/src/routes/settings']
		});
		const asked = await requestShots(as('member'), { item: it2.ref });
		expect(asked.state).toBe('queued');
		expect(asked.target).toBe('preview');
		const job = (await claimShotsJob(db, auth, services))!;
		expect(job.kind).toBe('shots');
		expect(job.afterUrl).toBe('http://localhost:5180');
		// Before is the demo site: the production site is never opened by a shots run
		expect(job.beforeUrl).toBe('https://demo.example.com');
		expect(job.readOnly).toBe(true);
		expect(job.rows).toHaveLength(2);
		expect(job.scale.light['1440'].title).toEqual({ fontSize: 24 });
		expect(job.accounts).toEqual([]);
		await expect(shotsAccounts(db, auth, job.id, services)).resolves.toEqual({});
		// Pictures are JPEG and private
		const ok = await storeShotImage(
			db,
			auth,
			job.id,
			{ filename: 'after-health-light-1440.jpg', caption: 'Health, light, desktop', bytes: JPEG },
			services
		);
		const [att] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(attachment).where(eq(attachment.id, ok.attachmentId))
		);
		expect(att.visibility).toBe('private');
		expect(att.kind).toBe('ui-shot');
		await expect(
			storeShotImage(db, auth, job.id, { filename: 'x.png', caption: 'png', bytes: JPEG }, services)
		).rejects.toThrow(/JPEG/);
		const rowId = job.rows[0].id;
		const base = { row: rowId, state: '', theme: 'light', viewport: 1440 };
		const done = await finishShotsRun(db, auth, job.id, {
			state: 'done',
			afterCommit: 'abc1234',
			diffHash: 'h1',
			beforeTarget: 'deployed',
			changedPaths: ['web/src/routes/settings/+page.svelte', 'web/src/routes/other/+page.svelte'],
			outsideCalls: 1,
			abortedWrites: 2,
			results: [
				{
					...base,
					page: '/acme/CKT/health',
					side: 'after',
					values: { title: m(28), section: m(18), 'button-primary': m(14, 44) },
					image: ok.attachmentId
				},
				{
					...base,
					page: '/acme/CKT/tasks',
					side: 'sibling',
					of: '/acme/CKT/health',
					values: { title: m(24), section: m(18), 'button-primary': m(14, 44) }
				},
				{ ...base, page: '/acme/CKT/health', side: 'before', values: { title: m(24) } }
			]
		});
		expect(done.state).toBe('done');
		expect(done.flags.map((f) => `${f.level}:${f.kind}`).sort()).toEqual([
			'title:larger-than-sibling',
			'title:off-scale'
		]);
		expect(done.flags[0]).toMatchObject({
			page: '/acme/CKT/health',
			theme: 'light',
			viewport: 1440
		});
		const stored = await runRow(job.id);
		expect(stored.foreignPaths).toEqual(['web/src/routes/other/+page.svelte']);
		expect(stored.abortedWrites).toBe(2);
		expect(stored.outsideCalls).toBe(1);
		expect(stored.imageAttachmentIds).toEqual([ok.attachmentId]);
		await expect(finishShotsRun(db, auth, job.id, { state: 'done' })).rejects.toMatchObject({
			code: 'CONFLICT'
		});
		const view = await itemShots(as('member'), it2.ref);
		expect(view.runs[0].flags).toHaveLength(2);
		expect(view.canSeePictures).toBe(true);
		expect(view.runs[0].results.find((x) => x.side === 'after')?.image).toBe(ok.attachmentId);
	});

	it('refuses a production target, falls back to nothing silently, and times out a run nobody takes', async () => {
		const it3 = await newItem();
		await saveUiChanges(as('member'), { item: it3.ref, markdown: TABLE });
		// Only production is deployed in this check: remove the demo site first
		await db.admin.exec(`update environment set production = true where name = 'demo'`);
		const prod = await requestShots(as('member'), { item: it3.ref, target: 'deployed' });
		expect(prod.unavailable).toBe(true);
		expect(prod.reason).toMatch(/production/);
		expect(prod.reason).toMatch(/preview/);
		expect(await claimShotsJob(db, auth, services)).toBeNull();
		await db.admin.exec(`update environment set production = false where name = 'demo'`);
		// With no table the run is refused; with no environment of the kind, it says so
		const empty = await newItem();
		await expect(requestShots(as('member'), { item: empty.ref })).rejects.toThrow(
			/no UI changes table/
		);
		await db.admin.exec(`delete from environment where kind = 'dev'`);
		const noDev = await requestShots(as('member'), { item: it3.ref, target: 'dev' });
		expect(noDev.unavailable).toBe(true);
		expect(noDev.reason).toMatch(/no dev environment/);
		// A run nobody takes is reported stuck
		const queued = await requestShots(as('member'), { item: it3.ref });
		await db.admin.exec(
			`update ui_shot_run set created_at = now() - interval '11 minutes' where id = '${queued.id}'`
		);
		await itemShots(as('member'), it3.ref);
		const row = await runRow(queued.id);
		expect(row.state).toBe('timeout');
		expect(row.reason).toMatch(/within 10 minutes/);
		// A failed run keeps its reason and nothing else
		await requestShots(as('member'), { item: it3.ref });
		const job = (await claimShotsJob(db, auth, services))!;
		const failed = await finishShotsRun(db, auth, job.id, {
			state: 'failed',
			reason: 'The page did not open'
		});
		expect(failed.state).toBe('failed');
		expect((await runRow(job.id)).reason).toBe('The page did not open');
	});

	it('shows a private item to nobody who may not see it, on the item and on the UI page, and shows a viewer numbers without pictures', async () => {
		const open = await newItem();
		const secret = await newItem({ visibility: 'private' });
		for (const it of [open, secret]) {
			await saveUiChanges(as(it === secret ? 'member' : 'member'), {
				item: it.ref,
				markdown: TABLE
			});
			await requestShots(as('member'), { item: it.ref });
			const job = (await claimShotsJob(db, auth, services))!;
			const img = await storeShotImage(
				db,
				auth,
				job.id,
				{ filename: 'a.jpg', caption: 'a', bytes: JPEG },
				services
			);
			await finishShotsRun(db, auth, job.id, {
				state: 'done',
				results: [
					{
						row: job.rows[0].id,
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
		}
		await expect(itemShots(as('viewer'), secret.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const seen = await itemShots(as('viewer'), open.ref);
		expect(seen.canSeePictures).toBe(false);
		expect(seen.canRun).toBe(false);
		const scales = await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(designScale));
		expect(scales.length).toBeGreaterThan(0);
	});
});
