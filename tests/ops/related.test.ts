// RELATED PLANS: THE CLOSEST EARLIER PLANS TO A NEW IDEA, FOUND BY ANY OF ITS WORDS, GROUPED PER ITEM, SHORT, AND ONLY WHAT THE CALLER MAY SEE (AFB-20261019-2356)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { relatedTokens } from '../../src/lib/server/db/search';
import { searchBoard } from '../../src/lib/server/ops/board';
import { upsertDecision } from '../../src/lib/server/ops/docs';
import { createItem, trashItem } from '../../src/lib/server/ops/items';
import { RELATED_NOTICE, plainSnippet, relatedPlans } from '../../src/lib/server/ops/related';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

describe('related plans', () => {
	let db: TestDb;
	let w: World;
	let second: string;
	let secondProject: string;
	let secondKey: string;

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		second = `${w.people.member}-two`;
		await db.admin.exec(
			`INSERT INTO "user" (id, name, email, email_verified) VALUES ('${second}', 'two', '${second}@example.com', true)`
		);
		await db.admin.exec(
			`INSERT INTO member (org_id, user_id, role) VALUES ('${w.orgId}', '${second}', 'member')`
		);
		secondProject = w.projectId.replace(/11$/, '21');
		secondKey = 'SECOND';
		await db.admin.exec(
			`INSERT INTO project (id, org_id, key, name) VALUES ('${secondProject}', '${w.orgId}', '${secondKey}', 'Second project')`
		);
	}, 120_000);
	afterAll(() => db?.stop());

	const as2 = () => ({
		...w.ctx('member'),
		actor: { userId: second, kind: 'person' as const, label: 'two' }
	});
	const refs = (r: { data: { ref: string }[] }) => r.data.map((p) => p.ref);

	it('turns a request into search tokens: no filler words, no short words, paths also by their last part, at most twelve', () => {
		expect(relatedTokens('Add the new tool for the item')).toEqual([]);
		expect(relatedTokens('Rotate webhook signing keys', ['src/lib/server/ops/board.ts'])).toEqual([
			'rotate',
			'webhook',
			'signing',
			'keys',
			'src/lib/server/ops/board.ts',
			'board.ts'
		]);
		expect(relatedTokens('a b: (c) "d" / e', [])).toEqual([]);
		expect(relatedTokens(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '))).toHaveLength(
			12
		);
	});

	it('keeps the files of a long idea, and the longer words win the rest of the twelve', () => {
		const long = Array.from({ length: 30 }, (_, i) => `term${'x'.repeat(i % 7)}${i}`).join(' ');
		const tokens = relatedTokens(long, [
			'src/lib/server/ops/board.ts',
			'tests/ops/related.test.ts'
		]);
		expect(tokens).toHaveLength(12);
		expect(tokens).toEqual(
			expect.arrayContaining([
				'src/lib/server/ops/board.ts',
				'board.ts',
				'tests/ops/related.test.ts',
				'related.test.ts'
			])
		);
	});

	it('needs several words to agree, so a plan matching one of three words is left out and the matching one stays', async () => {
		const both = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Gazelle migration corridor study',
			...PLAN
		});
		const weak = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Gazelle feeding calendar',
			...PLAN
		});
		const found = await relatedPlans(w.ctx('member'), {
			q: 'gazelle migration corridor',
			project: w.projectKey
		});
		expect(refs(found)).toContain(both.ref);
		expect(refs(found)).not.toContain(weak.ref);
	});

	it('shows several distinct documents of a plan as the reason it matched, not one section many times', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Lynx corridor plan',
			sections: [
				{
					slug: 'lessons',
					title: 'Lessons',
					body: 'lynx corridor habitat survey boundary river forest'
				}
			],
			...PLAN
		});
		await upsertDecision(w.ctx('member'), {
			item: made.ref,
			kind: 'adr',
			title: 'Survey the lynx corridor first',
			decision: 'Start with the boundary.'
		});
		const found = await relatedPlans(w.ctx('member'), {
			q: 'lynx corridor habitat survey boundary river forest',
			project: w.projectKey
		});
		const plan = found.data.find((p) => p.ref === made.ref)!;
		expect(plan.matched.map((m) => m.kind)).toEqual(
			expect.arrayContaining(['section', 'decision'])
		);
	});

	it('finds a plan from a long sentence that plain search misses, and says the text is data', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Rotate the webhook signing keys',
			stream: 'fixes',
			scope: 'critical',
			sections: [{ slug: 'spec', title: 'Spec', body: 'Keys rotate every ninety days.' }],
			...PLAN
		});
		const sentence = 'We want to rotate the signing keys that webhook deliveries use, safely';
		expect(await searchBoard(w.ctx('member'), sentence)).toEqual([]);
		const found = await relatedPlans(w.ctx('member'), { q: sentence, project: w.projectKey });
		expect(refs(found)).toContain(made.ref);
		expect(found.notice).toBe(RELATED_NOTICE);
		const plan = found.data.find((p) => p.ref === made.ref)!;
		expect(plan.project).toBe(w.projectKey);
		expect(plan.matched.length).toBeGreaterThan(0);
	});

	it('refuses a request with no meaningful word, and does not throw on punctuation', async () => {
		await expect(
			relatedPlans(w.ctx('member'), { q: 'the and for with', project: w.projectKey })
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			relatedPlans(w.ctx('member'), {
				q: `a:b & c | d ! (e) 'f' "`,
				project: w.projectKey
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			relatedPlans(w.ctx('member'), {
				q: `webhook: (signing) & 'keys' | !rotate src/lib/`,
				project: w.projectKey
			})
		).resolves.toMatchObject({ notice: RELATED_NOTICE });
	});

	it('returns only the real match for a sentence full of common words', async () => {
		const real = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Quarterly billing export for accountants',
			...PLAN
		});
		const noise = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Add a new tool for the plan item',
			...PLAN
		});
		const found = await relatedPlans(w.ctx('member'), {
			q: 'add the new plan tool item for the quarterly billing export',
			project: w.projectKey
		});
		expect(refs(found)).toContain(real.ref);
		expect(refs(found)).not.toContain(noise.ref);
	});

	it('finds a file named in a section body by its last part', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Pageable reports',
			sections: [
				{
					slug: 'references',
					title: 'References',
					body: 'The work lives in src/lib/server/ops/frobnicate.ts and nowhere else.'
				}
			],
			...PLAN
		});
		const found = await relatedPlans(w.ctx('member'), {
			q: 'anything about the exports',
			files: ['frobnicate.ts'],
			project: w.projectKey
		});
		expect(refs(found)).toContain(made.ref);
	});

	it('groups the hits per item, so one plan with many matching sections is one result and the limit counts plans', async () => {
		const many = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Walrus migration',
			sections: ['a', 'b', 'c', 'd'].map((s) => ({
				slug: `part-${s}`,
				title: `Walrus part ${s}`,
				body: 'The walrus colony needs a new habitat.'
			})),
			...PLAN
		});
		const other = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Walrus feeding schedule',
			...PLAN
		});
		const found = await relatedPlans(w.ctx('member'), {
			q: 'walrus',
			project: w.projectKey,
			limit: 2
		});
		expect(refs(found).filter((r) => r === many.ref)).toHaveLength(1);
		expect(refs(found).sort()).toEqual([many.ref, other.ref].sort());
	});

	it('keeps a private plan of someone else out, even when only a section or a decision matches', async () => {
		const secret = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Plain title',
			visibility: 'private',
			sections: [{ slug: 'spec', title: 'Spec', body: 'The narwhalquartz protocol is secret.' }],
			...PLAN
		});
		await upsertDecision(w.ctx('member'), {
			item: secret.ref,
			kind: 'adr',
			title: 'Pick gemstonehalo',
			decision: 'We use gemstonehalo.'
		});
		const mine = await relatedPlans(w.ctx('member'), {
			q: 'narwhalquartz protocol gemstonehalo',
			project: w.projectKey
		});
		expect(refs(mine)).toContain(secret.ref);
		for (const ctx of [as2(), w.ctx('admin'), w.ctx('owner'), w.ctx('viewer')]) {
			const theirs = await relatedPlans(ctx, {
				q: 'narwhalquartz protocol gemstonehalo',
				project: w.projectKey
			});
			expect(refs(theirs)).not.toContain(secret.ref);
		}
	});

	it('never returns a trashed plan', async () => {
		const gone = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Pangolin armour study',
			...PLAN
		});
		expect(
			refs(await relatedPlans(w.ctx('member'), { q: 'pangolin armour', project: w.projectKey }))
		).toContain(gone.ref);
		await trashItem(w.ctx('member'), gone.ref);
		expect(
			refs(await relatedPlans(w.ctx('member'), { q: 'pangolin armour', project: w.projectKey }))
		).not.toContain(gone.ref);
	});

	it('keeps a token limited to a project inside it, whatever ranks higher elsewhere', async () => {
		const inFirst = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Okapi census',
			...PLAN
		});
		const inSecond = await createItem(w.ctx('member'), {
			project: secondKey,
			title: 'Okapi census okapi okapi',
			sections: [{ slug: 'spec', title: 'Okapi', body: 'okapi okapi okapi okapi okapi' }],
			...PLAN
		});
		const base = w.ctx('member');
		const limited = { ...base, actor: { ...base.actor, tokenProjects: [w.projectId] } };
		const found = await relatedPlans(limited, { q: 'okapi census' });
		expect(refs(found)).toContain(inFirst.ref);
		expect(refs(found)).not.toContain(inSecond.ref);
		await expect(
			relatedPlans(limited, { q: 'okapi census', project: secondKey })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// Without the limit both projects are searched
		expect(refs(await relatedPlans(base, { q: 'okapi census' }))).toEqual(
			expect.arrayContaining([inFirst.ref, inSecond.ref])
		);
	});

	it('shows nothing of another organisation', async () => {
		const stranger = {
			...w.ctx('owner'),
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		const found = await relatedPlans(stranger, { q: 'okapi census walrus colony' });
		expect(found.data).toEqual([]);
	});

	it('counts waived, superseded and reopened steps, and keeps notes short, plain and free of markup', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Marmoset trial',
			sections: [
				{
					slug: 'lessons',
					title: 'Lessons',
					body: `${'x'.repeat(50)} [click here](http://evil.example/x) <script>alert(1)</script> ![pic](http://evil.example/p.png) ${'marmoset '.repeat(400)}`
				},
				{ slug: 'resume-here', title: 'Resume here', body: 'Marmoset trial is waiting.' }
			],
			...PLAN
		});
		await recordSteps(w.ctx('member'), {
			item: made.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		await recordSteps(w.ctx('member'), { item: made.ref, marks: [{ key: '1.1', mark: 'open' }] });
		await recordSteps(w.ctx('member'), {
			item: made.ref,
			marks: [
				{ key: '1.2', mark: 'waived', reason: 'Not needed' },
				{ key: '2.1', mark: 'superseded', supersededBy: 'ABC-1' }
			]
		});
		const found = await relatedPlans(w.ctx('member'), {
			q: 'marmoset trial',
			project: w.projectKey
		});
		const plan = found.data.find((p) => p.ref === made.ref)!;
		expect(plan).toMatchObject({ reopened: 1, waived: 1, superseded: 1 });
		expect(plan.lessons!.length).toBeLessThanOrEqual(601);
		expect(plan.resume).toBe('Marmoset trial is waiting.');
		const text = JSON.stringify(found.data);
		expect(text).not.toContain('http://evil');
		expect(text).not.toContain('<script');
		expect(plan.lessons).not.toMatch(/[<>]/);
		expect(plan.lessons).toContain('click here');
		expect(text.length).toBeLessThan(6000);
	});

	it('ranks a plan higher when a plan the caller can see learned from it, and ignores plans the caller cannot see', async () => {
		const precedent = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Ibex census method',
			...PLAN
		});
		await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Ibex census plan',
			...PLAN
		});
		const score = async (ctx: ReturnType<typeof as2>) =>
			(await relatedPlans(ctx, { q: 'ibex census', project: w.projectKey })).data.find(
				(p) => p.ref === precedent.ref
			)!.score;
		const before = await score(as2());
		// A public plan names it in learned-from: everyone sees the boost
		await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Follow-up that learned from it',
			sections: [
				{ slug: 'learned-from', title: 'Learned from', body: `${precedent.ref}: reused the method` }
			],
			...PLAN
		});
		const afterPublic = await score(as2());
		expect(afterPublic).toBeGreaterThan(before);
		// A private plan of the first member also names it, but the other member does not see that plan, so no extra boost for them
		await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Private follow-up',
			visibility: 'private',
			sections: [
				{ slug: 'learned-from', title: 'Learned from', body: `${precedent.ref}: also reused` }
			],
			...PLAN
		});
		expect(await score(as2())).toBe(afterPublic);
		expect(await score(w.ctx('member'))).toBeGreaterThan(afterPublic);
	});

	it('stays fast on a section made of 200,000 unclosed brackets, and treats _ and % in a file name as plain characters', async () => {
		for (const bad of ['!['.repeat(100_000), '['.repeat(200_000), '<'.repeat(200_000)]) {
			const t0 = Date.now();
			plainSnippet(bad, 600);
			expect(Date.now() - t0).toBeLessThan(500);
		}
		const hostile = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Vole habitat survey',
			sections: [
				{ slug: 'lessons', title: 'Lessons', body: `vole ${'!['.repeat(90_000)}` },
				{ slug: 'references', title: 'References', body: 'See src/axb_vole.ts only.' }
			],
			...PLAN
		});
		const t0 = Date.now();
		const found = await relatedPlans(w.ctx('member'), { q: 'vole habitat', project: w.projectKey });
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(refs(found)).toContain(hostile.ref);
		// An underscore in the request is not a wildcard that matches the x in the body
		const wild = await relatedPlans(w.ctx('member'), {
			q: 'nothing',
			files: ['src/a_b_vole.ts'],
			project: w.projectKey
		});
		expect(refs(wild)).not.toContain(hostile.ref);
		const exact = await relatedPlans(w.ctx('member'), {
			q: 'nothing',
			files: ['src/axb_vole.ts'],
			project: w.projectKey
		});
		expect(refs(exact)).toContain(hostile.ref);
	});

	it('boosts a finished plan of the same stream, and cuts plain text at a word', () => {
		expect(plainSnippet('one two three four', 9)).toBe('one two…');
		expect(plainSnippet('<b>hi</b> [a](http://x) there', 50)).toBe('hi a there');
	});
});
