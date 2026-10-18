// PINNED PROJECTS (AFB-20261017-0537): PERSONAL, NEVER LEAKING, CLEARED WITH THE PERSON

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { orgOverview } from '../../src/lib/server/ops/board';
import { createItem } from '../../src/lib/server/ops/items';
import { pinProject, unpinProject } from '../../src/lib/server/ops/pins';
import { removeMember, setProjectRole } from '../../src/lib/server/orgs/orgs';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

const pinnedOf = async (w: World, who: keyof World['people']) =>
	(await orgOverview(w.ctx(who))).find((o) => o.project.id === w.projectId)?.pinned;

describe('pinned projects', () => {
	const make = makePostgres;
	let db: TestDb;
	let w: World;
	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
	});
	afterAll(async () => {
		await db?.stop();
	});

	it('pins and unpins for the caller only, and pinning twice changes nothing', async () => {
		expect(await pinnedOf(w, 'member')).toBe(false);
		await pinProject(w.ctx('member'), w.projectKey);
		await pinProject(w.ctx('member'), w.projectKey);
		expect(await pinnedOf(w, 'member')).toBe(true);
		// Nobody else sees it
		expect(await pinnedOf(w, 'owner')).toBe(false);
		expect(await pinnedOf(w, 'viewer')).toBe(false);
		await unpinProject(w.ctx('member'), w.projectId);
		expect(await pinnedOf(w, 'member')).toBe(false);
		// Clearing a pin that is not there is not an error
		await unpinProject(w.ctx('member'), w.projectId);
	});

	it('refuses to pin a project the caller cannot see, and says the same as for a missing one', async () => {
		await expect(pinProject(w.ctx('guest'), w.projectKey)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		await expect(pinProject(w.ctx('member'), 'NOPE')).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// Another org's project cannot be pinned by name or id
		await expect(pinProject(w.ctx('member'), w.other.projectId)).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
	});

	it('keeps working for a person who lost access while pinned', async () => {
		await setProjectRole(db, w.orgId, w.people.owner, w.projectId, w.people.guest, 'viewer');
		await pinProject(w.ctx('guest'), w.projectKey);
		expect(await pinnedOf(w, 'guest')).toBe(true);
		await setProjectRole(db, w.orgId, w.people.owner, w.projectId, w.people.guest, null);
		// The project is gone from their overview, and the stale pin is not returned
		expect((await orgOverview(w.ctx('guest'))).find((o) => o.project.id === w.projectId)).toBe(
			undefined
		);
		// They can still clear it, and the same call is fine when there is nothing to clear
		await unpinProject(w.ctx('guest'), w.projectId);
		await unpinProject(w.ctx('guest'), w.projectId);
		// Access comes back: the cleared pin does not
		await setProjectRole(db, w.orgId, w.people.owner, w.projectId, w.people.guest, 'viewer');
		expect(await pinnedOf(w, 'guest')).toBe(false);
	});

	it('removes a person pins with them, so adding them again does not bring them back', async () => {
		await pinProject(w.ctx('viewer'), w.projectKey);
		expect(await pinnedOf(w, 'viewer')).toBe(true);
		await removeMember(db, w.orgId, w.people.owner, w.people.viewer);
		const rows = await db.admin.query<{ n: number }>(
			`select count(*)::int as n from project_pin where user_id = '${w.people.viewer}'`
		);
		expect(rows[0].n).toBe(0);
	});

	it('moves lastActivityAt only for items the caller may see', async () => {
		const before = (await orgOverview(w.ctx('member'))).find((o) => o.project.id === w.projectId)!;
		expect(before.lastActivityAt).toBeNull();
		await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Public activity',
			stream: 'features',
			scope: 'core'
		});
		const afterPublic = (await orgOverview(w.ctx('member'))).find(
			(o) => o.project.id === w.projectId
		)!;
		expect(afterPublic.lastActivityAt).toBeInstanceOf(Date);
		// A newer private item of the owner changes nothing for a member who cannot see it
		await new Promise((r) => setTimeout(r, 25));
		await createItem(w.ctx('owner'), {
			project: w.projectKey,
			title: 'Private activity',
			visibility: 'private',
			stream: 'fixes',
			scope: 'routine'
		});
		const afterPrivate = (await orgOverview(w.ctx('member'))).find(
			(o) => o.project.id === w.projectId
		)!;
		expect(afterPrivate.lastActivityAt?.getTime()).toBe(afterPublic.lastActivityAt?.getTime());
		const owner = (await orgOverview(w.ctx('owner'))).find((o) => o.project.id === w.projectId)!;
		expect(owner.lastActivityAt!.getTime()).toBeGreaterThan(afterPublic.lastActivityAt!.getTime());
		expect(afterPrivate.createdAt).toBeInstanceOf(Date);
	});
});
