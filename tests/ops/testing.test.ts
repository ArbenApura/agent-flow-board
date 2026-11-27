// TESTING (AFB-20261127-0438): CASES AND VERSIONS, ADOPTION WITH A BASELINE, RESULTS WITH STRICT PROOF, ONE DEFECT PER CASE AND PLAN,
// THE PLAN'S VISIBILITY ON EVERY READ, GUESTS SEE NOTHING, THE REDACTOR, THE EXPORT, THE BACKUP KEEPS ROWS ONLY AND THE PURGE ERASES FILES

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { exportOrg } from '../../src/lib/server/backup/dump';
import { dueOrgPurges, purgeOrg } from '../../src/lib/server/orgs/purge';
import { createItem } from '../../src/lib/server/ops/items';
import {
	adoptCases,
	codeOf,
	isFlaky,
	readProofImage,
	recordResults,
	redact,
	retireCase,
	runStateOf,
	saveCase,
	startRun,
	testCaseDetail,
	testingExportTable,
	testingSheet
} from '../../src/lib/server/ops/testing';
import { safeCell, toCsv, toXlsx } from '../../src/lib/server/testing/export';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
/** A small PNG-looking file with a real header, made different by its last bytes. */
const png = (n: number, width = 1280) => {
	const b = new Uint8Array(33);
	b.set(SIG);
	b[11] = 13;
	b.set([0x49, 0x48, 0x44, 0x52], 12);
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, 800);
	b[29] = Math.floor(n / 256);
	b[30] = n % 256;
	return Buffer.from(b).toString('base64');
};
const UI_CASE = {
	area: 'apps/centers/queue',
	kind: 'ui' as const,
	title: 'A checked-in patient appears at the top of the queue',
	steps: [{ action: 'Check in a patient' }, { action: 'Read the first row of the queue' }],
	checks: [{ kind: 'element' as const, expect: 'the first row is the patient' }],
	devices: [
		{ device: 'laptop' as const, width: 1280, height: 800 },
		{ device: 'phone' as const, width: 408, height: 840 }
	]
};

// -- FUNCTIONS -- //

