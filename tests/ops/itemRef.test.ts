// THE REFERENCE OF A NEW ITEM: <PROJECT KEY>-YYYYMMDD-HHMM IN UTC, -b, -c ... WHEN THE MINUTE IS TAKEN, NO CLASH WITH AN ALIAS (FLOW-20261017-0950)

// -- DEP-MODULES -- //
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { allocateItemNumber } from '../../src/lib/server/db/numbering';
import { insertItemWithFreshRef, takenRefs } from '../../src/lib/server/db/flowId';
import { item, itemAlias } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { OpError } from '../../src/lib/server/ops/context';
import { searchBoard } from '../../src/lib/server/ops/board';
import { createItem, getItem, listItems, trashItem } from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const AT = new Date('2026-10-17T09:50:30Z');

// -- FUNCTIONS -- //

describe('the reference of a new item', () => {
	let db: TestDb;
	let w: World;
	let secondKey: string;
	let secondProject: string;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		secondProject = w.projectId.replace(/11$/, '21');
		secondKey = 'SECOND';
		await db.admin.exec(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${secondProject}', '${w.orgId}', '${secondKey}', 'Second project')`
		);
	}, 120_000);
	afterAll(() => db?.stop());

	const make = (title: string, now: Date, project = w.projectKey, aliases: string[] = []) =>
		createItem(w.ctx('owner'), { project, title, aliases }, { now });

	it('is the project key and the UTC minute', async () => {
		const made = await make('A first item in the minute', AT);
		expect(made.ref).toBe(`${w.projectKey}-20261017-0950`);
	});

	it('takes -b, -c ... in the same project and minute, and the plain stamp in another project', async () => {
		const later = new Date('2026-10-17T10:11:05Z');
		const refs: string[] = [];
		for (let i = 0; i < 10; i++) refs.push((await make(`Parallel item ${i}`, later)).ref);
		const base = `${w.projectKey}-20261017-1011`;
		expect(refs).toEqual([base, ...'bcdefghij'.split('').map((letter) => `${base}-${letter}`)]);
		expect(new Set(refs).size).toBe(10);
		// Another project in the same minute keeps its own plain stamp
		expect((await make('Other project', later, secondKey)).ref).toBe(`${secondKey}-20261017-1011`);
	});

	it('refuses the 27th item of one minute with a clear message', async () => {
		const full = new Date('2026-10-17T11:00:00Z');
		for (let i = 0; i < 26; i++) await make(`Fill ${i}`, full);
		const err = await make('One too many', full).catch((e) => e);
		expect(err).toBeInstanceOf(OpError);
		expect((err as OpError).code).toBe('CONFLICT');
		expect((err as OpError).message).toContain('Every suffix for this minute is taken');
	});

	it('counts a trashed item as taken, so its reference is not reused', async () => {
		const at = new Date('2026-10-17T12:00:00Z');
		const first = await make('Will be trashed', at);
		await trashItem(w.ctx('owner'), first.ref);
		const second = await make('Made after the trash', at);
		expect(second.ref).toBe(`${first.ref}-b`);
	});

	it('counts an alias as taken, whatever its case', async () => {
		const at = new Date('2026-10-17T13:00:00Z');
		await make('Holds an alias', new Date('2026-10-17T12:59:00Z'), w.projectKey, [
			`${w.projectKey.toLowerCase()}-20261017-1300`
		]);
		const made = await make('Wants the same minute', at);
		expect(made.ref).toBe(`${w.projectKey}-20261017-1300-b`);
	});

	it('refuses an alias that equals the reference of an item, in any case', async () => {
		const at = new Date('2026-10-17T14:00:00Z');
		const first = await make('The item whose ref is wanted', at);
		const err = await make('Wants it as an alias', new Date('2026-10-17T14:30:00Z'), w.projectKey, [
			first.ref.toLowerCase()
		]).catch((e) => e);
		expect((err as OpError).code).toBe('INVALID');
		// And an alias equal to the reference the new item itself is about to take
		const own = await make(
			'Wants its own ref as an alias',
			new Date('2026-10-17T15:00:00Z'),
			w.projectKey,
			[`${w.projectKey}-20261017-1500`]
		).catch((e) => e);
		expect((own as OpError).code).toBe('INVALID');
	});

	it('moves to the next candidate when the first one is lost to a unique violation', async () => {
		const at = new Date('2026-10-17T16:00:00Z');
		const first = await make('Holds the plain stamp', at);
		const taken = first.ref;
		const row = await withTenant(
			db,
			{ orgId: w.orgId, projectId: w.projectId, userId: w.people.owner },
			async (tx) => {
				const { number } = await allocateItemNumber(tx, w.orgId, w.projectId);
				// The check said the plain stamp was free, but another creator took it first: the candidate list still starts with it
				return insertItemWithFreshRef(tx, [taken, `${taken}-b`, `${taken}-c`], {
					orgId: w.orgId,
					projectId: w.projectId,
					number,
					title: 'Lost the race for the plain stamp'
				});
			}
		);
		expect(row.ref).toBe(`${taken}-b`);
		// The savepoint left the transaction usable and nothing half written behind
		const rows = await withTenant(db, { orgId: w.orgId, projectId: w.projectId }, async (tx) =>
			tx.select({ ref: item.ref }).from(item).where(eq(item.orgId, w.orgId))
		);
		expect(rows.filter((r) => r.ref === taken)).toHaveLength(1);
	});

	it('raises any other error instead of retrying it', async () => {
		const err = await withTenant(
			db,
			{ orgId: w.orgId, projectId: w.projectId, userId: w.people.owner },
			async (tx) =>
				insertItemWithFreshRef(tx, ['NOPE-20261017-1700'], {
					orgId: w.orgId,
					projectId: w.projectId,
					// A number that does not fit the column type
					number: 'x' as unknown as number,
					title: 'Broken'
				})
		).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(String((err as Error).message)).not.toContain('Every suffix');
	});

	it('finds a lower case candidate in the alias table when it is looked up in upper case', async () => {
		const found = await withTenant(db, { orgId: w.orgId, projectId: w.projectId }, async (tx) => {
			await tx.insert(itemAlias).values({
				orgId: w.orgId,
				projectId: w.projectId,
				itemId: (await tx.select({ id: item.id }).from(item).limit(1))[0].id,
				alias: 'zz-20261017-1800'
			});
			return takenRefs(tx, w.orgId, ['ZZ-20261017-1800', 'ZZ-20261017-1801']);
		});
		expect([...found]).toEqual(['ZZ-20261017-1800']);
	});
});

