// THE NOTE MCP TOOLS THROUGH A REAL CLIENT (AFB-20261111-0035, step 2.5): LIST, READ IN PAGES, WRITE, FOLDERS, TRASH

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createItem } from '../../src/lib/server/ops/items';
import { createNote, getNote, linkNote } from '../../src/lib/server/ops/notes';
import { createToken } from '../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../support/db';
import { call, connect } from '../support/mcp';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const ALL = ['read', 'comment', 'write', 'complete', 'delete', 'manage'] as const;

describe('note tools', () => {
	let db: TestDb;
	let w: World;
	let member: Awaited<ReturnType<typeof connect>>;
	let admin: Awaited<ReturnType<typeof connect>>;
	let reader: Awaited<ReturnType<typeof connect>>;
	let sessionId = '';
	const P = () => w.projectKey;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const deps = {
			handle: db,
			storage: memoryStorage('mcp-note-secret-0123456789abcdef'),
			baseUrl: BASE
		};
		const tokenFor = async (who: keyof World['people'], permissions: string[], name: string) =>
			(await createToken(w.ctx(who), { name, permissions: permissions as never })).token;
		member = await connect(deps, await tokenFor('member', ALL.slice(0, 5), 'member-agent'));
		admin = await connect(deps, await tokenFor('admin', [...ALL], 'admin-agent'));
		reader = await connect(deps, await tokenFor('member', ['read'], 'reader-agent'));
		sessionId = (await call(member, 'session_start', { tool: 'claude-code' })).sessionId;
	}, 180_000);
	afterAll(async () => {
		await db.stop();
	});

	it('lists the note tools next to the others', async () => {
		const names = (await member.listTools()).tools.map((t) => t.name);
		for (const n of [
			'note_list',
			'note_get',
			'note_new',
			'note_update',
			'note_folder',
			'note_trash',
			'note_restore',
			'note_link'
		])
			expect(names).toContain(n);
	});

	it('makes a folder by name and a note in it by path, and lists both', async () => {
		await call(member, 'note_folder', {
			sessionId,
			project: P(),
			action: 'create',
			name: 'Research',
			requestId: 'note-tool-folder-1'
		});
		await call(member, 'note_folder', {
			sessionId,
			project: P(),
			action: 'create',
			name: 'Rivals',
			parent: 'Research',
			requestId: 'note-tool-folder-2'
		});
		const made = await call(member, 'note_new', {
			sessionId,
			project: P(),
			title: 'Pricing notes',
			body: 'They charge per seat.',
			folder: 'research/rivals',
			requestId: 'note-tool-new-1'
		});
		expect(made.ref).toBe('N-1');
		expect(JSON.stringify(made)).not.toContain('per seat');
		const list = await call(member, 'note_list', { project: P() });
		expect(list.untrusted).toBe(true);
		expect(list.folders).toEqual([
			{ path: 'Research', notes: 0 },
			{ path: 'Research/Rivals', notes: 1 }
		]);
		expect(list.notes[0]).toMatchObject({
			ref: 'N-1',
			title: 'Pricing notes',
			folder: 'Research/Rivals',
			private: false
		});
		const inFolder = await call(member, 'note_list', { project: P(), folder: 'Research' });
		expect(inFolder.notes).toEqual([]);
		const found = await call(member, 'note_list', { project: P(), q: 'seat' });
		expect(found.notes.map((n: { ref: string }) => n.ref)).toEqual(['N-1']);
	});

	it('reads in pages, and marks text another person wrote as untrusted with its author', async () => {
		const long = await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Long one',
			body: 'y'.repeat(7000)
		});
		const page = await call(member, 'note_get', { project: P(), note: long.ref });
		expect(page).toMatchObject({ untrusted: true, author: 'admin', total: 7000, nextOffset: 6000 });
		expect(page.text.length).toBe(6000);
		const rest = await call(member, 'note_get', { project: P(), note: long.ref, offset: 6000 });
		expect([rest.text.length, rest.nextOffset]).toEqual([1000, null]);
		// The agent's own person wrote N-1, but a shared note is untrusted all the same
		const own = await call(member, 'note_get', { project: P(), note: 'N-1' });
		expect([own.untrusted, own.folder, own.text]).toEqual([
			true,
			'Research/Rivals',
			'They charge per seat.'
		]);
	});

	it('a write by a tool keeps the earlier text as a version with the cause agent and starts a new epoch', async () => {
		const res = await call(member, 'note_update', {
			sessionId,
			project: P(),
			note: 'N-1',
			body: 'They charge per seat, with a yearly discount.',
			requestId: 'note-tool-update-1'
		});
		expect(res).toMatchObject({ changed: true, version: 2, epoch: 2 });
		const versions = await db.admin.query<{ body: string; cause: string }>(
			`select body, cause from note_version where note_id = '${res.id}'`
		);
		expect(versions).toEqual([{ body: 'They charge per seat.', cause: 'agent' }]);
		// A stale version is refused, and a retry of the same call writes nothing twice
		const stale = await call(member, 'note_update', {
			sessionId,
			project: P(),
			note: 'N-1',
			title: 'Late',
			expectVersion: 1,
			requestId: 'note-tool-update-2'
		});
		expect(stale.error.code).toBe('STALE_VERSION');
		const again = await call(member, 'note_update', {
			sessionId,
			project: P(),
			note: 'N-1',
			body: 'They charge per seat, with a yearly discount.',
			requestId: 'note-tool-update-1'
		});
		expect(again.version).toBe(2);
	});

	it('a private note of the agent’s person is invisible to another person’s agent', async () => {
		const mine = await call(member, 'note_new', {
			sessionId,
			project: P(),
			title: 'Scratch',
			body: 'only me',
			private: true,
			requestId: 'note-tool-new-2'
		});
		const adminSession = (await call(admin, 'session_start', { tool: 'codex' })).sessionId;
		const seen = await call(admin, 'note_list', { project: P() });
		expect(seen.notes.map((n: { ref: string }) => n.ref)).not.toContain(mine.ref);
		expect((await call(admin, 'note_get', { project: P(), note: mine.ref })).error.code).toBe(
			'NOT_FOUND'
		);
		const taken = await call(admin, 'note_update', {
			sessionId: adminSession,
			project: P(),
			note: mine.ref,
			body: 'taken',
			requestId: 'note-tool-admin-1'
		});
		expect(taken.error.code).toBe('NOT_FOUND');
		expect((await call(member, 'note_get', { project: P(), note: mine.ref })).private).toBe(true);
	});

	it('a read only token reads but is refused on every write', async () => {
		expect((await call(reader, 'note_get', { project: P(), note: 'N-1' })).ref).toBe('N-1');
		const s = (await call(reader, 'session_start', { tool: 'gemini' })).sessionId;
		for (const [name, args] of [
			['note_new', { title: 'No' }],
			['note_update', { note: 'N-1', title: 'No' }],
			['note_trash', { note: 'N-1' }],
			['note_folder', { action: 'create', name: 'No' }]
		] as const) {
			const r = await call(reader, name, {
				sessionId: s,
				project: P(),
				...args,
				requestId: `note-tool-reader-${name}`
			});
			expect(r.error.code, name).toBe('FORBIDDEN');
		}
	});

	it('pages a long list with offset and nextOffset, and refuses an empty folder on a change', async () => {
		for (const i of [1, 2, 3])
			await createNote(w.ctx('member'), { project: P(), title: `Mcp paged ${i}` });
		const seen: string[] = [];
		let offset: number | undefined;
		const flags: boolean[] = [];
		for (let guard = 0; guard < 5; guard++) {
			const page = await call(member, 'note_list', {
				project: P(),
				q: 'Mcp paged',
				limit: 2,
				...(offset === undefined ? {} : { offset })
			});
			seen.push(...page.notes.map((n: { ref: string }) => n.ref));
			flags.push(page.more);
			if (page.nextOffset === null) break;
			offset = page.nextOffset;
		}
		expect(flags).toEqual([true, false]);
		expect(new Set(seen).size).toBe(3);
		const empty = await call(member, 'note_update', {
			sessionId,
			project: P(),
			note: 'N-1',
			folder: '',
			requestId: 'note-tool-empty-folder-1'
		});
		expect(empty.error.code).toBe('INVALID');
		// The note stayed where it was
		const stays = await call(member, 'note_get', { project: P(), note: 'N-1' });
		expect(stays.folder).toBe('Research/Rivals');
	});

	it('moves a note and a folder, renames, trashes and restores', async () => {
		await call(member, 'note_update', {
			sessionId,
			project: P(),
			note: 'N-1',
			folder: 'top',
			requestId: 'note-tool-move-1'
		});
		expect((await call(member, 'note_get', { project: P(), note: 'N-1' })).folder).toBe(null);
		await call(member, 'note_folder', {
			sessionId,
			project: P(),
			action: 'move',
			folder: 'Research/Rivals',
			parent: 'top',
			requestId: 'note-tool-folder-3'
		});
		await call(member, 'note_folder', {
			sessionId,
			project: P(),
			action: 'rename',
			folder: 'Rivals',
			name: 'Competitors',
			requestId: 'note-tool-folder-4'
		});
		const missing = await call(member, 'note_folder', {
			sessionId,
			project: P(),
			action: 'rename',
			folder: 'Competitors',
			requestId: 'note-tool-folder-5'
		});
		expect(missing.error.code).toBe('INVALID');
		await call(member, 'note_folder', {
			sessionId,
			project: P(),
			action: 'trash',
			folder: 'Research',
			requestId: 'note-tool-folder-6'
		});
		const tree = await call(member, 'note_list', { project: P() });
		expect(tree.folders.map((f: { path: string }) => f.path)).toEqual(['Competitors']);
		await call(member, 'note_trash', {
			sessionId,
			project: P(),
			note: 'N-1',
			requestId: 'note-tool-trash-1'
		});
		expect((await call(member, 'note_get', { project: P(), note: 'N-1' })).error.code).toBe(
			'NOT_FOUND'
		);
		await call(member, 'note_restore', {
			sessionId,
			project: P(),
			note: 'N-1',
			requestId: 'note-tool-restore-1'
		});
		const back = await getNote(w.ctx('member'), { project: P(), note: 'N-1' });
		expect(back.note.title).toBe('Pricing notes');
	});
	it('links notes with note_link: add, list with Mentioned by, remove; a read only token is refused', async () => {
		const a = await createNote(w.ctx('member'), { project: P(), title: 'Link source' });
		const b = await createNote(w.ctx('member'), { project: P(), title: 'Link target' });
		const add = await call(member, 'note_link', {
			sessionId,
			project: P(),
			note: a.ref,
			action: 'add',
			kind: 'note',
			target: b.ref,
			requestId: 'note-tool-link-1'
		});
		expect(add.linked).toMatchObject({ kind: 'note', ref: b.ref });
		const list = await call(member, 'note_link', {
			sessionId,
			project: P(),
			note: b.ref,
			action: 'list'
		});
		expect(list.untrusted).toBe(true);
		expect(list.mentionedBy.map((m: { ref: string }) => m.ref)).toEqual([a.ref]);
		const missing = await call(member, 'note_link', {
			sessionId,
			project: P(),
			note: a.ref,
			action: 'add',
			requestId: 'note-tool-link-2'
		});
		expect(missing.error.code).toBe('INVALID');
		const s = (await call(reader, 'session_start', { tool: 'gemini' })).sessionId;
		const refused = await call(reader, 'note_link', {
			sessionId: s,
			project: P(),
			note: a.ref,
			action: 'remove',
			kind: 'note',
			target: b.ref,
			requestId: 'note-tool-link-3'
		});
		expect(refused.error.code).toBe('FORBIDDEN');
		await call(member, 'note_link', {
			sessionId,
			project: P(),
			note: a.ref,
			action: 'remove',
			kind: 'note',
			target: b.ref,
			requestId: 'note-tool-link-4'
		});
		const after = await call(member, 'note_link', {
			sessionId,
			project: P(),
			note: b.ref,
			action: 'list'
		});
		expect(after.mentionedBy).toEqual([]);
	});

	it('work_start and session_start with an item list the notes linked to it, and a note lookup that fails does not fail the claim', async () => {
		const plan = await createItem(w.ctx('member'), {
			project: P(),
			title: 'Plan with a linked note',
			...PLAN
		});
		const n = await createNote(w.ctx('member'), { project: P(), title: 'Linked to the plan' });
		const priv = await createNote(w.ctx('admin'), {
			project: P(),
			title: 'Admin private, linked',
			visibility: 'private'
		});
		await linkNote(w.ctx('member'), {
			project: P(),
			note: n.ref,
			targetKind: 'item',
			target: plan.ref
		});
		await linkNote(w.ctx('admin'), {
			project: P(),
			note: priv.ref,
			targetKind: 'item',
			target: plan.ref
		});
		const started = await call(member, 'work_start', {
			sessionId,
			item: plan.ref,
			requestId: 'note-tool-claim-1'
		});
		expect(started.notes).toEqual([
			{ ref: n.ref, project: P(), title: 'Linked to the plan', folder: null, untrusted: true }
		]);
		const fresh = await call(member, 'session_start', {
			tool: 'claude-code',
			item: plan.ref
		});
		expect(fresh.notes.map((x: { ref: string }) => x.ref)).toEqual([n.ref]);
		// The admin, whose token reaches everything, also sees their own private note
		const adminSession = (await call(admin, 'session_start', { tool: 'codex' })).sessionId;
		const adminStart = await call(admin, 'work_start', {
			sessionId: adminSession,
			item: plan.ref,
			requestId: 'note-tool-claim-2'
		});
		expect(adminStart.notes.map((x: { ref: string }) => x.ref).sort()).toEqual(
			[n.ref, priv.ref].sort()
		);
		// A plan with no linked note has no notes field at all: replies only gain fields
		const bare = await createItem(w.ctx('member'), { project: P(), title: 'Plan alone', ...PLAN });
		const alone = await call(member, 'work_start', {
			sessionId,
			item: bare.ref,
			requestId: 'note-tool-claim-3'
		});
		expect(alone.notes).toBeUndefined();
		expect(alone.notesUnavailable).toBeUndefined();
		// The lookup fails, the claim stands and says so
		await db.admin.exec('ALTER TABLE note_link RENAME TO note_link_away');
		try {
			const broken = await call(member, 'work_start', {
				sessionId,
				item: plan.ref,
				requestId: 'note-tool-claim-4'
			});
			expect(broken.error).toBeUndefined();
			expect(broken.notesUnavailable).toBe(true);
			expect(broken.displayTitle).toBeTruthy();
		} finally {
			await db.admin.exec('ALTER TABLE note_link_away RENAME TO note_link');
		}
		const related = await call(member, 'related_plans', {
			q: 'linked plan with note lookup',
			project: P()
		});
		expect(Array.isArray(related.notes)).toBe(true);
	});
});
