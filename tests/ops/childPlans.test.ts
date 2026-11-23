// MASTER AND CHILD PLANS: THE PARENT LINK, ITS RULES, THE NUMBERING, THE FAMILY A PAGE READS AND THE TRASH RULE (AFB-20261123-1227)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { OpError } from '../../src/lib/server/ops/context';
import {
	createItem,
	getItem,
	listItems,
	restoreItem,
	trashItem,
	updateItem
} from '../../src/lib/server/ops/items';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('master and child plans', () => {
	let db: TestDb;
	let w: World;
	let secondKey: string;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const secondProject = w.projectId.replace(/11$/, '21');
		secondKey = 'SECOND';
		await db.admin.exec(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${secondProject}', '${w.orgId}', '${secondKey}', 'Second project')`
		);
	}, 120_000);
	afterAll(() => db?.stop());

	const owner = () => w.ctx('owner');
	// A reference is the key and the UTC minute with 26 suffixes, so every plan of this file gets a minute of its own
	let minute = 0;
	const nextMinute = () => new Date(Date.UTC(2026, 10, 1, 0, 0) + ++minute * 60_000);
	const make = (title: string, parent?: string, project = w.projectKey) =>
		createItem(owner(), { project, title, parent }, { now: nextMinute() });
	const code = async (p: Promise<unknown>) => {
		const e = await p.catch((x) => x);
		expect(e).toBeInstanceOf(OpError);
		return (e as OpError).code;
	};

	it('numbers the children of a master 1, 2, 3 and lists them in order', async () => {
		const master = await make('Master of three');
		const a = await make('First child', master.ref);
		const b = await make('Second child', master.ref);
		const c = await make('Third child', master.ref);
		expect([a.item.childNo, b.item.childNo, c.item.childNo]).toEqual([1, 2, 3]);
		expect(a.item.parentId).toBe(master.id);
		const detail = await getItem(owner(), master.ref);
		expect(detail.family.kids[master.id].map((k) => k.childNo)).toEqual([1, 2, 3]);
		expect(detail.family.kids[master.id].map((k) => k.ref)).toEqual([a.ref, b.ref, c.ref]);
		const child = await getItem(owner(), b.ref);
		expect(child.family.parents[b.id]).toMatchObject({
			ref: master.ref,
			childNo: 2,
			childTotal: 3
		});
		// The child page links to the one before and the one after
		expect(child.siblings.map((s) => s.childNo)).toEqual([1, 2, 3]);
	});

	it('refuses a grandchild, a master that becomes a child, its own master and another project', async () => {
		const master = await make('Rules master');
		const child = await make('Rules child', master.ref);
		expect(await code(make('Grandchild', child.ref))).toBe('INVALID');
		const other = await make('Another master');
		// A master with children cannot become a child
		expect(await code(updateItem(owner(), { item: master.ref, parent: other.ref }))).toBe(
			'INVALID'
		);
		expect(await code(updateItem(owner(), { item: other.ref, parent: other.ref }))).toBe('INVALID');
		const foreign = await make('Master in another project', undefined, secondKey);
		expect(await code(make('Across projects', foreign.ref))).toBe('INVALID');
		expect(await code(make('No such master', 'NOPE-20260101-0000'))).toBe('NOT_FOUND');
	});

	it('moves a child to another master with the next number, and out with parent null', async () => {
		const one = await make('Move from');
		const two = await make('Move to');
		await make('Already in two', two.ref);
		const kid = await make('The traveller', one.ref);
		expect(kid.item.childNo).toBe(1);
		const moved = await updateItem(owner(), { item: kid.ref, parent: two.ref });
		expect(moved.changed).toBe(true);
		expect(moved.item.parentId).toBe(two.id);
		expect(moved.item.childNo).toBe(2);
		// The same master again changes nothing
		expect((await updateItem(owner(), { item: kid.ref, parent: two.ref })).changed).toBe(false);
		const out = await updateItem(owner(), { item: kid.ref, parent: null });
		expect(out.item.parentId).toBeNull();
		expect(out.item.childNo).toBeNull();
	});

	it('never reuses a child number, even after a child is trashed', async () => {
		const master = await make('Numbers master');
		await make('N one', master.ref);
		const two = await make('N two', master.ref);
		await trashItem(owner(), two.ref);
		const three = await make('N three', master.ref);
		expect(three.item.childNo).toBe(3);
	});

	it('hides child plans on request and shows them by default, with the family of the page', async () => {
		const master = await make('List master');
		const kid = await make('List child', master.ref);
		const alone = await make('List alone');
		const shown = await listItems(owner(), { project: w.projectKey, family: true, limit: 200 });
		const refs = shown.items.map((i) => i.ref);
		expect(refs).toContain(kid.ref);
		expect(shown.family?.kids[master.id].map((k) => k.ref)).toEqual([kid.ref]);
		expect(shown.family?.parents[kid.id].ref).toBe(master.ref);
		const hidden = await listItems(owner(), {
			project: w.projectKey,
			children: 'hide',
			limit: 200
		});
		const hiddenRefs = hidden.items.map((i) => i.ref);
		expect(hiddenRefs).toContain(master.ref);
		expect(hiddenRefs).toContain(alone.ref);
		expect(hiddenRefs).not.toContain(kid.ref);
		expect(hidden.total).toBe((shown.total ?? 0) - (await countChildren()));
	});

	const countChildren = async () => {
		const all = await listItems(owner(), { project: w.projectKey, limit: 200 });
		return all.items.filter((i) => i.parentId !== null).length;
	};

	it('leaves the children as plans of their own when the master is trashed, and does not re-link on restore', async () => {
		const master = await make('Trash master');
		const a = await make('Trash child a', master.ref);
		const b = await make('Trash child b', master.ref);
		const gone = await trashItem(owner(), master.ref);
		expect(gone).toMatchObject({ trashed: true, releasedChildren: 2 });
		const kid = await getItem(owner(), a.ref);
		expect(kid.item.parentId).toBeNull();
		expect(kid.item.childNo).toBeNull();
		const hidden = await listItems(owner(), {
			project: w.projectKey,
			children: 'hide',
			limit: 200
		});
		expect(hidden.items.map((i) => i.ref)).toEqual(expect.arrayContaining([a.ref, b.ref]));
		await restoreItem(owner(), master.ref);
		expect((await getItem(owner(), b.ref)).item.parentId).toBeNull();
	});

	it('counts a child as "N of M" with M the highest number, so a trashed child never makes it read 3 of 2', async () => {
		const master = await make('Total master');
		await make('T one', master.ref);
		const two = await make('T two', master.ref);
		const three = await make('T three', master.ref);
		await trashItem(owner(), two.ref);
		const page = await getItem(owner(), three.ref);
		expect(page.family.parents[three.id]).toMatchObject({ childNo: 3, childTotal: 3 });
	});

	it('keeps a child on the board as a plan of its own when its master is private to someone else', async () => {
		const secret = await createItem(
			owner(),
			{ project: w.projectKey, title: 'Private master', visibility: 'private' },
			{ now: nextMinute() }
		);
		const kid = await make('Public child of a private master', secret.ref);
		// A member cannot see the master, so the child is not folded away and names no master
		const asMember = await listItems(w.ctx('member'), {
			project: w.projectKey,
			children: 'hide',
			family: true,
			limit: 200
		});
		expect(asMember.items.map((i) => i.ref)).toContain(kid.ref);
		expect(asMember.family?.parents[kid.id]).toBeUndefined();
		expect(JSON.stringify(asMember.family)).not.toContain('Private master');
		// The owner sees the master, so the child is folded into it
		const asOwner = await listItems(owner(), {
			project: w.projectKey,
			children: 'hide',
			family: true,
			limit: 200
		});
		expect(asOwner.items.map((i) => i.ref)).not.toContain(kid.ref);
	});

	it('lists only plans changed since a moment', async () => {
		const fresh = await make('Changed just now');
		const none = await listItems(owner(), {
			project: w.projectKey,
			changedSince: new Date(Date.now() + 60_000),
			limit: 200
		});
		expect(none.items.map((i) => i.ref)).not.toContain(fresh.ref);
		const some = await listItems(owner(), {
			project: w.projectKey,
			changedSince: new Date(Date.now() - 60_000),
			limit: 200
		});
		expect(some.items.map((i) => i.ref)).toContain(fresh.ref);
	});

	it('needs the write role to link a plan, like any change', async () => {
		const master = await make('Role master');
		const kid = await make('Role child');
		expect(await code(updateItem(w.ctx('viewer'), { item: kid.ref, parent: master.ref }))).toBe(
			'FORBIDDEN'
		);
	});
});
