// OWED LIVE ACTIONS: A MASTER SHOWS THE OPEN OWED LINES OF ITS VISIBLE CHILDREN, NEVER A PRIVATE CHILD OF SOMEONE ELSE
// (AFB-20261125-1527)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { createItem, getItem } from '../../src/lib/server/ops/items';
import { childrenOwed } from '../../src/lib/server/ops/owed';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

describe('children owed', () => {
	let db: TestDb;
	let w: World;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	const owedSection = (lines: string[]) => [
		{ slug: 'owed', title: 'Owed', body: lines.join('\n') }
	];

	it('lists what the visible children still owe, by child, and leaves out a private child of another person', async () => {
		const master = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Master with owed children',
			...PLAN
		});
		const open = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Public child',
			parent: master.ref,
			sections: owedSection(['- [ ] migration: apply 0059 live', '- [x] deploy: done']),
			...PLAN
		});
		await createItem(w.ctx('admin'), {
			project: w.projectKey,
			title: 'Private child',
			parent: master.ref,
			visibility: 'private',
			sections: owedSection(['- [ ] proof: a secret check']),
			...PLAN
		});
		const d = await getItem(w.ctx('member'), master.ref);
		const kids = d.family.kids[d.item.id] ?? [];
		const owed = await childrenOwed(w.ctx('member'), kids);
		expect(owed).toEqual([
			{ ref: open.ref, owed: [{ kind: 'migration', text: 'apply 0059 live' }] }
		]);
		expect(JSON.stringify(owed)).not.toContain('secret');
	});
});