describe('finding an item by any name it has had', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	const idOf = async (name: string, ctx = w.ctx('owner')) => (await getItem(ctx, name)).item.id;

	it('finds an item by its stamp, in any case, and by its old reference and its legacy Board id', async () => {
		const made = await createItem(
			w.ctx('owner'),
			{
				project: w.projectKey,
				title: 'An item with three names',
				aliases: [`${w.projectKey}-2`, 'FLOW-20261014-1047']
			},
			{ now: new Date('2026-10-17T09:50:00Z') }
		);
		expect(made.ref).toBe(`${w.projectKey}-20261017-0950`);
		for (const name of [
			made.ref,
			made.ref.toLowerCase(),
			`${w.projectKey}-2`,
			`${w.projectKey.toLowerCase()}-2`,
			'FLOW-20261014-1047',
			'flow-20261014-1047'
		])
			expect(await idOf(name), name).toBe(made.id);
	});

	it('answers with the item whose reference it is when an alias of another item has the same name', async () => {
		const a = await createItem(
			w.ctx('owner'),
			{ project: w.projectKey, title: 'Owns the reference' },
			{ now: new Date('2026-10-17T10:00:00Z') }
		);
		const b = await createItem(
			w.ctx('owner'),
			{ project: w.projectKey, title: 'Has the same text as an alias' },
			{ now: new Date('2026-10-17T10:05:00Z') }
		);
		// The ops layer refuses this alias, so it is written like an old import would have written it
		await db.admin.exec(
			`INSERT INTO item_alias (org_id, project_id, item_id, alias) VALUES ('${w.orgId}', '${w.projectId}', '${b.id}', '${a.ref}')`
		);
		expect(await idOf(a.ref)).toBe(a.id);
	});

	it('gives the same NOT_FOUND for an unknown name, another org and a private item', async () => {
		const priv = await createItem(
			w.ctx('member'),
			{ project: w.projectKey, title: 'Only its maker may see this', visibility: 'private' },
			{ now: new Date('2026-10-17T11:00:00Z') }
		);
		const pub = await createItem(
			w.ctx('owner'),
			{ project: w.projectKey, title: 'Visible in this org' },
			{ now: new Date('2026-10-17T11:05:00Z') }
		);
		const other = {
			handle: db,
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const, label: 'other' }
		};
		const codes = await Promise.all([
			getItem(w.ctx('owner'), 'NOPE-20261017-0000').catch((e) => (e as OpError).code),
			getItem(other, pub.ref).catch((e) => (e as OpError).code),
			getItem(w.ctx('viewer'), priv.ref).catch((e) => (e as OpError).code)
		]);
		expect(codes).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
	});
});

describe('searching for an item by its reference', () => {
	let db: TestDb;
	let w: World;
	let ref: string;
	let id: string;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const made = await createItem(
			w.ctx('owner'),
			{
				project: w.projectKey,
				title: 'Refund dialog redesign',
				aliases: [`${w.projectKey}-2`, 'FLOW-20261014-1047']
			},
			{ now: new Date('2026-10-17T09:50:00Z') }
		);
		ref = made.ref;
		id = made.id;
	}, 120_000);
	afterAll(() => db?.stop());

	const search = async (q: string) =>
		(await searchBoard(w.ctx('owner'), q)).filter((h) => h.kind === 'item').map((h) => h.id);

	it('finds it by the full stamped reference, in any case', async () => {
		expect(await search(ref)).toEqual([id]);
		expect(await search(ref.toLowerCase())).toEqual([id]);
	});

	it('still finds it by its old reference and its legacy Board id', async () => {
		expect(await search(`${w.projectKey}-2`)).toEqual([id]);
		expect(await search('FLOW-20261014-1047')).toEqual([id]);
	});

	it('finds it by the date part or the time part of the stamp', async () => {
		expect(await search('20261017')).toContain(id);
		expect(await search('0950')).toContain(id);
	});

	it('the registry filter box matches the reference start, an alias start and the title', async () => {
		const names = async (q: string) =>
			(await listItems(w.ctx('owner'), { project: w.projectKey, q })).items.map((i) => i.id);
		expect(await names(ref.slice(0, ref.length - 3))).toEqual([id]);
		expect(await names(`${w.projectKey}-2`)).toEqual([id]);
		expect(await names('flow-2026101')).toEqual([id]);
		expect(await names('refund')).toEqual([id]);
		expect(await names('nothing like this')).toEqual([]);
	});
});
