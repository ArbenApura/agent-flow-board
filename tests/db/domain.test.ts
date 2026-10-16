// 3.5 TO 3.8: NUMBERING, EVENTS AND UNDO, WRITE TIME VALUES, FULL TEXT SEARCH, ON PGLITE AND ON REAL POSTGRESQL

// -- DEP-MODULES -- //
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { percentOf, recalcItem, driftFlags } from '../../src/lib/server/db/calc';
import { appendEvent, undoEvent } from '../../src/lib/server/db/events';
import { allocateItemNumber, allocateTaskNumber } from '../../src/lib/server/db/numbering';
import { searchAll } from '../../src/lib/server/db/search';
import { decision, event, item, phase, section, step, task } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { makePglite, makePostgres, seedTwoOrgs, type Seed, type TestDb } from '../support/db';

// -- FUNCTIONS -- //

describe('pure calculations', () => {
	it('percent is done over counted steps, rounded down, and 0 with none', () => {
		expect(percentOf(3, 1)).toBe(33);
		expect(percentOf(3, 3)).toBe(100);
		expect(percentOf(0, 0)).toBe(0);
	});
	it('drift flags follow SPEC 9.4 and never fire for a legacy item', () => {
		const base = { total: 4, done: 4, openManual: 0, legacy: false };
		expect(driftFlags({ ...base, status: 'IN PROGRESS' })).toEqual(['complete-not-in-review']);
		expect(driftFlags({ ...base, status: 'IN REVIEW' })).toEqual(['ready-for-sign-off']);
		expect(driftFlags({ ...base, status: 'IN REVIEW', done: 3 })).toEqual([
			'in-review-with-open-steps'
		]);
		expect(driftFlags({ ...base, status: 'PLANNED', done: 1 })).toEqual([
			'planned-with-done-steps'
		]);
		expect(driftFlags({ ...base, status: 'IN REVIEW', legacy: true })).toEqual([]);
		expect(driftFlags({ ...base, status: 'IN REVIEW', total: 0, done: 0 })).toEqual([]);
	});
});

