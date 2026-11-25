// SHARED FILES: THE HOOK RECORDS REPO-RELATIVE PATHS OF A CLAIMED SESSION, AND AN AGENT HEARS WHICH FILES ANOTHER LIVE
// SESSION OF THE PROJECT ALSO EDITED, WITHOUT NAMING A PRIVATE PLAN (AFB-20261125-1527)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// IMPORTED MODULES
import { claim } from '../../src/lib/server/mcp/sessions';
import { sessionFile, session } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { handleHook } from '../../src/lib/server/ops/hooks';
import { createItem } from '../../src/lib/server/ops/items';
import {
	repoRelative,
	sharedFilesFor,
	sharedFilesNote
} from '../../src/lib/server/ops/sharedFiles';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

describe('shared files', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	const agentCtx = (who: keyof World['people'], sessionId?: string) =>
		w.ctx(who, { kind: 'agent', tool: 'claude-code', ...(sessionId ? { sessionId } : {}) });

	/** One conversation of one person: its session comes from the hook, then it claims the item. */
	async function conversation(who: keyof World['people'], externalId: string, itemRef: string) {
		const hook = (extra: Record<string, unknown>) =>
			handleHook(agentCtx(who), { tool: 'claude-code', externalId, ...extra } as never);
		await hook({ event: 'start' });
		const [row] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(session).where(eq(session.externalId, externalId))
		);
		await claim(agentCtx(who, row.id), row.id, itemRef);
		return {
			id: row.id,
			edit: (file: string, cwd?: string) =>
				hook({ event: 'tool', ...(cwd ? { cwd } : {}), action: { kind: 'edit', file } })
		};
	}

	const rowsOf = (sessionId: string) =>
		withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(sessionFile).where(eq(sessionFile.sessionId, sessionId))
		);

	it('makes a path repo-relative on Windows and POSIX, and drops one outside the folder', () => {
		expect(repoRelative('C:\\Users\\Ana\\repo', 'c:\\Users\\Ana\\repo\\src\\a.ts')).toBe(
			'src/a.ts'
		);
		expect(repoRelative('/home/bo/repo/', '/home/bo/repo/src/lib/b.ts')).toBe('src/lib/b.ts');
		expect(repoRelative('/home/bo/repo', 'src/c.ts')).toBe('src/c.ts');
		expect(repoRelative('/home/bo/repo', '/home/bo/other/d.ts')).toBeNull();
		expect(repoRelative('/home/bo/repo', '../secret.ts')).toBeNull();
		expect(repoRelative(undefined, 'src/a.ts')).toBeNull();
	});

	it('records one row per path of a claimed session, only with a folder, and moves the time on a repeat', async () => {
		const it1 = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Shared one',
			...PLAN
		});
		const c = await conversation('member', 'shared-conv-0001', it1.ref);
		await c.edit('C:\\work\\repo\\src\\x.ts', 'C:\\work\\repo');
		await c.edit('C:\\work\\repo\\src\\x.ts', 'C:\\work\\repo');
		await c.edit('src/no-folder.ts');
		await c.edit('D:\\elsewhere\\y.ts', 'C:\\work\\repo');
		const rows = await rowsOf(c.id);
		expect(rows.map((r) => r.path)).toEqual(['src/x.ts']);
		expect(rows[0].itemId).toBe(it1.id);
	});

	it('names a file another live session edited, its plan only when the caller may see it', async () => {
		const mine = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Mine',
			...PLAN
		});
		const theirs = await createItem(w.ctx('admin'), {
			project: w.projectKey,
			title: 'Their private plan',
			visibility: 'private',
			...PLAN
		});
		const a = await conversation('member', 'shared-conv-0002', mine.ref);
		const b = await conversation('admin', 'shared-conv-0003', theirs.ref);
		await a.edit('/r/src/shared.ts', '/r');
		await a.edit('/r/src/only-mine.ts', '/r');
		await b.edit('/home/admin/r/src/shared.ts', '/home/admin/r');
		const found = await sharedFilesFor(agentCtx('member'), a.id);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ path: 'src/shared.ts', item: 'another session' });
		// The admin's own view names the member's public plan
		const back = await sharedFilesFor(agentCtx('admin'), b.id);
		expect(back[0]).toMatchObject({ path: 'src/shared.ts', item: mine.ref });
		// A person gets nothing, an agent gets the notice
		expect(await sharedFilesNote(w.ctx('member'), a.id)).toEqual({});
		const note = await sharedFilesNote(agentCtx('member'), a.id);
		expect(note).toMatchObject({ sharedFiles: [{ path: 'src/shared.ts' }] });
		expect(JSON.stringify(note)).not.toContain('/home/admin');
	});

	it('leaves out a session that was not seen for half an hour', async () => {
		const one = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Quiet one',
			...PLAN
		});
		const a = await conversation('member', 'shared-conv-0004', one.ref);
		const b = await conversation('member', 'shared-conv-0005', one.ref);
		await a.edit('/q/src/quiet.ts', '/q');
		await b.edit('/q/src/quiet.ts', '/q');
		await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx
				.update(session)
				.set({ lastSeenAt: new Date(Date.now() - 31 * 60_000) })
				.where(eq(session.id, b.id))
		);
		expect(await sharedFilesFor(agentCtx('member'), a.id)).toEqual([]);
	});
});
