// NOTE EVENTS, THE STREAM FILTER, THE TRASH LIST AND THE PURGE (AFB-20261111-0035, step 2.3)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { mayReceive } from '../../src/lib/server/ops/board';
import { listEvents, listTrash, purgeTrash } from '../../src/lib/server/ops/history';
import { createItem } from '../../src/lib/server/ops/items';
import { orgAuditLog } from '../../src/lib/server/ops/settings';
import { createFolder, trashFolder } from '../../src/lib/server/ops/noteFolders';
import { createNote, trashNote, updateNote } from '../../src/lib/server/ops/notes';
import { getHub } from '../../src/lib/server/realtime/hub';
import type { Change } from '../../src/lib/server/realtime/notify';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('note events, trash and purge', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;
	type Who = keyof World['people'];
	const verbsSeenBy = async (who: Who, afterId?: number) =>
		(await listEvents(w.ctx(who), { project: P(), afterId, limit: 200 }))
			.filter((e) => e.targetType.startsWith('note'))
			.map((e) => e.verb);
	const asGuestOnProject = () =>
		db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.guest}', 'guest') ON CONFLICT DO NOTHING`
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await asGuestOnProject();
	}, 180_000);
	afterAll(async () => {
		await (await getHub(db)).close();
		await db?.stop();
	});

	it('a change notice of a note names the note, and only people who may see it receive it', async () => {
		const hub = await getHub(db);
		const seen: Change[] = [];
		const stop = hub.subscribe(w.projectId, (c) => c && seen.push(c));
		const shared = await createNote(w.ctx('member'), { project: P(), title: 'Shared' });
		const priv = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Mine',
			visibility: 'private'
		});
		await createFolder(w.ctx('member'), { project: P(), name: 'Research' });
		await wait(400);
		stop();
		expect(seen.filter((c) => c.v === 'note.create').map((c) => c.n)).toEqual([shared.id, priv.id]);
		// Shared: everyone on the project but the guest
		for (const who of ['owner', 'admin', 'member', 'viewer'] as const)
			expect(await mayReceive(w.ctx(who), w.projectId, null, shared.id), who).toBe(true);
		expect(await mayReceive(w.ctx('guest'), w.projectId, null, shared.id)).toBe(false);
		// Private: the creator alone
		expect(await mayReceive(w.ctx('member'), w.projectId, null, priv.id)).toBe(true);
		for (const who of ['owner', 'admin', 'viewer', 'guest'] as const)
			expect(await mayReceive(w.ctx(who), w.projectId, null, priv.id), who).toBe(false);
		// A folder change is for the Notes area: not for a guest
		expect(await mayReceive(w.ctx('viewer'), w.projectId, null, 'area')).toBe(true);
		expect(await mayReceive(w.ctx('guest'), w.projectId, null, 'area')).toBe(false);
		// The guest still receives the changes of plans, as before
		expect(await mayReceive(w.ctx('guest'), w.projectId)).toBe(true);
	});

	it('a note id nobody can find is refused, never let through', async () => {
		const ghost = '00000000-0000-4000-c000-000000000001';
		for (const who of ['owner', 'member'] as const) {
			expect(await mayReceive(w.ctx(who), w.projectId, null, ghost), who).toBe(false);
			expect(await mayReceive(w.ctx(who), w.projectId, null, 'not-an-id'), who).toBe(false);
		}
		// A note of another project of another organisation is no more visible
		const [foreign] = await db.admin.query<{ id: string }>(
			`INSERT INTO note (org_id, project_id, number, title) VALUES ('${w.other.orgId}', '${w.other.projectId}', 1, 'Theirs') RETURNING id`
		);
		expect(await mayReceive(w.ctx('owner'), w.projectId, null, foreign.id)).toBe(false);
	});

	it('Activity and the replay of a stream hide a private note from everyone but its creator, and every note from a guest', async () => {
		const mine = await verbsSeenBy('member');
		expect(mine.filter((v) => v === 'note.create')).toHaveLength(2);
		expect(mine).toContain('note_folder.create');
		for (const who of ['owner', 'admin', 'viewer'] as const) {
			const theirs = await verbsSeenBy(who);
			expect(
				theirs.filter((v) => v === 'note.create'),
				who
			).toHaveLength(1);
			expect(theirs, who).toContain('note_folder.create');
		}
		expect(await verbsSeenBy('guest')).toEqual([]);
		// The replay asks for what came after an id: the same filter applies
		const [{ id: before }] = await db.admin.query<{ id: number }>(
			`select coalesce(max(id), 0)::int as id from event where project_id = '${w.projectId}'`
		);
		const secret = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Second secret',
			visibility: 'private'
		});
		await updateNote(w.ctx('member'), { project: P(), note: secret.ref, title: 'Renamed secret' });
		expect(await verbsSeenBy('member', before)).toEqual(['note.update', 'note.create']);
		expect(await verbsSeenBy('admin', before)).toEqual([]);
		expect(await verbsSeenBy('guest', before)).toEqual([]);
		// A guest still sees the events of plans
		await createItem(w.ctx('member'), {
			project: P(),
			title: 'A public plan',
			stream: 'features',
			scope: 'core',
			...PLAN
		});
		const guestFeed = await listEvents(w.ctx('guest'), { project: P(), limit: 50 });
		expect(guestFeed.length).toBeGreaterThan(0);
		expect(guestFeed.every((e) => !e.targetType.startsWith('note'))).toBe(true);
	});

	it('the organisation audit log hides the events of a private note from an admin, and keeps shared ones', async () => {
		const titles = (log: Awaited<ReturnType<typeof orgAuditLog>>) =>
			JSON.stringify(log.events.filter((e) => e.targetType === 'note'));
		const shared = await createNote(w.ctx('member'), { project: P(), title: 'Audit shared' });
		const priv = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Audit private title',
			visibility: 'private'
		});
		await updateNote(w.ctx('member'), {
			project: P(),
			note: priv.ref,
			title: 'Audit renamed secret'
		});
		// The admin sees the shared note and not one word of the private one
		const asAdmin = await orgAuditLog(w.ctx('owner'), { limit: 200 });
		expect(titles(asAdmin)).toContain('Audit shared');
		expect(titles(asAdmin)).not.toMatch(/Audit private title|Audit renamed secret/);
		expect(asAdmin.events.some((e) => e.targetId === priv.id)).toBe(false);
		expect(asAdmin.events.some((e) => e.targetId === shared.id)).toBe(true);
		// An admin who wrote a private note sees its events in the log
		const adminsOwn = await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Admin own secret',
			visibility: 'private'
		});
		const own = await orgAuditLog(w.ctx('admin'), { limit: 200 });
		expect(own.events.some((e) => e.targetId === adminsOwn.id)).toBe(true);
		const other = await orgAuditLog(w.ctx('owner'), { limit: 200 });
		expect(other.events.some((e) => e.targetId === adminsOwn.id)).toBe(false);
	});

	it('the trash lists notes and folders for the people notes are shared with, and a private note only for its creator', async () => {
		const open = await createNote(w.ctx('member'), { project: P(), title: 'Binned' });
		const priv = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Binned secret',
			visibility: 'private'
		});
		await trashNote(w.ctx('member'), { project: P(), note: open.ref });
		await trashNote(w.ctx('member'), { project: P(), note: priv.ref });
		await trashFolder(w.ctx('member'), { project: P(), folder: 'Research' });
		const mine = await listTrash(w.ctx('member'), P());
		expect(mine.notes.map((n) => n.title).sort()).toEqual(['Binned', 'Binned secret']);
		expect(mine.noteFolders.map((f) => f.name)).toEqual(['Research']);
		expect(mine.notes[0].daysLeft).toBe(30);
		const admins = await listTrash(w.ctx('admin'), P());
		expect(admins.notes.map((n) => n.title)).toEqual(['Binned']);
	});

	it('after 30 days a folder goes with every folder and note under it, their pictures and their history, and nothing returns to the top', async () => {
		const storage = memoryStorage('note-purge-secret-0123456789');
		const top = await createFolder(w.ctx('member'), { project: P(), name: 'Old top' });
		const sub = await createFolder(w.ctx('member'), {
			project: P(),
			name: 'Old sub',
			parentId: top.id
		});
		const nested = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Nested',
			body: 'v1',
			folderId: sub.id
		});
		const nestedSecret = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Nested secret',
			folderId: sub.id,
			visibility: 'private'
		});
		await updateNote(w.ctx('member'), { project: P(), note: nested.ref, body: 'v2' }, 'agent');
		const keeper = await createNote(w.ctx('member'), { project: P(), title: 'Keeper' });
		// A picture of the nested note, and links from the keeper to the nested note and to a plan that will be purged
		await storage.put('notes/x/pic.png', new Uint8Array([1, 2, 3]), 'image/png');
		await db.admin.exec(
			`INSERT INTO note_file (org_id, project_id, note_id, storage_key, mime, size, checksum) VALUES ('${w.orgId}', '${w.projectId}', '${nested.id}', 'notes/x/pic.png', 'image/png', 3, 'c')`
		);
		const plan = await createItem(w.ctx('member'), {
			project: P(),
			title: 'A plan to purge',
			stream: 'features',
			scope: 'core',
			...PLAN
		});
		const stays = await createItem(w.ctx('member'), {
			project: P(),
			title: 'A plan that stays',
			stream: 'features',
			scope: 'core',
			...PLAN
		});
		await db.admin.exec(
			`INSERT INTO note_link (org_id, project_id, note_id, target_kind, target_id, source) VALUES
			('${w.orgId}', '${w.projectId}', '${keeper.id}', 'note', '${nested.id}', 'panel'),
			('${w.orgId}', '${w.projectId}', '${keeper.id}', 'item', '${plan.id}', 'panel'),
			('${w.orgId}', '${w.projectId}', '${keeper.id}', 'item', '${stays.id}', 'panel')`
		);
		await trashFolder(w.ctx('member'), { project: P(), folder: top.id });
		// Only the top folder is old enough; a folder trashed today stays
		const young = await createFolder(w.ctx('member'), { project: P(), name: 'Young' });
		await trashFolder(w.ctx('member'), { project: P(), folder: young.id });
		await db.admin.exec(
			`UPDATE note_folder SET deleted_at = now() - interval '31 days' WHERE id = '${top.id}'`
		);
		await db.admin.exec(
			`UPDATE item SET deleted_at = now() - interval '31 days' WHERE id = '${plan.id}'`
		);
		const res = await purgeTrash({ ...w.ctx('admin'), services: { storage } });
		expect(res.items).toBe(1);
		const count = async (sql: string) =>
			(await db.admin.query<{ n: number }>(`select count(*)::int as n from ${sql}`))[0].n;
		expect(await count(`note_folder where id in ('${top.id}', '${sub.id}')`)).toBe(0);
		expect(await count(`note where id in ('${nested.id}', '${nestedSecret.id}')`)).toBe(0);
		expect(await count(`note_version where note_id = '${nested.id}'`)).toBe(0);
		expect(await count(`note_file where note_id = '${nested.id}'`)).toBe(0);
		expect(await storage.get('notes/x/pic.png')).toBe(null);
		// Nothing of the folder came back at the top level
		expect(await count(`note where title like 'Nested%'`)).toBe(0);
		// The young folder and the keeper are untouched, and only the link to the plan that stays is left
		expect(await count(`note_folder where id = '${young.id}'`)).toBe(1);
		expect(await count(`note where id = '${keeper.id}'`)).toBe(1);
		const links = await db.admin.query<{ target_id: string }>(
			`select target_id from note_link where note_id = '${keeper.id}'`
		);
		expect(links.map((l) => l.target_id)).toEqual([stays.id]);
		// The notes trashed on their own in the test above are younger than 30 days and stay
		expect(await count(`note where title = 'Binned'`)).toBe(1);
	});
});
