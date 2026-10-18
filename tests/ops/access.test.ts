// WHO MAY TOUCH WHAT: A PRIVATE ITEM IS HIDDEN FROM EVERY VERB THAT NAMES IT (NOT ONLY THE READS), A TOKEN LIMITED TO PROJECTS STAYS
// INSIDE THEM, SEARCH SHOWS ONLY WHAT THE CALLER MAY SEE, AN AGENT CANNOT SWITCH OFF THE RULE THAT KEEPS COMPLETED FOR PEOPLE, AND A
// REUSED REQUEST ID ON ANOTHER REQUEST IS REFUSED. (REVIEW OF THE WHOLE BUILD, PHASE 13.)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { searchBoard } from '../../src/lib/server/ops/board';
import { createTask, updateTask } from '../../src/lib/server/ops/docs';
import { createItem, getItem, trashItem, updateItem } from '../../src/lib/server/ops/items';
import { listProjects, updateProject } from '../../src/lib/server/ops/projects';
import { setStatus } from '../../src/lib/server/ops/status';
import { recordSteps } from '../../src/lib/server/ops/steps';
import {
	listEvents,
	listTrash,
	purgeTrashIfDue,
	undoChange,
	undoSession
} from '../../src/lib/server/ops/history';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

describe('access rules', () => {
	let db: TestDb;
	let w: World;
	let second: string;
	let secondProject: string;
	let secondKey: string;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		// A second member who did not make or hold the private item, and a second project
		second = `${w.people.member}-two`;
		await db.admin.exec(
			`INSERT INTO "user" (id, name, email, email_verified) VALUES ('${second}', 'two', '${second}@example.com', true)`
		);
		await db.admin.exec(
			`INSERT INTO member (org_id, user_id, role) VALUES ('${w.orgId}', '${second}', 'member')`
		);
		secondProject = w.projectId.replace(/11$/, '21');
		secondKey = 'SECOND';
		await db.admin.exec(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${secondProject}', '${w.orgId}', '${secondKey}', 'Second project')`
		);
	}, 120_000);
	afterAll(() => db?.stop());

	const as2 = () => ({
		...w.ctx('member'),
		actor: { userId: second, kind: 'person' as const, label: 'two' }
	});

	it('hides a private item from every verb that names it, for a member who neither made nor holds it', async () => {
		const priv = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Private plan of the first member',
			visibility: 'private',
			...PLAN
		});
		const other = as2();
		await expect(updateItem(other, { item: priv.ref, title: 'Taken over' })).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		await expect(trashItem(other, priv.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			recordSteps(other, { item: priv.ref, marks: [{ key: '1.1', mark: 'done' }] })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			setStatus(other, { item: priv.ref, status: 'IN PROGRESS', note: 'Taking it over' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// Neither can they make it theirs by naming themselves holder
		await expect(updateItem(other, { item: priv.ref, assigneeId: second })).rejects.toMatchObject({
			code: 'NOT_FOUND'
		});
		// Only the maker can; an owner or an admin is as locked out as anyone else
		await expect(
			updateItem(w.ctx('member'), { item: priv.ref, title: 'Renamed by the maker' })
		).resolves.toBeTruthy();
		for (const who of ['admin', 'owner'] as const)
			await expect(
				updateItem(w.ctx(who), { item: priv.ref, title: `Renamed by the ${who}` })
			).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// Trash lists it for the maker only
		await trashItem(w.ctx('member'), priv.ref);
		expect((await listTrash(other, w.projectKey)).items.map((i) => i.id)).not.toContain(priv.id);
		expect((await listTrash(w.ctx('admin'), w.projectKey)).items.map((i) => i.id)).not.toContain(
			priv.id
		);
		expect((await listTrash(w.ctx('owner'), w.projectKey)).items.map((i) => i.id)).not.toContain(
			priv.id
		);
		expect((await listTrash(w.ctx('member'), w.projectKey)).items.map((i) => i.id)).toContain(
			priv.id
		);
	});

	it('undo cannot reach a private item, and a change of who may see an item is undone by its maker only', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Undo me carefully',
			...PLAN
		});
		await updateItem(w.ctx('member'), { item: made.ref, visibility: 'private' });
		const events = await listEvents(w.ctx('member'), { project: w.projectKey, item: made.ref });
		const flip = events.find((e) => e.verb === 'item.update')!;
		// While it is private an admin cannot see the change, so cannot undo it either
		expect(await undoChange(w.ctx('admin'), flip.id)).toMatchObject({
			ok: false,
			reason: 'not-found'
		});
		expect(
			(await listEvents(w.ctx('admin'), { project: w.projectKey })).some(
				(e) => e.itemId === made.id
			)
		).toBe(false);
		// Once it is public again, an admin sees the change but may not reverse who can see the item
		await updateItem(w.ctx('member'), { item: made.ref, visibility: 'public' });
		expect(await undoChange(w.ctx('admin'), flip.id)).toMatchObject({
			ok: false,
			reason: 'unsupported'
		});
	});

	it("an owner who undoes a whole session skips the changes to another maker's private item", async () => {
		const sessionId = 'sess-private-undo';
		const priv = await createItem(
			{ ...w.ctx('member'), actor: { ...w.ctx('member').actor, sessionId } },
			{
				project: w.projectKey,
				title: 'Private and touched by a session',
				visibility: 'private',
				...PLAN
			}
		);
		const result = await undoSession(w.ctx('owner'), sessionId);
		expect(result.undone).toEqual([]);
		expect(result.skipped.length).toBeGreaterThan(0);
		expect(result.skipped.every((s) => s.reason === 'not-found')).toBe(true);
		expect((await getItem(w.ctx('member'), priv.ref)).item.deletedAt).toBeNull();
	});

	it('search shows what the caller may see, and not the sections of a trashed item', async () => {
		const priv = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Zebrafish secret plan',
			visibility: 'private'
		});
		const pub = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Zebrafish public plan'
		});
		const mine = (await searchBoard(w.ctx('member'), 'zebrafish')).map((h) => h.title).join('|');
		expect(mine).toContain('secret plan');
		const theirs = (await searchBoard(as2(), 'zebrafish')).map((h) => h.title).join('|');
		expect(theirs).toContain('public plan');
		expect(theirs).not.toContain('secret plan');
		const viewer = (await searchBoard(w.ctx('viewer'), 'zebrafish')).map((h) => h.title).join('|');
		expect(viewer).not.toContain('secret plan');
		// Not even an owner or an admin finds a title that is not theirs
		for (const who of ['admin', 'owner'] as const) {
			const found = (await searchBoard(w.ctx(who), 'zebrafish')).map((h) => h.title).join('|');
			expect(found).toContain('public plan');
			expect(found).not.toContain('secret plan');
		}
		await trashItem(w.ctx('member'), pub.ref);
		const afterTrash = (await searchBoard(w.ctx('member'), 'zebrafish'))
			.map((h) => h.title)
			.join('|');
		expect(afterTrash).not.toContain('public plan');
		void priv;
	});

	it('a token limited to a project cannot reach another project, by name or by item', async () => {
		const inFirst = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'In the first'
		});
		const inSecond = await createItem(w.ctx('member'), {
			project: secondKey,
			title: 'In the second'
		});
		const limited = {
			...w.ctx('member'),
			actor: {
				userId: w.people.member,
				kind: 'agent' as const,
				tokenId: '00000000-0000-4000-8000-0000000000a1',
				tokenCaps: ['read', 'comment', 'write', 'complete', 'delete'] as never,
				tokenProjects: [w.projectId]
			}
		};
		await expect(
			updateItem(limited, { item: inFirst.ref, title: 'Allowed' })
		).resolves.toBeTruthy();
		await expect(
			updateItem(limited, { item: inSecond.ref, title: 'Not allowed' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			createItem(limited, { project: secondKey, title: 'Planted' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// A token with no limit reaches both
		await expect(
			updateItem(
				{ ...limited, actor: { ...limited.actor, tokenProjects: [] } },
				{
					item: inSecond.ref,
					title: 'Allowed again'
				}
			)
		).resolves.toBeTruthy();
		void listProjects;
	});

	it('an agent cannot switch off the rule that keeps COMPLETED for people, a person can', async () => {
		const agent = {
			...w.ctx('admin'),
			actor: {
				userId: w.people.admin,
				kind: 'agent' as const,
				tokenId: '00000000-0000-4000-8000-0000000000a2'
			}
		};
		await expect(
			updateProject(agent, { project: w.projectKey, agentsMayComplete: true })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			updateProject(w.ctx('admin'), { project: w.projectKey, agentsMayComplete: false })
		).resolves.toBeTruthy();
	});

	it('a request id used again for another request is refused, and for the same one returns the first answer', async () => {
		const fp = (s: string) => ({
			...w.ctx('member', { requestId: 'req-fingerprint-1' }),
			fingerprint: s
		});
		const first = await createItem(fp('create:a'), {
			project: w.projectKey,
			title: 'Fingerprinted'
		});
		const again = await createItem(fp('create:a'), {
			project: w.projectKey,
			title: 'Fingerprinted'
		});
		expect(again.id).toBe(first.id);
		await expect(
			createItem(fp('create:b'), { project: w.projectKey, title: 'Something else' })
		).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	it('an assignee has to belong to the organisation', async () => {
		await expect(
			createItem(w.ctx('member'), {
				project: w.projectKey,
				title: 'Held by a stranger',
				assigneeId: w.other.userId
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			createTask(w.ctx('member'), {
				project: w.projectKey,
				title: 'Task',
				assigneeId: w.other.userId
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		const t = await createTask(w.ctx('member'), {
			project: w.projectKey,
			title: 'Task for two',
			assigneeId: second
		});
		await expect(
			updateTask(w.ctx('member'), { task: t.task.id, assigneeId: w.other.userId })
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('the first person into the org each day clears out what has been in the trash over 30 days, once', async () => {
		const old = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Trashed long ago'
		});
		const young = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Trashed just now'
		});
		await trashItem(w.ctx('member'), old.ref);
		await trashItem(w.ctx('member'), young.ref);
		await db.admin.exec(
			`update item set deleted_at = now() - interval '40 days' where id = '${old.id}'`
		);
		const first = await purgeTrashIfDue(w.ctx('member'));
		expect(first).toMatchObject({ items: 1 });
		// The same day nothing runs again, and the young item is still there
		expect(await purgeTrashIfDue(w.ctx('member'))).toBeNull();
		const left = (await listTrash(w.ctx('admin'), w.projectKey)).items.map((i) => i.id);
		expect(left).toContain(young.id);
		expect(left).not.toContain(old.id);
	});
});
