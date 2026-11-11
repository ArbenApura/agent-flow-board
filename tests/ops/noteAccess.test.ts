// WHO MAY SEE A NOTE: THE CREATOR OF A PRIVATE NOTE ONLY, NEVER A GUEST, NEVER UNDER A TRASHED FOLDER (AFB-20261111-0035, step 1.4)

// -- DEP-MODULES -- //
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { note } from '../../src/lib/server/db/schema';
import { OpError, run } from '../../src/lib/server/ops/context';
import {
	canSeeNote,
	noteRoleOf,
	requireNoteVisible,
	visibleNoteSql
} from '../../src/lib/server/ops/resolve';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

const fid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;

describe('note visibility', () => {
	let db: TestDb;
	let w: World;
	type Who = keyof World['people'];

	/** The titles of the notes this person's list would show. */
	const seen = (who: Who) =>
		run(
			w.ctx(who),
			async (tx) => {
				const role = await noteRoleOf(tx, w.ctx(who), w.projectId);
				if (!role) return [];
				const rows = await tx
					.select({ title: note.title })
					.from(note)
					.where(and(eq(note.projectId, w.projectId), visibleNoteSql(w.people[who])));
				return rows.map((r) => r.title).sort();
			},
			w.projectId
		);
	/** Whether this person may open the note with this title. */
	const mayOpen = (who: Who, title: string) =>
		run(
			w.ctx(who),
			async (tx) => {
				const [row] = await tx.select().from(note).where(eq(note.title, title));
				try {
					await requireNoteVisible(tx, w.ctx(who), row);
					return true;
				} catch (e) {
					if (e instanceof OpError && e.code === 'NOT_FOUND') return false;
					throw e;
				}
			},
			w.projectId
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const a = db.admin;
		const base = `'${w.orgId}', '${w.projectId}'`;
		// Top > Mid > Deep, and a folder apart
		await a.exec(
			`INSERT INTO note_folder (id, org_id, project_id, parent_id, name) VALUES ('${fid(1)}', ${base}, null, 'Top'), ('${fid(2)}', ${base}, '${fid(1)}', 'Mid'), ('${fid(3)}', ${base}, '${fid(2)}', 'Deep'), ('${fid(4)}', ${base}, null, 'Apart')`
		);
		await a.exec(
			`INSERT INTO note (org_id, project_id, number, title, visibility, created_by, folder_id) VALUES
			(${base}, 1, 'Shared', 'public', '${w.people.member}', null),
			(${base}, 2, 'Private of member', 'private', '${w.people.member}', null),
			(${base}, 3, 'Private of nobody', 'private', null, null),
			(${base}, 4, 'Deep note', 'public', '${w.people.member}', '${fid(3)}'),
			(${base}, 5, 'Apart note', 'public', '${w.people.member}', '${fid(4)}')`
		);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('the rule itself: shared for everyone but a guest, private for the creator alone', () => {
		const shared = { visibility: 'public' as const, createdBy: 'a' };
		const priv = { visibility: 'private' as const, createdBy: 'a' };
		for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
			expect(canSeeNote(role, shared, 'b'), role).toBe(true);
			expect(canSeeNote(role, priv, 'b'), role).toBe(false);
			expect(canSeeNote(role, priv, 'a'), role).toBe(true);
		}
		expect(canSeeNote('guest', shared, 'a')).toBe(false);
		expect(canSeeNote(null, shared, 'a')).toBe(false);
		// A private note with no creator stays hidden from everyone
		expect(canSeeNote('owner', { visibility: 'private', createdBy: null }, 'a')).toBe(false);
	});

	it('the creator sees their private note; an owner, an admin, a member and a viewer see only the shared ones', async () => {
		const shared = ['Apart note', 'Deep note', 'Shared'];
		expect(await seen('member')).toEqual([...shared, 'Private of member'].sort());
		for (const who of ['owner', 'admin', 'viewer'] as const) {
			expect(await seen(who), who).toEqual(shared);
			expect(await mayOpen(who, 'Private of member'), who).toBe(false);
			expect(await mayOpen(who, 'Private of nobody'), who).toBe(false);
			expect(await mayOpen(who, 'Shared'), who).toBe(true);
		}
		expect(await mayOpen('member', 'Private of member')).toBe(true);
	});

	it('a guest sees no note: by the organisation role, and with a guest role given on the project', async () => {
		expect(await seen('guest')).toEqual([]);
		expect(await mayOpen('guest', 'Shared')).toBe(false);
		// A guest who was given this project, still as a guest
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.guest}', 'guest')`
		);
		expect(await seen('guest')).toEqual([]);
		expect(await mayOpen('guest', 'Shared')).toBe(false);
		// A member turned into a guest on this one project loses the notes too
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.viewer}', 'guest')`
		);
		expect(await seen('viewer')).toEqual([]);
		expect(await mayOpen('viewer', 'Shared')).toBe(false);
		await db.admin.exec(`DELETE FROM project_member WHERE project_id = '${w.projectId}'`);
	});

	it('a token limited to another project sees no note here', async () => {
		const limited = w.ctx('member', { tokenProjects: [w.other.projectId] });
		const role = await run(limited, (tx) => noteRoleOf(tx, limited, w.projectId), w.projectId);
		expect(role).toBe(null);
	});

	it('a folder in the trash hides the notes three levels under it, and a restore brings them back', async () => {
		await db.admin.exec(`UPDATE note_folder SET deleted_at = now() WHERE id = '${fid(1)}'`);
		expect(await seen('member')).toEqual(['Apart note', 'Private of member', 'Shared']);
		expect(await mayOpen('member', 'Deep note')).toBe(false);
		expect(await mayOpen('member', 'Apart note')).toBe(true);
		await db.admin.exec(`UPDATE note_folder SET deleted_at = null WHERE id = '${fid(1)}'`);
		expect(await seen('member')).toContain('Deep note');
		expect(await mayOpen('member', 'Deep note')).toBe(true);
	});

	it('a loop made by hand in the folder table still answers', async () => {
		// Top > Mid > Deep > Top, with Mid in the trash: the walk meets itself and must stop
		await db.admin.exec(`UPDATE note_folder SET parent_id = '${fid(3)}' WHERE id = '${fid(1)}'`);
		await db.admin.exec(`UPDATE note_folder SET deleted_at = now() WHERE id = '${fid(2)}'`);
		expect(await seen('member')).toEqual(['Apart note', 'Private of member', 'Shared']);
		expect(await mayOpen('member', 'Deep note')).toBe(false);
		await db.admin.exec(`UPDATE note_folder SET parent_id = null WHERE id = '${fid(1)}'`);
		await db.admin.exec(`UPDATE note_folder SET deleted_at = null WHERE id = '${fid(2)}'`);
	});

	it('a note in the trash is in the trash list only', async () => {
		await db.admin.exec(`UPDATE note SET deleted_at = now() WHERE title = 'Apart note'`);
		expect(await seen('member')).not.toContain('Apart note');
		expect(await mayOpen('member', 'Shared')).toBe(true);
		const trash = await run(
			w.ctx('admin'),
			(tx) =>
				tx
					.select({ title: note.title })
					.from(note)
					.where(visibleNoteSql(w.people.admin, { trash: 'only' })),
			w.projectId
		);
		expect(trash.map((t) => t.title)).toEqual(['Apart note']);
	});
});
