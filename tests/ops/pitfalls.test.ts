// PROJECT PITFALLS: WHO MAY ADD AND REMOVE, THE CAP, DUPLICATES, PARALLEL ADDS AND WHAT AN AGENT IS HANDED (AFB-20261125-1527)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { createItem } from '../../src/lib/server/ops/items';
import {
	PITFALLS_MAX,
	addPitfall,
	listPitfalls,
	plainPitfall,
	removePitfall
} from '../../src/lib/server/ops/pitfalls';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

describe('project pitfalls', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	const add = (who: keyof World['people'], text: string, extra: Record<string, unknown> = {}) =>
		addPitfall(w.ctx(who), { project: w.projectKey, kind: 'environment', text, ...extra });

	it('lets a member and their agent add a pitfall, and keeps the text plain', async () => {
		const made = await add(
			'member',
			'svelte-check needs\nNODE_OPTIONS=--max-old-space-size=8192\u0007 here'
		);
		expect(made.text).toBe('svelte-check needs NODE_OPTIONS=--max-old-space-size=8192 here');
		await addPitfall(w.ctx('member', { kind: 'agent', tool: 'claude-code' }), {
			project: w.projectKey,
			kind: 'known-red-test',
			text: 'tests/bridge/preview.test.ts times out under load',
			path: 'tests/bridge/preview.test.ts'
		});
		const list = await listPitfalls(w.ctx('viewer'), w.projectKey);
		expect(list.map((p) => p.authorKind).sort()).toEqual(['agent', 'person']);
		expect(list.every((p) => p.canRemove === false)).toBe(true);
	});

	it('refuses a viewer and a guest, and the same fact twice in another case', async () => {
		await expect(add('viewer', 'A viewer cannot add a pitfall')).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(add('guest', 'A guest cannot add a pitfall')).rejects.toBeTruthy();
		await expect(
			add('admin', 'SVELTE-CHECK needs NODE_OPTIONS=--max-old-space-size=8192 here')
		).rejects.toMatchObject({
			code: 'CONFLICT'
		});
	});

	it('lets the author or an admin remove a pitfall, never another member', async () => {
		const own = await add('member', 'Run vitest from an upper-case C drive path');
		const byAdmin = await add('admin', 'Deploy from PowerShell, never from Git Bash');
		await expect(
			removePitfall(w.ctx('member'), { project: w.projectKey, id: byAdmin.id })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const mine = (await listPitfalls(w.ctx('member'), w.projectKey)).find((p) => p.id === own.id);
		expect(mine?.canRemove).toBe(true);
		await removePitfall(w.ctx('member'), { project: w.projectKey, id: own.id });
		await removePitfall(w.ctx('admin'), { project: w.projectKey, id: byAdmin.id });
		const left = await listPitfalls(w.ctx('member'), w.projectKey);
		expect(left.map((p) => p.id)).not.toContain(own.id);
		// A removed fact may be added again
		await add('member', 'Run vitest from an upper-case C drive path');
	});

	it('names the source plan only when the caller may see it', async () => {
		const secret = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'A private plan',
			visibility: 'private',
			...PLAN
		});
		await add('member', 'A lesson from a private plan', { sourceItem: secret.ref });
		const mine = await listPitfalls(w.ctx('member'), w.projectKey);
		const theirs = await listPitfalls(w.ctx('admin'), w.projectKey);
		const pick = (l: typeof mine) => l.find((p) => p.text === 'A lesson from a private plan');
		expect(pick(mine)?.itemRef).toBe(secret.ref);
		expect(pick(theirs)?.itemRef).toBeNull();
	});

	it('holds at most the cap, even when agents add in parallel', async () => {
		const have = (await listPitfalls(w.ctx('member'), w.projectKey)).length;
		const tries = Array.from({ length: PITFALLS_MAX - have + 5 }, (_, i) =>
			add('member', `Parallel pitfall number ${i} of the batch`).then(
				() => 'ok',
				() => 'refused'
			)
		);
		const results = await Promise.all(tries);
		expect(results.filter((r) => r === 'ok')).toHaveLength(PITFALLS_MAX - have);
		expect(await listPitfalls(w.ctx('member'), w.projectKey)).toHaveLength(PITFALLS_MAX);
	});

	it('makes one plain line of any text', () => {
		expect(plainPitfall('  a\t\tb \r\n c\u0000 ')).toBe('a b c');
	});
});
