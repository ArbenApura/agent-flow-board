// NOTE FOLDERS: THE TREE, NAMES, MOVES THAT CANNOT MAKE A LOOP, TRASH AND RESTORE (AFB-20261111-0035, step 2.2)

// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { OpError, run } from '../../src/lib/server/ops/context';
import {
	createFolder,
	listFolders,
	lockTree,
	moveFolder,
	renameFolder,
	resolveFolderId,
	restoreFolder,
	trashFolder
} from '../../src/lib/server/ops/noteFolders';
import { createNote, getNote, listNotes, updateNote } from '../../src/lib/server/ops/notes';
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

describe('note folders', () => {
	let db: TestDb;
	let w: World;
	const P = () => w.projectKey;
	const add = (name: string, parentId?: string | null, who: keyof World['people'] = 'member') =>
		createFolder(w.ctx(who), { project: P(), name, parentId });
	const paths = async (who: keyof World['people'] = 'member') =>
		(await listFolders(w.ctx(who), { project: P() })).folders.map((f) => f.path);

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('folders nest, list in path order, and are named by id or by path', async () => {
		const research = await add('Research');
		const comp = await add('Competitors', research.id);
		await add('Pricing', comp.id);
		await add('Meetings');
		expect(await paths()).toEqual([
			'Meetings',
			'Research',
			'Research/Competitors',
			'Research/Competitors/Pricing'
		]);
		const renamed = await renameFolder(w.ctx('member'), {
			project: P(),
			folder: 'research/competitors',
			name: 'Rivals'
		});
		expect(renamed.id).toBe(comp.id);
		expect(await paths()).toContain('Research/Rivals/Pricing');
	});

	it('a viewer reads the tree but cannot change it, and a guest gets nothing', async () => {
		expect((await paths('viewer')).length).toBe(4);
		expect(await codeOf(add('Nope', null, 'viewer'))).toBe('FORBIDDEN');
		expect(await codeOf(listFolders(w.ctx('guest'), { project: P() }))).toBe('NOT_FOUND');
		expect(await codeOf(trashFolder(w.ctx('viewer'), { project: P(), folder: 'Meetings' }))).toBe(
			'FORBIDDEN'
		);
	});

	it('a name is taken among live siblings whatever the case, at the top and in a folder', async () => {
		expect(await codeOf(add('meetings'))).toBe('CONFLICT');
		expect(
			await codeOf(
				add(
					'RIVALS',
					(await listFolders(w.ctx('member'), { project: P() })).folders.find(
						(f) => f.path === 'Research'
					)!.id
				)
			)
		).toBe('CONFLICT');
		expect(
			await codeOf(
				renameFolder(w.ctx('member'), { project: P(), folder: 'Meetings', name: 'research' })
			)
		).toBe('CONFLICT');
		// The same name in another folder is fine
		const meetings = (await listFolders(w.ctx('member'), { project: P() })).folders.find(
			(f) => f.path === 'Meetings'
		)!;
		expect((await add('Rivals', meetings.id)).name).toBe('Rivals');
	});

	it('a folder in the trash frees its name, and a restore is refused while the name is taken', async () => {
		const temp = await add('Temp');
		await trashFolder(w.ctx('member'), { project: P(), folder: 'Temp' });
		const again = await add('temp');
		expect(again.id).not.toBe(temp.id);
		expect(await codeOf(restoreFolder(w.ctx('member'), { project: P(), folderId: temp.id }))).toBe(
			'CONFLICT'
		);
		await renameFolder(w.ctx('member'), { project: P(), folder: 'temp', name: 'Temp two' });
		expect((await restoreFolder(w.ctx('member'), { project: P(), folderId: temp.id })).name).toBe(
			'Temp'
		);
	});

	it('a folder cannot move into itself or into a folder inside it', async () => {
		const tree = (await listFolders(w.ctx('member'), { project: P() })).folders;
		const research = tree.find((f) => f.path === 'Research')!;
		const pricing = tree.find((f) => f.path === 'Research/Rivals/Pricing')!;
		for (const into of [research.id, pricing.id])
			expect(
				await codeOf(
					moveFolder(w.ctx('member'), { project: P(), folder: research.id, parentId: into })
				)
			).toBe('INVALID');
		// A real move works, and back to the top
		const moved = await moveFolder(w.ctx('member'), {
			project: P(),
			folder: pricing.id,
			parentId: research.id
		});
		expect(moved.parentId).toBe(research.id);
		expect(await paths()).toContain('Research/Pricing');
		await moveFolder(w.ctx('member'), { project: P(), folder: pricing.id, parentId: null });
		expect(await paths()).toContain('Pricing');
	});

	it('two moves at the same moment that would make a loop: one lands, one is refused, and the tree still reads', async () => {
		const a = await add('Loop A');
		const b = await add('Loop B');
		const results = await Promise.all([
			codeOf(moveFolder(w.ctx('member'), { project: P(), folder: a.id, parentId: b.id })),
			codeOf(moveFolder(w.ctx('admin'), { project: P(), folder: b.id, parentId: a.id }))
		]);
		expect(results.sort()).toEqual(['INVALID', 'ok']);
		const after = await paths();
		expect(after.some((p) => p === 'Loop A/Loop B' || p === 'Loop B/Loop A')).toBe(true);
	});

	it('a tree of 30 levels is made, read in one go, and a note at the bottom is found', async () => {
		let parent: string | null = null;
		for (let i = 1; i <= 30; i++) parent = (await add(`L${i}`, parent)).id;
		const tree = (await listFolders(w.ctx('member'), { project: P() })).folders;
		const bottom = tree.find((f) => f.id === parent)!;
		expect(bottom.depth).toBe(30);
		expect(bottom.path.split('/')).toHaveLength(30);
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Deep', folderId: parent });
		expect((await getNote(w.ctx('viewer'), { project: P(), note: n.ref })).note.folderId).toBe(
			parent
		);
		const counted = (await listFolders(w.ctx('member'), { project: P() })).folders.find(
			(f) => f.id === parent
		)!;
		expect(counted.notes).toBe(1);
	});

	it('a count shows only the notes the person may see', async () => {
		const box = await add('Box');
		await createNote(w.ctx('member'), { project: P(), title: 'Open', folderId: box.id });
		await createNote(w.ctx('member'), {
			project: P(),
			title: 'Mine only',
			folderId: box.id,
			visibility: 'private'
		});
		const count = async (who: keyof World['people']) =>
			(await listFolders(w.ctx(who), { project: P() })).folders.find((f) => f.id === box.id)!.notes;
		expect([await count('member'), await count('admin')]).toEqual([2, 1]);
	});

	it('trashing a folder hides everything under it and switches public links off; a restore brings it back with the links still off', async () => {
		const top = await add('Archive');
		const sub = await add('2026', top.id);
		const n = await createNote(w.ctx('member'), {
			project: P(),
			title: 'Shared out',
			folderId: sub.id
		});
		await db.admin.exec(
			`UPDATE note SET public_enabled = true, public_token_hash = '${'c'.repeat(64)}' WHERE id = '${n.id}'`
		);
		const res = await trashFolder(w.ctx('member'), { project: P(), folder: 'Archive' });
		expect(res.linksClosed).toBe(1);
		expect(await paths()).not.toContain('Archive/2026');
		expect(await codeOf(getNote(w.ctx('member'), { project: P(), note: n.ref }))).toBe('NOT_FOUND');
		expect(
			(await listNotes(w.ctx('member'), { project: P() })).notes.map((x) => x.ref)
		).not.toContain(n.ref);
		// The note itself was not trashed
		const [row] = await db.admin.query<{ deleted_at: Date | null; public_enabled: boolean }>(
			`select deleted_at, public_enabled from note where id = '${n.id}'`
		);
		expect(row).toEqual({ deleted_at: null, public_enabled: false });
		// A note cannot be put into a hidden folder
		expect(
			await codeOf(
				createNote(w.ctx('member'), { project: P(), title: 'Into the bin', folderId: sub.id })
			)
		).toBe('NOT_FOUND');
		await restoreFolder(w.ctx('member'), { project: P(), folderId: top.id });
		expect(await paths()).toContain('Archive/2026');
		const back = await getNote(w.ctx('member'), { project: P(), note: n.ref });
		expect([back.note.folderId, back.note.publicEnabled]).toEqual([sub.id, false]);
	});

	it('a folder restored while its parent is still in the trash comes back at the top', async () => {
		const parent = await add('Parent gone');
		const child = await add('Child kept', parent.id);
		await trashFolder(w.ctx('member'), { project: P(), folder: child.id });
		await trashFolder(w.ctx('member'), { project: P(), folder: parent.id });
		const res = await restoreFolder(w.ctx('member'), { project: P(), folderId: child.id });
		expect(res.parentId).toBe(null);
		expect(await paths()).toContain('Child kept');
		expect(await paths()).not.toContain('Parent gone');
	});

	it('a folder cannot sit deeper than 100 levels, made or moved', async () => {
		// A chain of 100 levels is written straight into the table, which is much faster than 100 verbs
		const chain = Array.from({ length: 100 }, (_, i) => ({
			id: `00000000-0000-4000-b0ff-${String(i + 1).padStart(12, '0')}`,
			parent: i === 0 ? null : `00000000-0000-4000-b0ff-${String(i).padStart(12, '0')}`,
			name: `D${i + 1}`
		}));
		await db.admin.exec(
			`INSERT INTO note_folder (id, org_id, project_id, parent_id, name) VALUES ${chain
				.map(
					(c) =>
						`('${c.id}', '${w.orgId}', '${w.projectId}', ${c.parent ? `'${c.parent}'` : 'null'}, '${c.name}')`
				)
				.join(', ')}`
		);
		const bottom = chain[99].id;
		expect(await codeOf(add('One too deep', bottom))).toBe('INVALID');
		const loose = await add('Loose');
		expect(
			await codeOf(
				moveFolder(w.ctx('member'), { project: P(), folder: loose.id, parentId: bottom })
			)
		).toBe('INVALID');
		// One level up still works
		expect((await add('Fits', chain[98].id)).name).toBe('Fits');
	});

	it('a folder with a private note of someone else in it, at any depth, is trashed by the note’s creator only', async () => {
		const top = await add('Shared box');
		const sub = await add('Inner', top.id);
		const deep = await add('Innermost', sub.id);
		await createNote(w.ctx('member'), { project: P(), title: 'Open note', folderId: top.id });
		await createNote(w.ctx('member'), {
			project: P(),
			title: 'Hidden from others',
			folderId: deep.id,
			visibility: 'private'
		});
		for (const who of ['admin', 'owner'] as const) {
			const err = await trashFolder(w.ctx(who), { project: P(), folder: top.id }).catch((e) => e);
			expect(err, who).toBeInstanceOf(OpError);
			expect(err.code, who).toBe('CONFLICT');
			expect(err.message).toMatch(/belongs to someone else and is private/);
		}
		// Nothing was trashed by the refusals, and a sub-folder is refused the same way
		expect(await paths()).toContain('Shared box/Inner/Innermost');
		expect(await codeOf(trashFolder(w.ctx('admin'), { project: P(), folder: sub.id }))).toBe(
			'CONFLICT'
		);
		// The creator may, and a folder with only shared notes is anyone's to trash
		expect((await trashFolder(w.ctx('member'), { project: P(), folder: top.id })).trashed).toBe(
			true
		);
		const plain = await add('Only shared');
		await createNote(w.ctx('member'), { project: P(), title: 'Shared one', folderId: plain.id });
		expect((await trashFolder(w.ctx('admin'), { project: P(), folder: plain.id })).trashed).toBe(
			true
		);
	});

	it('the word top means no folder only when no folder is named top, and an empty name is the top', async () => {
		const ctx = w.ctx('member');
		expect(await resolveFolderId(ctx, P(), 'top')).toBe(null);
		expect(await resolveFolderId(ctx, P(), '')).toBe(null);
		expect(await resolveFolderId(ctx, P(), undefined)).toBe(undefined);
		const real = await add('Top');
		expect(await resolveFolderId(ctx, P(), 'top')).toBe(real.id);
		expect(await resolveFolderId(ctx, P(), real.id)).toBe(real.id);
		await trashFolder(ctx, { project: P(), folder: real.id });
		expect(await resolveFolderId(ctx, P(), 'top')).toBe(null);
	});

	it('a note moved into a folder at the moment it is trashed waits for the tree lock and is refused', async () => {
		const target = await add('Race target');
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Racer' });
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let locked!: () => void;
		const held = new Promise<void>((r) => (locked = r));
		// One transaction takes the tree lock and trashes the folder, but has not committed
		const holder = run(w.ctx('member'), async (tx) => {
			await lockTree(tx, w.projectId);
			await tx.execute(
				sql`update note_folder set deleted_at = now() where id = ${target.id}::uuid`
			);
			locked();
			await gate;
		});
		await held;
		let settled = false;
		const mover = codeOf(
			updateNote(w.ctx('member'), { project: P(), note: n.ref, folderId: target.id })
		).then((c) => {
			settled = true;
			return c;
		});
		const creator = codeOf(
			createNote(w.ctx('member'), { project: P(), title: 'Late', folderId: target.id })
		);
		await new Promise((r) => setTimeout(r, 600));
		// Both are still waiting on the lock: neither has looked at the folder yet
		expect(settled).toBe(false);
		release();
		await holder;
		expect(await mover).toBe('NOT_FOUND');
		expect(await creator).toBe('NOT_FOUND');
		const [row] = await db.admin.query<{ folder_id: string | null }>(
			`select folder_id from note where id = '${n.id}'`
		);
		expect(row.folder_id).toBe(null);
	});

	it('another organisation cannot name a folder of this one', async () => {
		const other = {
			handle: db,
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		const theirs = `OTH${w.projectKey.replace('WRL', '')}`;
		const mine = (await listFolders(w.ctx('member'), { project: P() })).folders[0];
		expect(
			await codeOf(renameFolder(other, { project: theirs, folder: mine.id, name: 'Stolen' }))
		).toBe('NOT_FOUND');
		expect(
			await codeOf(
				add('Planted', null, 'member').then(() =>
					createFolder(other, { project: theirs, name: 'x', parentId: mine.id })
				)
			)
		).toBe('NOT_FOUND');
	});
});