describe('the pure helpers', () => {
	it('masks secrets and cuts long lines', () => {
		expect(redact('Authorization: Bearer abcdefgh12345678')).not.toContain('abcdefgh12345678');
		expect(redact('login with password=hunter22 then go')).toBe(
			'login with password=[redacted] then go'
		);
		expect(redact('token afb_0123456789abcdef in the log')).toContain('afb_[redacted]');
		expect(redact('x'.repeat(900)).length).toBeLessThanOrEqual(501);
	});
	it('takes the key code from the last level of the area, and reads flaky and abandoned', () => {
		expect(codeOf('apps/centers/queue')).toBe('QUEUE');
		expect(codeOf('AUTH')).toBe('AUTH');
		expect(isFlaky(['pass', 'fail', 'pass'])).toBe(true);
		expect(isFlaky(['pass', 'pass', 'fail', 'fail'])).toBe(false);
		const old = new Date(Date.now() - 31 * 60_000);
		expect(runStateOf({ state: 'open', lastActivityAt: old })).toBe('abandoned');
		expect(runStateOf({ state: 'open', lastActivityAt: new Date() })).toBe('open');
	});
	it('defuses a formula in a cell and writes a real zip for Excel', () => {
		expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
		expect(safeCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
		expect(safeCell('plain')).toBe('plain');
		const csv = toCsv({ columns: ['A', 'B'], rows: [['=1+1', 'a,b']] });
		expect(csv).toContain(`'=1+1,"a,b"`);
		const xlsx = toXlsx({ columns: ['A'], rows: [['x']] });
		expect([...xlsx.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
	});
});

describe('testing verbs', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage('testing-ops-secret-0123456789');
	const services = { storage, baseUrl: 'https://afb.test' };
	const as = (who: keyof World['people'], requestId?: string) => ({
		...w.ctx(who, requestId ? { requestId } : {}),
		services
	});
	const agent = (requestId?: string) => ({
		...w.ctx('member', { kind: 'agent', ...(requestId ? { requestId } : {}) }),
		services
	});
	const plan = async (
		title: string,
		who: keyof World['people'] = 'member',
		visibility?: 'private'
	) =>
		(
			await createItem(as(who), {
				project: w.projectKey,
				title,
				...(visibility ? { visibility } : {})
			})
		).ref as string;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	it('gives keys from the area counter, versions a case and keeps the baseline of an adoption', async () => {
		const p = await plan('Cases plan');
		const a = await saveCase(agent(), { project: w.projectKey, ...UI_CASE, plan: p });
		const b = await saveCase(agent(), {
			project: w.projectKey,
			...UI_CASE,
			title: 'Call next closes with Esc',
			plan: p
		});
		expect(a.case.key).toBe('TC-QUEUE-01');
		expect(b.case.key).toBe('TC-QUEUE-02');
		const v2 = await saveCase(agent(), {
			project: w.projectKey,
			...UI_CASE,
			key: a.case.key,
			plan: p
		});
		expect(v2.case.version).toBe(2);
		// A viewer may not write
		await expect(
			saveCase(as('viewer'), { project: w.projectKey, ...UI_CASE })
		).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		// A UI case names a device
		await expect(
			saveCase(agent(), { project: w.projectKey, ...UI_CASE, devices: [] })
		).rejects.toBeTruthy();
		const later = await plan('Later plan');
		await adoptCases(agent(), { item: later, cases: [{ key: a.case.key, role: 'reuse' }] });
		await retireCase(agent(), { project: w.projectKey, key: b.case.key, plan: later });
		const sheet = await testingSheet(as('viewer'), w.projectKey);
		expect(sheet.cases.find((c) => c.key === b.case.key)?.retired).toBe(true);
	});

	it('refuses a decided UI result with no picture, stores one per device, and a retry replaces it', async () => {
		const p = await plan('Proof plan');
		const made = await saveCase(agent(), {
			project: w.projectKey,
			...UI_CASE,
			title: 'Proof case',
			plan: p
		});
		const r = await startRun(agent(), { project: w.projectKey, item: p });
		await expect(
			recordResults(agent(), {
				run: r.run,
				results: [{ case: made.case.key, device: 'laptop', mode: 'light', status: 'pass' }]
			})
		).rejects.toMatchObject({ code: 'PROOF_REQUIRED' });
		// A picture that is not a picture is refused before anything is written
		await expect(
			recordResults(agent(), {
				run: r.run,
				results: [
					{
						case: made.case.key,
						device: 'laptop',
						mode: 'light',
						status: 'pass',
						proofs: [{ data: Buffer.from('not a picture at all').toString('base64') }]
					}
				]
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		const before = storage.files.size;
		const send = (n: number, requestId?: string) =>
			recordResults(agent(requestId), {
				run: r.run,
				results: [
					{
						case: made.case.key,
						device: 'laptop',
						mode: 'light',
						status: 'pass',
						actual: 'The patient was first. password=hunter22',
						proofs: [{ data: png(n) }]
					}
				]
			});
		await send(1, 'proof-retry-0001');
		await send(1, 'proof-retry-0001');
		expect(storage.files.size).toBe(before + 1);
		await send(2);
		expect(storage.files.size).toBe(before + 1);
		const detail = await testCaseDetail(as('viewer'), w.projectKey, made.case.key);
		const laptop = detail.results.find((x) => x.device === 'laptop')!;
		expect(laptop.actual).not.toContain('hunter22');
		expect(laptop.proofs).toHaveLength(1);
		expect(laptop.proofs[0].image).toMatch(/^\/pictures\/test-proof\/[0-9a-f-]+\?v=/);
		const id = laptop.proofs[0].id;
		expect(await readProofImage(db, storage, w.people.viewer, id)).not.toBeNull();
		expect(await readProofImage(db, storage, w.people.guest, id)).toBeNull();
	});

	it('files one defect for a fail and closes it when the plan passes on every device', async () => {
		const p = await plan('Defect plan');
		const made = await saveCase(agent(), {
			project: w.projectKey,
			...UI_CASE,
			title: 'Defect case',
			plan: p
		});
		const r = await startRun(agent(), { project: w.projectKey, item: p });
		const send = (device: 'laptop' | 'phone', status: 'pass' | 'fail', n: number) =>
			recordResults(agent(), {
				run: r.run,
				results: [
					{
						case: made.case.key,
						device,
						mode: 'light',
						status,
						proofs: [{ data: png(n, device === 'phone' ? 408 : 1280) }]
					}
				]
			});
		await send('phone', 'fail', 10);
		await send('phone', 'fail', 11);
		let sheet = await testingSheet(as('member'), w.projectKey);
		const defect = sheet.cases.find((c) => c.key === made.case.key)?.defect;
		expect(defect).toMatch(/^T-\d+$/);
		await send('phone', 'pass', 12);
		await send('laptop', 'pass', 13);
		sheet = await testingSheet(as('member'), w.projectKey);
		expect(sheet.cases.find((c) => c.key === made.case.key)?.defect).toBeNull();
	});

	it("hides a private plan's runs from another member and everything from a guest", async () => {
		const p = await plan('Private plan', 'admin', 'private');
		const made = await saveCase(
			{ ...w.ctx('admin', { kind: 'agent' }), services },
			{
				project: w.projectKey,
				area: 'SECRET',
				kind: 'api',
				title: 'A private plan case',
				steps: [{ action: 'Call it' }],
				checks: [{ kind: 'text', expect: '200' }],
				devices: []
			}
		);
		const r = await startRun(
			{ ...w.ctx('admin', { kind: 'agent' }), services },
			{ project: w.projectKey, item: p }
		);
		await recordResults(
			{ ...w.ctx('admin', { kind: 'agent' }), services },
			{
				run: r.run,
				results: [
					{
						case: made.case.key,
						device: 'laptop',
						mode: 'light',
						status: 'fail',
						output: 'private output'
					}
				]
			}
		);
		const member = await testingSheet(as('member'), w.projectKey);
		expect(member.cases.find((c) => c.key === made.case.key)?.results).toEqual([]);
		const rows = await testingExportTable(as('member'), w.projectKey);
		expect(JSON.stringify(rows)).not.toContain('private output');
		const own = await testingSheet(as('admin'), w.projectKey);
		expect(own.cases.find((c) => c.key === made.case.key)?.status).toBe('fail');
		await expect(testingSheet(as('guest'), w.projectKey)).rejects.toMatchObject({
			code: expect.any(String)
		});
	});

	it('keeps the rows in the backup dump and never the proof files, and the purge erases them', async () => {
		const frames = (await exportOrg(adminFromExecutor(db.admin), storage, w.orgId)).frames;
		const tables = frames.flatMap((f) =>
			f.type === 'table' ? [f.json as { table: string; rows: unknown[] }] : []
		);
		expect(tables.find((t) => t.table === 'test_proof')?.rows.length ?? 0).toBeGreaterThan(0);
		const keys = frames.flatMap((f) =>
			f.type === 'file' ? [(f.json as { key: string }).key] : []
		);
		expect(keys.some((k) => k.startsWith('testproofs/'))).toBe(false);
		const proofKeys = [...storage.files.keys()].filter((k) => k.startsWith('testproofs/'));
		expect(proofKeys.length).toBeGreaterThan(0);
		await db.admin.exec(
			`update org set deleted_at = now() - interval '40 days' where id = '${w.orgId}'`
		);
		expect(await dueOrgPurges(db)).toContain(w.orgId);
		expect(await purgeOrg({ handle: db, storage, backups: null }, w.orgId)).toBe('purged');
		for (const k of proofKeys) expect(storage.files.has(k)).toBe(false);
	});
});
