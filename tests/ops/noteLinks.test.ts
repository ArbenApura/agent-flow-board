// NOTE LINKS: TEXT LINKS WORKED OUT FROM THE BODY AS A DIFFERENCE, PANEL LINKS, AND WHAT A READER MAY SEE (AFB-20261111-0035, step 5.1)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { extractNoteRefs } from '../../src/lib/shared/noteLinks';
import { OpError } from '../../src/lib/server/ops/context';
import {
	countLinkedNotes,
	createNote,
	getNoteLinks,
	linkNote,
	listNotesLinkedTo,
	restoreNote,
	trashNote,
	unlinkNote,
	updateNote
} from '../../src/lib/server/ops/notes';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- FUNCTIONS -- //

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'ok';
	} catch (e) {
		if (e instanceof OpError) return e.code;
		throw e;
	}
}

const uid = (n: number) => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`;

describe('the reference extractor', () => {
	it('finds afb addresses and bare references, once each, and skips code', () => {
		const body = [
			'See afb:item/AFB-20261107-0346 and [x](afb:task/T-4) and AFB-20261107-0346 again, plus N-12 and T-4.',
			'A mockup afb:mockup/' + uid(1) + ' and a picture ![](afb:file/' + uid(2) + ').',
			'Inline `N-99` and ``T-98`` are code.',
			'```',
			'N-97 AFB-20261107-0001',
			'```',
			'~~~md',
			'N-96',
			'~~~',
			'Not refs: XN-5, N-0, v1N-2, https://x.test/N-7, a/T-8.'
		].join('\n');
		expect(extractNoteRefs(body).map((r) => `${r.kind}:${r.ref}`)).toEqual([
			'item:AFB-20261107-0346',
			'task:T-4',
			'mockup:' + uid(1),
			'note:N-12'
		]);
	});

	it('caps the number of references', () => {
		const body = Array.from({ length: 400 }, (_, i) => `N-${i + 1}`).join(' ');
		expect(extractNoteRefs(body)).toHaveLength(200);
	});
});

