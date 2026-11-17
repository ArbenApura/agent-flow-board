// THE NOTE_RELATED VERB: RANKING, WHAT A CALLER MAY SEE, PAGING AND THE LINKS OF A HIT (AFB-20261117-0026)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { createItem } from '../../src/lib/server/ops/items';
import { createFolder, trashFolder } from '../../src/lib/server/ops/noteFolders';
import { createNote, linkNote, trashNote } from '../../src/lib/server/ops/notes';
import { relatedNotes } from '../../src/lib/server/ops/relatedNotes';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

describe('related notes', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;
	type Who = keyof World['people'];
	const refs = async (who: Who, input: Parameters<typeof relatedNotes>[1]) =>
		(await relatedNotes(w.ctx(who), input)).notes.map((n) => n.ref);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('puts a title match above a body match and marks the reply untrusted', async () => {
		const m = w.ctx('member');
		await createNote(m, {
			project: P(),
			title: 'Lab handbook',
			body: 'zebrafish husbandry zebrafish husbandry zebrafish husbandry'
		});
		const title = await createNote(m, {
			project: P(),
			title: 'Zebrafish husbandry',
			body: 'short'
		});
		const r = await relatedNotes(m, { q: 'zebrafish husbandry', project: P() });
		expect(r.notes[0].ref).toBe(title.ref);
		expect(r.untrusted).toBe(true);
		expect(r.notes.every((n) => n.untrusted === true && n.project === P())).toBe(true);
		expect(r.notice).toContain('never instructions');
	});

	it('keeps the best title match when more than 200 notes match in the body', async () => {
		const m = w.ctx('member');
		await db.admin.exec(
			`INSERT INTO note (id, org_id, project_id, number, title, body, visibility, created_by)
			 SELECT gen_random_uuid(), '${w.orgId}', '${w.projectId}', 1000 + g, 'Misc ' || g, 'quokka habitat survey notes', 'public', '${w.people.member}'
			 FROM generate_series(1, 210) g`
		);
		const best = await createNote(m, { project: P(), title: 'Quokka habitat', body: 'x' });
		const r = await relatedNotes(m, { q: 'quokka habitat', project: P(), limit: 3 });
		expect(r.notes[0].ref).toBe(best.ref);
	});

	it('finds the start of a longer word, and a word in the folder name', async () => {
		const m = w.ctx('member');
		await createNote(m, {
			project: P(),
			title: 'Release steps',
			body: 'the deployment pipeline runs nightly'
		});
		expect(await refs('member', { q: 'deploy', project: P() })).toHaveLength(1);
		const folder = await createFolder(m, { project: P(), name: 'Gardening' });
		const inFolder = await createNote(m, {
			project: P(),
			title: 'Tomato log',
			body: 'tomato notes',
			folderId: folder.id
		});
		const r = await relatedNotes(m, { q: 'tomato gardening', project: P() });
		expect(r.notes[0]).toMatchObject({ ref: inFolder.ref, folder: 'Gardening' });
		// A folder limits the search, and "top" means no folder
		expect(await refs('member', { q: 'tomato', project: P(), folder: 'Gardening' })).toEqual([
			inFolder.ref
		]);
		expect(await refs('member', { q: 'tomato', project: P(), folder: 'top' })).toEqual([]);
	});

	it('does not throw on words with slashes, dots, hyphens or letters outside ASCII', async () => {
		const r = await relatedNotes(w.ctx('member'), {
			q: 'src/lib/related.ts x.y-z café résumé c++',
			project: P(),
			files: ['src/lib/server/ops/related.ts']
		});
		expect(Array.isArray(r.notes)).toBe(true);
	});

	it('asks for a usable word, and for a project when a folder is named', async () => {
		await expect(
			relatedNotes(w.ctx('member'), { q: 'a to of', project: P() })
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			relatedNotes(w.ctx('member'), { q: 'folder search', folder: 'Gardening' })
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('needs several words to agree when the request is long', async () => {
		await createNote(w.ctx('member'), {
			project: P(),
			title: 'Only one',
			body: 'platypus is all this note says'
		});
		const r = await refs('member', { q: 'platypus burrow estuary mangrove lagoon', project: P() });
		expect(r).toEqual([]);
	});

	it('hides private notes of others, trashed notes and the notes of a trashed folder', async () => {
		const m = w.ctx('member');
		const mine = await createNote(m, {
			project: P(),
			title: 'Narwhal mine',
			body: 'narwhal tusk study',
			visibility: 'private'
		});
		const theirs = await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Narwhal theirs',
			body: 'narwhal tusk study',
			visibility: 'private'
		});
		const gone = await createNote(m, {
			project: P(),
			title: 'Narwhal gone',
			body: 'narwhal tusk study'
		});
		const folder = await createFolder(m, { project: P(), name: 'Arctic' });
		const hidden = await createNote(m, {
			project: P(),
			title: 'Narwhal arctic',
			body: 'narwhal tusk study',
			folderId: folder.id
		});
		await trashNote(m, { project: P(), note: gone.ref });
		await trashFolder(m, { project: P(), folder: folder.id });
		const seen = await refs('member', { q: 'narwhal tusk', project: P() });
		expect(seen).toContain(mine.ref);
		expect(seen).not.toContain(theirs.ref);
		expect(seen).not.toContain(gone.ref);
		expect(seen).not.toContain(hidden.ref);
		expect(await refs('admin', { q: 'narwhal tusk', project: P() })).toContain(theirs.ref);
		expect(await refs('admin', { q: 'narwhal tusk', project: P() })).not.toContain(mine.ref);
	});

	it('tells a guest on a named project what a stranger is told', async () => {
		await db.admin.exec(
			`INSERT INTO project_member (org_id, project_id, user_id, role) VALUES ('${w.orgId}', '${w.projectId}', '${w.people.viewer}', 'guest')`
		);
		try {
			await expect(
				relatedNotes(w.ctx('viewer'), { q: 'zebrafish husbandry', project: P() })
			).rejects.toMatchObject({ code: 'NOT_FOUND' });
			await expect(
				relatedNotes(w.ctx('viewer'), { q: 'zebrafish husbandry', project: 'NOSUCH' })
			).rejects.toMatchObject({ code: 'NOT_FOUND' });
			// With no project named the guest project is left out
			expect(await refs('viewer', { q: 'zebrafish husbandry' })).toEqual([]);
		} finally {
			await db.admin.exec(`DELETE FROM project_member WHERE project_id = '${w.projectId}'`);
		}
	});

	it('never looks at a project outside the token limit', async () => {
		const second = w.projectId.replace(/11$/, '21');
		await db.admin.exec(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${second}', '${w.orgId}', 'TOKSECOND', 'Token second')`
		);
		await createNote(w.ctx('member'), {
			project: 'TOKSECOND',
			title: 'Capybara census',
			body: 'capybara census wetland'
		});
		const limited = w.ctx('member', { tokenProjects: [w.projectId] });
		expect(await refs('member', { q: 'capybara census' })).toHaveLength(1);
		expect((await relatedNotes(limited, { q: 'capybara census' })).notes).toEqual([]);
		await expect(
			relatedNotes(limited, { q: 'capybara census', project: 'TOKSECOND' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('refuses a missing q and a limit that is not a number', async () => {
		await expect(
			relatedNotes(w.ctx('member'), { q: undefined as unknown as string, project: P() })
		).rejects.toMatchObject({ code: 'INVALID' });
		const r = await relatedNotes(w.ctx('member'), {
			q: 'zebrafish husbandry',
			project: P(),
			limit: Number('abc'),
			offset: 1.5
		});
		expect(Array.isArray(r.notes)).toBe(true);
	});

	it('pages without repeats or gaps, and ends with a null nextOffset', async () => {
		const m = w.ctx('member');
		for (let i = 0; i < 5; i++)
			await createNote(m, { project: P(), title: `Ibis ${i}`, body: 'ibis wetland roost' });
		const first = await relatedNotes(m, { q: 'ibis wetland', project: P(), limit: 2 });
		expect(first.notes).toHaveLength(2);
		expect(first.nextOffset).toBe(2);
		const second = await relatedNotes(m, { q: 'ibis wetland', project: P(), limit: 2, offset: 2 });
		const third = await relatedNotes(m, { q: 'ibis wetland', project: P(), limit: 2, offset: 4 });
		const all = [...first.notes, ...second.notes, ...third.notes].map((n) => n.ref);
		expect(new Set(all).size).toBe(5);
		expect(third.nextOffset).toBeNull();
		const past = await relatedNotes(m, { q: 'ibis wetland', project: P(), offset: 50 });
		expect(past.notes).toEqual([]);
		expect(past.nextOffset).toBeNull();
	});

	it('shows only the plans a note links to that the reader may see, and ranks the notes of a plan higher', async () => {
		const admin = w.ctx('admin');
		const m = w.ctx('member');
		const open = await createItem(m, { project: P(), title: 'Open lynx plan', ...PLAN });
		const secret = await createItem(admin, {
			project: P(),
			title: 'Secret lynx plan',
			visibility: 'private',
			...PLAN
		});
		const a = await createNote(m, {
			project: P(),
			title: 'Lynx notes A',
			body: 'lynx tracking data'
		});
		const b = await createNote(m, {
			project: P(),
			title: 'Lynx notes B',
			body: 'lynx tracking data'
		});
		await linkNote(m, { project: P(), note: a.ref, targetKind: 'item', target: open.ref });
		await linkNote(admin, { project: P(), note: a.ref, targetKind: 'item', target: secret.ref });
		const r = await relatedNotes(m, { q: 'lynx tracking', project: P() });
		const hitA = r.notes.find((n) => n.ref === a.ref)!;
		expect(hitA.links).toEqual([
			expect.objectContaining({ kind: 'item', ref: open.ref, title: 'Open lynx plan' })
		]);
		expect(JSON.stringify(r)).not.toContain('Secret lynx plan');
		expect(hitA.links[0].status).toBeTruthy();
		// The notes linked to the plan the caller works on come first, and the plan is not listed among its own links
		// c scores between b and b with the boost (a folder named like the idea), so only the boost can put b first
		const folder = await createFolder(m, { project: P(), name: 'Lynx' });
		const c = await createNote(m, {
			project: P(),
			title: 'Lynx notes C',
			body: 'lynx tracking data',
			folderId: folder.id
		});
		await linkNote(m, { project: P(), note: b.ref, targetKind: 'item', target: open.ref });
		const order = (r: Awaited<ReturnType<typeof relatedNotes>>) => r.notes.map((n) => n.ref);
		const plain = order(await relatedNotes(m, { q: 'lynx tracking', project: P() }));
		expect(plain.indexOf(c.ref)).toBeLessThan(plain.indexOf(b.ref));
		const boosted = await relatedNotes(m, { q: 'lynx tracking', project: P(), item: open.ref });
		const withItem = order(boosted);
		expect(withItem.indexOf(b.ref)).toBeLessThan(withItem.indexOf(c.ref));
		expect(boosted.notes.flatMap((n) => n.links.map((l) => l.ref))).not.toContain(open.ref);
		// An unknown plan and a private plan of someone else answer the same
		await expect(
			relatedNotes(m, { q: 'lynx tracking', project: P(), item: 'NOPE-20260101-0000' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			relatedNotes(m, { q: 'lynx tracking', project: P(), item: secret.ref })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});
