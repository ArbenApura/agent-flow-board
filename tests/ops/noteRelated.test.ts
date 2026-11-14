// NOTES IN related_plans AND IN THE CLAIM REPLY: THE CALLER'S ROLE ON EACH PROJECT, PRIVATE NOTES, AND A LOOKUP THAT NEVER FAILS THE CALL (AFB-20261111-0035, step 6.2)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { createItem } from '../../src/lib/server/ops/items';
import { createFolder } from '../../src/lib/server/ops/noteFolders';
import { createNote, linkNote } from '../../src/lib/server/ops/notes';
import { claimNotes, relatedPlans } from '../../src/lib/server/ops/related';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('notes in related plans and in the claim reply', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;
	const SECOND = 'SECOND';
	type Who = keyof World['people'];
	const Q = 'pelican nesting colony';
	/** The references (with the project) of the close notes this person gets. */
	const close = async (who: Who, project?: string) =>
		(await relatedPlans(w.ctx(who), { q: Q, project })).notes
			.map((n) => `${n.project}:${n.ref}`)
			.sort();

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const second = w.projectId.replace(/11$/, '21');
		await db.admin.exec(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${second}', '${w.orgId}', '${SECOND}', 'Second project')`
		);
		const body = (extra: string) => `${Q} ${extra}`;
		const m = w.ctx('member');
		const folder = await createFolder(m, { project: P(), name: 'Birds' });
		// P: N-1 shared in a folder, N-2 private of the member, N-3 private of the admin, N-4 matching one word only
		await createNote(m, {
			project: P(),
			title: 'Pelican survey',
			body: body('method and counts'),
			folderId: folder.id
		});
		await createNote(m, {
			project: P(),
			title: 'Pelican mine',
			body: body('private'),
			visibility: 'private'
		});
		await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Pelican theirs',
			body: body('private'),
			visibility: 'private'
		});
		await createNote(m, { project: P(), title: 'Pelican only', body: 'just a pelican' });
		// SECOND: N-1 shared
		await createNote(m, { project: SECOND, title: 'Pelican second', body: body('elsewhere') });
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('lists close notes with reference, title, folder, snippet and the untrusted mark; one matching word is not enough', async () => {
		const r = await relatedPlans(w.ctx('member'), { q: Q, project: P() });
		const survey = r.notes.find((n) => n.ref === 'N-1')!;
		expect(survey).toMatchObject({
			project: P(),
			title: 'Pelican survey',
			folder: 'Birds',
			untrusted: true
		});
		expect(survey.snippet).toContain('pelican nesting colony');
		expect(r.notes.map((n) => n.ref)).not.toContain('N-4');
		expect(r.data).toEqual([]);
		expect(r.notesUnavailable).toBeUndefined();
	});

	it('looks at every project the caller can read when none is named, and only at shared notes and their own', async () => {
		expect(await close('member')).toEqual([`${P()}:N-1`, `${P()}:N-2`, `${SECOND}:N-1`].sort());
		expect(await close('admin')).toEqual([`${P()}:N-1`, `${P()}:N-3`, `${SECOND}:N-1`].sort());
		expect(await close('owner')).toEqual([`${P()}:N-1`, `${SECOND}:N-1`].sort());
		expect(await close('member', SECOND)).toEqual([`${SECOND}:N-1`]);
	});

	it('leaves out every project where the caller is a guest, whatever their organisation role', async () => {
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId.replace(/11$/, '21')}', '${w.people.viewer}', 'guest')`
		);
		try {
			expect(await close('viewer')).toEqual([`${P()}:N-1`]);
			expect(await close('viewer', SECOND)).toEqual([]);
			// The same person is unchanged elsewhere
			expect(await close('member', SECOND)).toEqual([`${SECOND}:N-1`]);
		} finally {
			await db.admin.exec(
				`DELETE FROM project_member WHERE project_id = '${w.projectId.replace(/11$/, '21')}'`
			);
		}
	});

	it('shows at most five close notes', async () => {
		for (let i = 0; i < 7; i++)
			await createNote(w.ctx('member'), {
				project: P(),
				title: `Heron ${i}`,
				body: 'heron wading marsh habitat'
			});
		const r = await relatedPlans(w.ctx('member'), { q: 'heron wading marsh', project: P() });
		expect(r.notes).toHaveLength(5);
	});

	it('a failed note lookup does not fail the plans: the savepoint keeps the call alive', async () => {
		const plan = await createItem(w.ctx('member'), {
			project: P(),
			title: 'Pelican colony counting plan',
			...PLAN
		});
		await db.admin.exec('ALTER TABLE note_folder RENAME TO note_folder_away');
		try {
			const r = await relatedPlans(w.ctx('member'), { q: Q, project: P() });
			expect(r.notesUnavailable).toBe(true);
			expect(r.notes).toEqual([]);
			expect(r.data.map((p) => p.ref)).toContain(plan.ref);
		} finally {
			await db.admin.exec('ALTER TABLE note_folder_away RENAME TO note_folder');
		}
		expect(
			(await relatedPlans(w.ctx('member'), { q: Q, project: P() })).notes.length
		).toBeGreaterThan(0);
	});

	it('the claim reply lists the notes linked to the plan, by what the claimer may see', async () => {
		const plan = await createItem(w.ctx('member'), {
			project: P(),
			title: 'Plan with notes',
			...PLAN
		});
		const link = (who: Who, note: string) =>
			linkNote(w.ctx(who), { project: P(), note, targetKind: 'item', target: plan.ref });
		expect(await claimNotes(w.ctx('member'), plan.ref)).toEqual({});
		await link('member', 'N-1');
		await link('member', 'N-2');
		await link('admin', 'N-3');
		const names = async (who: Who) => {
			const r = await claimNotes(w.ctx(who), plan.ref);
			return 'notes' in r ? r.notes.map((n) => n.ref).sort() : [];
		};
		expect(await names('member')).toEqual(['N-1', 'N-2']);
		expect(await names('admin')).toEqual(['N-1', 'N-3']);
		expect(await names('owner')).toEqual(['N-1']);
		const mine = await claimNotes(w.ctx('member'), plan.ref);
		expect('notes' in mine && mine.notes.find((n) => n.ref === 'N-1')).toMatchObject({
			project: P(),
			title: 'Pelican survey',
			folder: 'Birds',
			untrusted: true
		});
		// A guest on the plan's project is told of no notes at all
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.viewer}', 'guest')`
		);
		try {
			expect(await claimNotes(w.ctx('viewer'), plan.ref)).toEqual({});
		} finally {
			await db.admin.exec(`DELETE FROM project_member WHERE project_id = '${w.projectId}'`);
		}
		// Only five are listed, the rest counted
		for (let i = 5; i < 12; i++) await link('member', `N-${i}`);
		const many = await claimNotes(w.ctx('owner'), plan.ref);
		expect('notes' in many && many.notes).toHaveLength(5);
		expect('moreNotes' in many && many.moreNotes).toBeGreaterThan(0);
	});

	it('a failed lookup in the claim reply is told, not thrown', async () => {
		const plan = await createItem(w.ctx('member'), {
			project: P(),
			title: 'Plan lookup fails',
			...PLAN
		});
		await linkNote(w.ctx('member'), {
			project: P(),
			note: 'N-1',
			targetKind: 'item',
			target: plan.ref
		});
		await db.admin.exec('ALTER TABLE note_link RENAME TO note_link_away');
		try {
			expect(await claimNotes(w.ctx('member'), plan.ref)).toEqual({ notesUnavailable: true });
		} finally {
			await db.admin.exec('ALTER TABLE note_link_away RENAME TO note_link');
		}
	});
});
