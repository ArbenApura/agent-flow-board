// RENAMING EXISTING ITEMS TO <PROJECT KEY>-YYYYMMDD-HHMM IN UTC, ON A THROWAWAY DATABASE (FLOW-20261017-0950, SPEC 4.4)

// -- DEP-MODULES -- //
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { liveOrgIds, renameOrg } from '../../src/lib/server/db/renameRefs';
import { OpError } from '../../src/lib/server/ops/context';
import { createItem, getItem, trashItem } from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('renaming existing items', () => {
	let db: TestDb;

	beforeAll(async () => {
		db = await makePostgres();
	}, 120_000);
	afterAll(() => db?.stop());

	/** An item as an older version wrote it: a key and number reference, a creation time and any aliases. */
	async function oldItem(
		w: World,
		number: number,
		createdAt: string,
		aliases: string[] = [],
		title = `Old item ${number}`
	) {
		const id = randomUUID();
		await db.admin.exec(
			`INSERT INTO item (id, org_id, project_id, number, ref, title, created_at) VALUES ('${id}', '${w.orgId}', '${w.projectId}', ${number}, '${w.projectKey}-${number}', '${title}', '${createdAt}')`
		);
		for (const alias of aliases)
			await db.admin.exec(
				`INSERT INTO item_alias (org_id, project_id, item_id, alias) VALUES ('${w.orgId}', '${w.projectId}', '${id}', '${alias}')`
			);
		return id;
	}

	const refOf = async (w: World, id: string) =>
		(await db.admin.query<{ ref: string }>(`SELECT ref FROM item WHERE id = '${id}'`))[0].ref;

	it('renames an imported plan from its legacy id, +08:00 read as UTC, and a native item from its creation time', async () => {
		const w = await makeWorld(db);
		const imported = await oldItem(w, 1, '2026-10-14 00:00:00+00', ['FLOW-20261014-1047']);
		const native = await oldItem(w, 2, '2026-10-17 09:50:30+00');
		const plan = await renameOrg(db, w.orgId, { apply: true });
		expect(plan.applied).toBe(2);
		expect(await refOf(w, imported)).toBe(`${w.projectKey}-20261014-0247`);
		expect(await refOf(w, native)).toBe(`${w.projectKey}-20261017-0950`);
		expect(plan.renames.map((r) => r.source).sort()).toEqual(['creation time', 'legacy id']);
	});

	it('keeps every old name: the old reference and the legacy id still find the item', async () => {
		const w = await makeWorld(db);
		const id = await oldItem(w, 1, '2026-10-14 00:00:00+00', ['FLOW-20261014-1047']);
		await renameOrg(db, w.orgId, { apply: true });
		for (const name of [`${w.projectKey}-1`, 'FLOW-20261014-1047', `${w.projectKey}-20261014-0247`])
			expect((await getItem(w.ctx('owner'), name)).item.id, name).toBe(id);
	});

	it('renames 26 items of one minute and lists the 27th as skipped, still reachable by its old reference', async () => {
		const w = await makeWorld(db);
		const ids: string[] = [];
		for (let n = 1; n <= 27; n++)
			ids.push(await oldItem(w, n, `2026-10-17 19:00:${String(n).padStart(2, '0')}+00`));
		const plan = await renameOrg(db, w.orgId, { apply: true });
		expect(plan.applied).toBe(26);
		expect(plan.skipped).toEqual([
			expect.objectContaining({ id: ids[26], reason: 'every suffix of its minute is taken' })
		]);
		// The 27th keeps its old reference, so nothing is lost
		expect(await refOf(w, ids[26])).toBe(`${w.projectKey}-27`);
		expect(await refOf(w, ids[25])).toBe(`${w.projectKey}-20261017-1900-z`);
	});

	it('gives a shared minute the plain stamp, then -b, -c, in the order they were made', async () => {
		const w = await makeWorld(db);
		const a = await oldItem(w, 1, '2026-10-17 10:00:05+00');
		const b = await oldItem(w, 2, '2026-10-17 10:00:20+00');
		const c = await oldItem(w, 3, '2026-10-17 10:00:40+00');
		await renameOrg(db, w.orgId, { apply: true });
		const base = `${w.projectKey}-20261017-1000`;
		expect([await refOf(w, a), await refOf(w, b), await refOf(w, c)]).toEqual([
			base,
			`${base}-b`,
			`${base}-c`
		]);
	});

	it('keeps a legacy suffix after the converted minute', async () => {
		const w = await makeWorld(db);
		const id = await oldItem(w, 1, '2026-10-14 00:00:00+00', ['FLOW-20261014-1047-b']);
		await renameOrg(db, w.orgId, { apply: true });
		expect(await refOf(w, id)).toBe(`${w.projectKey}-20261014-0247-b`);
	});

	it('falls back to the creation time for a legacy id without a real time, and says so by its source', async () => {
		const w = await makeWorld(db);
		const id = await oldItem(w, 1, '2026-10-12 08:30:00+00', ['FLOW-20261014-2460']);
		const plan = await renameOrg(db, w.orgId, { apply: true });
		expect(await refOf(w, id)).toBe(`${w.projectKey}-20261012-0830`);
		expect(plan.renames[0].source).toBe('creation time');
	});

	it('renames a trashed item too', async () => {
		const w = await makeWorld(db);
		const id = await oldItem(w, 1, '2026-10-17 11:00:00+00');
		await db.admin.exec(`UPDATE item SET deleted_at = now() WHERE id = '${id}'`);
		await renameOrg(db, w.orgId, { apply: true });
		expect(await refOf(w, id)).toBe(`${w.projectKey}-20261017-1100`);
	});

	it('changes nothing on a second run and reshuffles no suffix', async () => {
		const w = await makeWorld(db);
		const a = await oldItem(w, 1, '2026-10-17 12:00:05+00');
		const b = await oldItem(w, 2, '2026-10-17 12:00:20+00');
		await renameOrg(db, w.orgId, { apply: true });
		const before = [await refOf(w, a), await refOf(w, b)];
		const again = await renameOrg(db, w.orgId, { apply: true });
		expect(again.renames).toEqual([]);
		expect(again.applied).toBe(0);
		expect(again.alreadyDone).toBe(2);
		expect([await refOf(w, a), await refOf(w, b)]).toEqual(before);
	});

	it('leaves the plain stamp to an item made after the change in the same minute and takes the next suffix', async () => {
		const w = await makeWorld(db);
		const old = await oldItem(w, 100, '2026-10-17 13:00:10+00');
		const fresh = await createItem(
			w.ctx('owner'),
			{ project: w.projectKey, title: 'Made after the change' },
			{ now: new Date('2026-10-17T13:00:30Z') }
		);
		expect(fresh.ref).toBe(`${w.projectKey}-20261017-1300`);
		await renameOrg(db, w.orgId, { apply: true });
		expect(await refOf(w, old)).toBe(`${w.projectKey}-20261017-1300-b`);
		expect(await refOf(w, fresh.id)).toBe(`${w.projectKey}-20261017-1300`);
	});

	it('skips an item whose old name is an alias of another item, so the old name never points at the wrong one', async () => {
		const w = await makeWorld(db);
		const a = await oldItem(w, 1, '2026-10-17 14:00:00+00');
		await oldItem(w, 2, '2026-10-17 14:05:00+00', [`${w.projectKey}-1`]);
		const plan = await renameOrg(db, w.orgId, { apply: true });
		expect(await refOf(w, a)).toBe(`${w.projectKey}-1`);
		expect(plan.skipped).toEqual([
			expect.objectContaining({ id: a, reason: 'its old reference is an alias of another item' })
		]);
	});

	it('an existing alias with the new name does not abort the org: that minute takes the next suffix', async () => {
		const w = await makeWorld(db);
		await oldItem(w, 1, '2026-10-17 15:30:00+00', [`${w.projectKey.toLowerCase()}-20261017-1500`]);
		const b = await oldItem(w, 2, '2026-10-17 15:00:30+00');
		await renameOrg(db, w.orgId, { apply: true });
		expect(await refOf(w, b)).toBe(`${w.projectKey}-20261017-1500-b`);
	});

	it('a dry run writes nothing, and an apply refuses when the count is no longer the one shown', async () => {
		const w = await makeWorld(db);
		const id = await oldItem(w, 1, '2026-10-17 16:00:00+00');
		const dry = await renameOrg(db, w.orgId);
		expect(dry.renames).toHaveLength(1);
		expect(dry.applied).toBe(0);
		expect(await refOf(w, id)).toBe(`${w.projectKey}-1`);
		const err = await renameOrg(db, w.orgId, { apply: true, expected: 5 }).catch((e) => e);
		expect(String((err as Error).message)).toContain('Nothing was changed');
		expect(await refOf(w, id)).toBe(`${w.projectKey}-1`);
	});

	it('works inside the org only', async () => {
		const w = await makeWorld(db);
		const other = await makeWorld(db);
		const mine = await oldItem(w, 1, '2026-10-17 17:00:00+00');
		const theirs = await oldItem(other, 1, '2026-10-17 17:00:00+00');
		await renameOrg(db, w.orgId, { apply: true });
		expect(await refOf(w, mine)).toBe(`${w.projectKey}-20261017-1700`);
		expect(await refOf(other, theirs)).toBe(`${other.projectKey}-1`);
	});

	it('lists the live orgs and leaves out one that is deleted', async () => {
		const w = await makeWorld(db);
		const gone = await makeWorld(db);
		await db.admin.exec(`UPDATE org SET deleted_at = now() WHERE id = '${gone.orgId}'`);
		// The script runs as a superuser, so the owner connection is the superuser here too (the bound owner would see no orgs)
		const ids = await liveOrgIds({ ...db, owner: db.admin });
		expect(ids).toContain(w.orgId);
		expect(ids).not.toContain(gone.orgId);
	});

	it('still refuses what the ops layer refuses: a trashed item stays reachable by its new name', async () => {
		const w = await makeWorld(db);
		const made = await createItem(
			w.ctx('owner'),
			{ project: w.projectKey, title: 'Trash me' },
			{ now: new Date('2026-10-17T18:00:00Z') }
		);
		await trashItem(w.ctx('owner'), made.ref);
		const err = await getItem(w.ctx('owner'), made.ref).catch((e) => e);
		expect((err as OpError).code).toBe('NOT_FOUND');
	});
});