describe('note links', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;
	const ref = (n: number) => `${w.projectKey}-20261111-${String(n).padStart(4, '0')}`;
	const ids = {
		pubItem: uid(10),
		privItem: uid(11),
		trashedItem: uid(12),
		foreignItem: uid(13),
		task1: uid(20),
		task2Trashed: uid(21),
		mockupPub: uid(30),
		mockupOnPriv: uid(31),
		otherProject: uid(40)
	};
	/** The titles of what a reader sees a note link to. */
	const linksOf = async (who: keyof World['people'], note: string) =>
		(await getNoteLinks(w.ctx(who), { project: P(), note })).links.map(
			(l) => `${l.kind}:${l.ref ?? l.title}`
		);
	const rowsOf = (noteRef: string) =>
		db.admin.query<{ id: string; target_kind: string; source: string; xmin: string }>(
			`SELECT l.id, l.target_kind, l.source, l.xmin::text FROM note_link l JOIN note n ON n.id = l.note_id WHERE n.number = ${Number(noteRef.slice(2))} AND n.project_id = '${w.projectId}' ORDER BY l.target_kind, l.id`
		);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const a = db.admin;
		const base = `'${w.orgId}', '${w.projectId}'`;
		await a.exec(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${ids.otherProject}', '${w.orgId}', 'SECOND', 'Second')`
		);
		await a.exec(
			`INSERT INTO item (id, org_id, project_id, number, ref, title, visibility, created_by, deleted_at) VALUES
			('${ids.pubItem}', ${base}, 1, '${ref(1)}', 'Public plan', 'public', '${w.people.member}', null),
			('${ids.privItem}', ${base}, 2, '${ref(2)}', 'Private plan', 'private', '${w.people.member}', null),
			('${ids.trashedItem}', ${base}, 3, '${ref(3)}', 'Trashed plan', 'public', '${w.people.member}', now()),
			('${ids.foreignItem}', '${w.orgId}', '${ids.otherProject}', 1, 'SECOND-20261111-0001', 'Plan of the second project', 'public', '${w.people.member}', null)`
		);
		await a.exec(
			`INSERT INTO task (id, org_id, project_id, number, title, deleted_at) VALUES
			('${ids.task1}', ${base}, 1, 'A task', null),
			('${ids.task2Trashed}', ${base}, 2, 'A trashed task', now())`
		);
		await a.exec(
			`INSERT INTO mockup (id, org_id, project_id, item_id, title, visibility, created_by) VALUES
			('${ids.mockupPub}', ${base}, null, 'Standalone mockup', 'public', '${w.people.member}'),
			('${ids.mockupOnPriv}', ${base}, '${ids.privItem}', 'Mockup of the private plan', 'private', '${w.people.member}')`
		);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('every target kind becomes a text link, once, with its reference', async () => {
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Kinds',
			body: `Plan afb:item/${ref(1)}, task T-1, mockup afb:mockup/${ids.mockupPub}, and bare ${ref(1)} again. Note afb:note/N-1 is itself.`
		});
		expect(n.ref).toBe('N-1');
		const other = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Other',
			body: 'Look at N-1 and afb:note/N-1.'
		});
		expect(await linksOf('member', n.ref)).toEqual([
			`item:${ref(1)}`,
			'task:T-1',
			'mockup:Standalone mockup'
		]);
		const links = await getNoteLinks(w.ctx('viewer'), { project: P(), note: n.ref });
		expect(links.links.every((l) => l.sources.join() === 'text')).toBe(true);
		expect(links.counts).toEqual({ links: 3, mentionedBy: 1 });
		expect(links.mentionedBy.map((m) => m.ref)).toEqual([other.ref]);
		expect(await linksOf('member', other.ref)).toEqual(['note:N-1']);
	});

	it('a reference to another project, to nothing, or inside code makes no link', async () => {
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Nothing',
			body: [
				'Other project SECOND-20261111-0001 and afb:item/SECOND-20261111-0001.',
				'Nothing: N-9999, T-999, afb:mockup/' + uid(99) + ', ' + ref(77) + '.',
				'Code `' + ref(1) + '` and',
				'```',
				'T-1 N-1',
				'```'
			].join('\n')
		});
		expect(await linksOf('member', n.ref)).toEqual([]);
		expect((await rowsOf(n.ref)).length).toBe(0);
	});

	it('a save works the links out as a difference, and an unchanged body writes no link rows', async () => {
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Diff',
			body: `One ${ref(1)} and T-1.`
		});
		const before = await rowsOf(n.ref);
		expect(before.map((r) => r.target_kind)).toEqual(['item', 'task']);
		// Body changed: the task goes, the mockup comes, the plan row is left alone (same row, not rewritten)
		await updateNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			body: `One ${ref(1)} and afb:mockup/${ids.mockupPub}.`
		});
		const after = await rowsOf(n.ref);
		expect(after.map((r) => r.target_kind)).toEqual(['item', 'mockup']);
		expect(after.find((r) => r.target_kind === 'item')).toEqual(
			before.find((r) => r.target_kind === 'item')
		);
		// A row removed behind the back stays removed when the body is saved unchanged, so no work was done
		await db.admin.exec(
			`DELETE FROM note_link WHERE id = '${after.find((r) => r.target_kind === 'mockup')!.id}'`
		);
		const same = await updateNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			title: 'Diff renamed',
			body: `One ${ref(1)} and afb:mockup/${ids.mockupPub}.`
		});
		expect(same.changed).toBe(true);
		expect((await rowsOf(n.ref)).map((r) => r.target_kind)).toEqual(['item']);
		// A real change of the body works it out again and brings the mockup back
		await updateNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			body: `One ${ref(1)} and afb:mockup/${ids.mockupPub} and more.`
		});
		expect((await rowsOf(n.ref)).map((r) => r.target_kind)).toEqual(['item', 'mockup']);
	});

	it('a link to a private plan survives a save by someone who cannot see it, and is never shown to them', async () => {
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'About the private plan',
			body: `Private ${ref(2)} and its afb:mockup/${ids.mockupOnPriv}.`
		});
		expect(await linksOf('member', n.ref)).toEqual([
			`item:${ref(2)}`,
			'mockup:Mockup of the private plan'
		]);
		// Nobody but the creator sees it, owners and admins included
		for (const who of ['admin', 'owner', 'viewer'] as const)
			expect(await linksOf(who, n.ref), who).toEqual([]);
		// The admin edits another part of the text: the links stay
		await updateNote(w.ctx('admin'), {
			project: P(),
			note: n.ref,
			body: `Private ${ref(2)} and its afb:mockup/${ids.mockupOnPriv}. Added by the admin.`
		});
		expect(await linksOf('member', n.ref)).toEqual([
			`item:${ref(2)}`,
			'mockup:Mockup of the private plan'
		]);
		expect(await linksOf('admin', n.ref)).toEqual([]);
		// The admin naming the private plan makes the link too, still unseen by the admin
		const m = await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Admin names it',
			body: `Blind ${ref(2)}.`
		});
		expect(await linksOf('admin', m.ref)).toEqual([]);
		expect(await linksOf('member', m.ref)).toEqual([`item:${ref(2)}`]);
		// Notes that link to the private plan are not listed to someone who cannot see the plan
		expect(
			await codeOf(
				listNotesLinkedTo(w.ctx('admin'), { project: P(), targetKind: 'item', target: ref(2) })
			)
		).toBe('NOT_FOUND');
		const seen = await listNotesLinkedTo(w.ctx('member'), {
			project: P(),
			targetKind: 'item',
			target: ref(2)
		});
		expect(seen.notes.map((x) => x.title).sort()).toEqual([
			'About the private plan',
			'Admin names it'
		]);
	});

	it('trashed targets are left out from either end, and come back with a restore', async () => {
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Trash ends',
			body: `Gone ${ref(3)} and T-2 and live T-1.`
		});
		expect(await linksOf('member', n.ref)).toEqual(['task:T-1']);
		// The rows exist, so a restore would show them
		expect((await rowsOf(n.ref)).length).toBe(3);
		await db.admin.exec(`UPDATE task SET deleted_at = null WHERE id = '${ids.task2Trashed}'`);
		expect(await linksOf('member', n.ref)).toEqual(['task:T-1', 'task:T-2']);
		await db.admin.exec(`UPDATE task SET deleted_at = now() WHERE id = '${ids.task2Trashed}'`);
		// A trashed note neither shows in Mentioned by nor in the notes of a plan
		const target = await createNote(w.ctx('member'), { project: P(), title: 'Target', body: '' });
		const src = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Mentions the target',
			body: `See ${target.ref}.`
		});
		const mention = async () =>
			(await getNoteLinks(w.ctx('member'), { project: P(), note: target.ref })).mentionedBy.map(
				(m) => m.ref
			);
		expect(await mention()).toEqual([src.ref]);
		await trashNote(w.ctx('member'), { project: P(), note: src.ref });
		expect(await mention()).toEqual([]);
		await restoreNote(w.ctx('member'), { project: P(), note: src.ref });
		expect(await mention()).toEqual([src.ref]);
		// ... and a trashed target note is left out of the source
		await trashNote(w.ctx('member'), { project: P(), note: target.ref });
		expect(await linksOf('member', src.ref)).toEqual([]);
		await restoreNote(w.ctx('member'), { project: P(), note: target.ref });
		expect(await linksOf('member', src.ref)).toEqual([`note:${target.ref}`]);
	});

	it("another person's private note is not in Mentioned by, and a private note links like any other for its creator", async () => {
		const target = await createNote(w.ctx('owner'), { project: P(), title: 'Shared target' });
		const hidden = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Hidden mention',
			body: `Private mention of ${target.ref}.`,
			visibility: 'private'
		});
		const open = await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Open mention',
			body: `Open mention of ${target.ref}.`
		});
		const mentions = async (who: keyof World['people']) =>
			(await getNoteLinks(w.ctx(who), { project: P(), note: target.ref })).mentionedBy.map(
				(m) => m.ref
			);
		expect((await mentions('owner')).sort()).toEqual([open.ref]);
		expect((await mentions('member')).sort()).toEqual([hidden.ref, open.ref].sort());
		expect(await linksOf('member', hidden.ref)).toEqual([`note:${target.ref}`]);
	});

	it('panel links: add, twice, remove; refused for what the caller cannot see, itself, and without write', async () => {
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Panel',
			body: 'T-1 in text.'
		});
		const add = (
			who: keyof World['people'],
			kind: 'item' | 'task' | 'mockup' | 'note',
			target: string
		) => linkNote(w.ctx(who), { project: P(), note: n.ref, targetKind: kind, target });
		const r = await add('member', 'item', ref(1));
		expect(r.linked).toMatchObject({ kind: 'item', ref: ref(1), title: 'Public plan' });
		await add('member', 'item', ref(1));
		await add('member', 'mockup', ids.mockupPub);
		expect(await rowsOf(n.ref).then((x) => x.filter((y) => y.source === 'panel').length)).toBe(2);
		// A private plan cannot be linked by someone who cannot see it, and answers like a plan that does not exist
		expect(await codeOf(add('admin', 'item', ref(2)))).toBe('NOT_FOUND');
		expect(await codeOf(add('admin', 'item', ref(99)))).toBe('NOT_FOUND');
		// Another project and a trashed plan
		expect(await codeOf(add('member', 'item', 'SECOND-20261111-0001'))).toBe('NOT_FOUND');
		expect(await codeOf(add('member', 'item', ref(3)))).toBe('NOT_FOUND');
		expect(await codeOf(add('member', 'note', n.ref))).toBe('INVALID');
		expect(await codeOf(add('viewer', 'task', 'T-1'))).toBe('FORBIDDEN');
		// A task linked by hand and in the text shows once with both sources
		await add('member', 'task', 'T-1');
		const links = await getNoteLinks(w.ctx('member'), { project: P(), note: n.ref });
		expect(links.links.find((l) => l.ref === 'T-1')?.sources).toEqual(['panel', 'text']);
		// Removing the panel link leaves the text link
		const gone = { project: P(), note: n.ref, targetKind: 'task' as const, target: 'T-1' };
		expect((await unlinkNote(w.ctx('member'), gone)).unlinked).toBe(true);
		expect((await unlinkNote(w.ctx('member'), gone)).unlinked).toBe(true);
		expect(
			(await getNoteLinks(w.ctx('member'), { project: P(), note: n.ref })).links.find(
				(l) => l.ref === 'T-1'
			)?.sources
		).toEqual(['text']);
		expect(await codeOf(unlinkNote(w.ctx('viewer'), gone))).toBe('FORBIDDEN');
	});

	it('the notes of a plan, task or mockup, and the counts, are what the reader may see; guests see none', async () => {
		const shared = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Count shared',
			body: `About ${ref(1)} and T-1.`
		});
		await createNote(w.ctx('member'), {
			project: P(),
			title: 'Count private',
			body: `Mine ${ref(1)}.`,
			visibility: 'private'
		});
		const titles = async (who: keyof World['people']) =>
			(
				await listNotesLinkedTo(w.ctx(who), { project: P(), targetKind: 'item', target: ref(1) })
			).notes
				.map((x) => x.title)
				.filter((t) => t.startsWith('Count'))
				.sort();
		expect(await titles('member')).toEqual(['Count private', 'Count shared']);
		expect(await titles('viewer')).toEqual(['Count shared']);
		const task = await listNotesLinkedTo(w.ctx('viewer'), {
			project: P(),
			targetKind: 'task',
			target: 'T-1'
		});
		expect(task.notes.map((x) => x.ref)).toContain(shared.ref);
		const counts = (who: keyof World['people']) =>
			countLinkedNotes(w.ctx(who), {
				project: P(),
				targetKind: 'item',
				targets: [ids.pubItem, ids.privItem]
			}).then((r) => r.counts);
		const mine = await counts('member');
		const theirs = await counts('viewer');
		expect(mine[ids.pubItem]).toBeGreaterThan(theirs[ids.pubItem]);
		// A guest has no role on the project: nothing is returned, whichever way the refusal comes
		const guest = await listNotesLinkedTo(w.ctx('guest'), {
			project: P(),
			targetKind: 'item',
			target: ref(1)
		}).then(
			(r) => r.notes,
			(e) => (e instanceof OpError ? 'refused' : Promise.reject(e))
		);
		expect(guest === 'refused' || (Array.isArray(guest) && guest.length === 0)).toBe(true);
		const gc = await countLinkedNotes(w.ctx('guest'), {
			project: P(),
			targetKind: 'item',
			targets: [ids.pubItem]
		}).then(
			(r) => r.counts,
			(e) => (e instanceof OpError ? 'refused' : Promise.reject(e))
		);
		expect(gc === 'refused' || Object.keys(gc).length === 0).toBe(true);
	});
});