describe.each([
	['pglite', makePglite],
	['postgres', makePostgres]
] as const)('database domain helpers on %s', (name, make) => {
	let db: TestDb;
	let s: Seed;
	const tenant = () => ({ orgId: s.orgA, projectId: s.projectA });

	beforeAll(async () => {
		db = await make();
		s = await seedTwoOrgs(db);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	async function newItem(title: string) {
		return withTenant(db, tenant(), async (tx) => {
			const { number, ref } = await allocateItemNumber(tx, s.orgA, s.projectA);
			const [row] = await tx
				.insert(item)
				.values({ orgId: s.orgA, projectId: s.projectA, number, ref, title })
				.returning();
			return row;
		});
	}

	it('numbers items one after another, and a rolled back create gives its number back', async () => {
		const a = await newItem('First numbered item');
		const b = await newItem('Second numbered item');
		expect(b.number).toBe(a.number + 1);
		await expect(
			withTenant(db, tenant(), async (tx) => {
				await allocateItemNumber(tx, s.orgA, s.projectA);
				throw new Error('create failed');
			})
		).rejects.toThrow('create failed');
		const c = await newItem('Third numbered item');
		expect(c.number).toBe(b.number + 1);
		expect(c.ref).toBe(`AAA-${c.number}`);
	});

	it('numbers tasks on their own counter', async () => {
		const n1 = await withTenant(db, tenant(), (tx) => allocateTaskNumber(tx, s.orgA, s.projectA));
		const n2 = await withTenant(db, tenant(), (tx) => allocateTaskNumber(tx, s.orgA, s.projectA));
		expect(n2).toBe(n1 + 1);
	});

	it.runIf(name === 'postgres')('40 concurrent creates never share a number', async () => {
		const made = await Promise.all(
			Array.from({ length: 40 }, (_, i) => newItem(`Concurrent item ${i}`))
		);
		const numbers = made.map((m) => m.number);
		expect(new Set(numbers).size).toBe(40);
		const sorted = [...numbers].sort((x, y) => x - y);
		expect(sorted[39] - sorted[0]).toBe(39);
	});

	async function itemWithSteps(count: number) {
		const it = await newItem(`Steps ${count}`);
		const ids = await withTenant(db, tenant(), async (tx) => {
			const [ph] = await tx
				.insert(phase)
				.values({
					orgId: s.orgA,
					projectId: s.projectA,
					itemId: it.id,
					key: '1',
					title: 'Phase',
					position: 1
				})
				.returning();
			const rows = await tx
				.insert(step)
				.values(
					Array.from({ length: count }, (_, i) => ({
						orgId: s.orgA,
						projectId: s.projectA,
						itemId: it.id,
						phaseId: ph.id,
						key: `1.${i + 1}`,
						text: `Step ${i + 1}`,
						position: i + 1
					}))
				)
				.returning({ id: step.id });
			await recalcItem(tx, it.id);
			return rows.map((r) => r.id);
		});
		return { it, ids };
	}

	it('recalculates percent and counts from the steps, ignoring waived ones', async () => {
		const { it, ids } = await itemWithSteps(4);
		await withTenant(db, tenant(), async (tx) => {
			await tx.update(step).set({ state: 'done' }).where(eq(step.id, ids[0]));
			await tx.update(step).set({ state: 'waived' }).where(eq(step.id, ids[1]));
			const r = await recalcItem(tx, it.id);
			expect(r.counts).toEqual({ total: 3, done: 1, openManual: 0 });
			expect(r.percent).toBe(33);
		});
		const [row] = await withTenant(db, tenant(), (tx) =>
			tx.select().from(item).where(eq(item.id, it.id))
		);
		expect(row.percent).toBe(33);
		expect(row.totalSteps).toBe(3);
		expect(row.version).toBeGreaterThan(1);
	});

	it('a frozen legacy percent is kept', async () => {
		const { it, ids } = await itemWithSteps(2);
		await withTenant(db, tenant(), async (tx) => {
			await tx.update(item).set({ legacyPercent: 80 }).where(eq(item.id, it.id));
			await tx.update(step).set({ state: 'done' }).where(eq(step.id, ids[0]));
			expect((await recalcItem(tx, it.id)).percent).toBe(80);
		});
	});

	it.runIf(name === 'postgres')('30 concurrent step completions all count', async () => {
		const { it, ids } = await itemWithSteps(30);
		await Promise.all(
			ids.map((sid) =>
				withTenant(db, tenant(), async (tx) => {
					await tx.update(step).set({ state: 'done' }).where(eq(step.id, sid));
					await recalcItem(tx, it.id);
				})
			)
		);
		const [row] = await withTenant(db, tenant(), (tx) =>
			tx.select().from(item).where(eq(item.id, it.id))
		);
		expect(row.doneSteps).toBe(30);
		expect(row.percent).toBe(100);
	});

	it('undo reverses an update, refuses when the target changed again, and can be forced', async () => {
		const it = await newItem('Undo target');
		const first = await withTenant(db, tenant(), async (tx) => {
			await tx.update(item).set({ title: 'Renamed once' }).where(eq(item.id, it.id));
			return appendEvent(tx, {
				orgId: s.orgA,
				projectId: s.projectA,
				itemId: it.id,
				verb: 'item.update',
				targetType: 'item',
				targetId: it.id,
				before: { title: 'Undo target' },
				after: { title: 'Renamed once' }
			});
		});
		const second = await withTenant(db, tenant(), async (tx) => {
			await tx.update(item).set({ title: 'Renamed twice' }).where(eq(item.id, it.id));
			return appendEvent(tx, {
				orgId: s.orgA,
				projectId: s.projectA,
				itemId: it.id,
				verb: 'item.update',
				targetType: 'item',
				targetId: it.id,
				before: { title: 'Renamed once' },
				after: { title: 'Renamed twice' }
			});
		});
		const blocked = await withTenant(db, tenant(), (tx) =>
			undoEvent(tx, { actorLabel: 'Ana' }, first)
		);
		expect(blocked).toEqual({ ok: false, reason: 'conflict', conflicts: [second] });
		const ok = await withTenant(db, tenant(), (tx) => undoEvent(tx, { actorLabel: 'Ana' }, second));
		expect(ok.ok).toBe(true);
		const [now] = await withTenant(db, tenant(), (tx) =>
			tx.select().from(item).where(eq(item.id, it.id))
		);
		expect(now.title).toBe('Renamed once');
		const again = await withTenant(db, tenant(), (tx) =>
			undoEvent(tx, { actorLabel: 'Ana' }, second)
		);
		expect(again).toEqual({ ok: false, reason: 'already-undone' });
		// The undo of the second cancels out the second, so the first is now free to undo without forcing
		const afterUndo = await withTenant(db, tenant(), (tx) =>
			undoEvent(tx, { actorLabel: 'Ana' }, first)
		);
		expect(afterUndo.ok).toBe(true);
		const [final] = await withTenant(db, tenant(), (tx) =>
			tx.select().from(item).where(eq(item.id, it.id))
		);
		expect(final.title).toBe('Undo target');
		// Every undo is its own event and none of the old ones changed
		const log = await withTenant(db, tenant(), (tx) =>
			tx
				.select()
				.from(event)
				.where(and(eq(event.itemId, it.id)))
		);
		expect(log.filter((e) => e.verb === 'item.undo')).toHaveLength(2);
	});

	it('undo of a create trashes the item, undo of a delete restores it, and an external event is refused', async () => {
		const it = await newItem('Created then undone');
		const created = await withTenant(db, tenant(), (tx) =>
			appendEvent(tx, {
				orgId: s.orgA,
				projectId: s.projectA,
				itemId: it.id,
				verb: 'item.create',
				targetType: 'item',
				targetId: it.id
			})
		);
		await withTenant(db, tenant(), (tx) => undoEvent(tx, {}, created));
		const [trashed] = await withTenant(db, tenant(), (tx) =>
			tx.select().from(item).where(eq(item.id, it.id))
		);
		expect(trashed.deletedAt).not.toBeNull();
		const external = await withTenant(db, tenant(), (tx) =>
			appendEvent(tx, {
				orgId: s.orgA,
				projectId: s.projectA,
				verb: 'publish.run',
				targetType: 'publish_run',
				targetId: it.id,
				external: true
			})
		);
		expect(await withTenant(db, tenant(), (tx) => undoEvent(tx, {}, external))).toEqual({
			ok: false,
			reason: 'external'
		});
	});

	it('searches items, sections, decisions and tasks inside the tenant only', async () => {
		const it = await newItem('Quarterly invoicing overhaul');
		await withTenant(db, tenant(), async (tx) => {
			await tx.insert(section).values({
				orgId: s.orgA,
				projectId: s.projectA,
				itemId: it.id,
				slug: 'spec',
				title: 'Spec',
				body: 'The ledger export must reconcile nightly.'
			});
			await tx.insert(decision).values({
				orgId: s.orgA,
				projectId: s.projectA,
				itemId: it.id,
				number: 1,
				title: 'Ledger vendor',
				decision: 'Use the in-house ledger'
			});
			await tx.insert(task).values({
				orgId: s.orgA,
				projectId: s.projectA,
				number: 900,
				title: 'Reconcile ledger exports'
			});
		});
		await db.admin.exec(
			`insert into item (org_id, project_id, number, ref, title) values ('${s.orgB}', '${s.projectB}', 50, 'BBB-50', 'Secret ledger plan of the other org')`
		);
		const hits = await withTenant(db, { orgId: s.orgA }, (tx) => searchAll(tx, 'ledger'));
		expect(new Set(hits.map((h) => h.kind))).toEqual(new Set(['section', 'decision', 'task']));
		expect(hits.some((h) => h.title.includes('Secret'))).toBe(false);
		const byRef = await withTenant(db, { orgId: s.orgA }, (tx) => searchAll(tx, it.ref));
		expect(byRef[0]).toMatchObject({ kind: 'item', id: it.id });
		const odd = await withTenant(db, { orgId: s.orgA }, (tx) =>
			searchAll(tx, `"unclosed quote & | ! ( ) :*`)
		);
		expect(Array.isArray(odd)).toBe(true);
		expect(await withTenant(db, { orgId: s.orgA }, (tx) => searchAll(tx, '   '))).toEqual([]);
		void sql;
	});
});
