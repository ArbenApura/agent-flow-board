// PHASE 9: SESSION CLAIMS, EVIDENCE, CLOSE HANDLING, COMMIT LINKING, THE PULL REQUEST CHECK, HOOK LOGIC, REMINDERS AND HEALTH
// GitHub is the stand in server (tests/support/githubMock.mjs). Nothing touches the network.

// -- DEP-MODULES -- //
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { createGithubApi } from '../../src/lib/server/github/app';
import { trailerRefs, checkSummary } from '../../src/lib/server/github/commits';
import { handleWebhook } from '../../src/lib/server/github/webhook';
import { claim, startSession } from '../../src/lib/server/mcp/sessions';
import {
	commitLink,
	githubInstallation,
	githubLink,
	session,
	step
} from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { run } from '../../src/lib/server/ops/context';
import { handleHook } from '../../src/lib/server/ops/hooks';
import { projectSummary } from '../../src/lib/server/ops/board';
import { projectHealth } from '../../src/lib/server/ops/health';
import { createItem, updateItem } from '../../src/lib/server/ops/items';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { setStatus } from '../../src/lib/server/ops/status';
import {
	IDLE_MINUTES,
	QUIET_RECORD_MINUTES,
	RENEW_SECONDS,
	isIdle,
	renewSession,
	trackingNotes
} from '../../src/lib/server/ops/tracking';
import { createGithubMock } from '../support/githubMock.mjs';
import { makePglite, makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';
import { isCodeFile, commits } from '../../src/lib/shared/code';

// -- CONSTANTS -- //

const PKCS1 = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ type: 'pkcs1', format: 'pem' })
	.toString();
const INSTALL = '777';
const REPO = 'acme/track';

// -- FUNCTIONS -- //

describe('small helpers', () => {
	it('knows which files are code and which commands commit', () => {
		for (const f of [
			'src/a.ts',
			'web/src/routes/+page.svelte',
			'scripts/x.py',
			'C:\\work\\app\\main.go'
		])
			expect(isCodeFile(f), f).toBe(true);
		for (const f of [
			'README.md',
			'docs/guide.ts',
			'.board/flow/x/PLAN.md',
			'node_modules/a/b.js',
			'.claude/skills/x.ts',
			'package.json',
			'notes.txt'
		])
			expect(isCodeFile(f), f).toBe(false);
		expect(commits('git commit -m "x"')).toBe(true);
		expect(commits('cd repo && git -C repo commit -am y')).toBe(true);
		expect(commits('echo "git commit later"')).toBe(false);
		expect(commits('git commit --dry-run')).toBe(false);
		expect(commits('git status')).toBe(false);
	});
	it('reads item references from trailers and from the end of the subject, and says what a check found', () => {
		expect(trailerRefs('Fix cards\n\nItem: CKT-12')).toEqual(['CKT-12']);
		expect(trailerRefs('Fix cards (CKT-12)')).toEqual(['CKT-12']);
		expect(
			trailerRefs('feat: a thing (FLOW-20261015-1120)\n\nRefs: CKT-3, WEB-9\nCloses: CKT-3')
		).toEqual(['CKT-3', 'WEB-9', 'FLOW-20261015-1120']);
		// The stamp form of a new item, with and without a suffix (FLOW-20261017-0950)
		expect(trailerRefs('Fix cards (HAPR-20261017-0950)')).toEqual(['HAPR-20261017-0950']);
		expect(trailerRefs('Fix cards\n\nRefs: HAPR-20261017-0950-b, CKT-3')).toEqual([
			'HAPR-20261017-0950-b',
			'CKT-3'
		]);
		expect(trailerRefs('Mentions CKT-12 in the middle of a sentence')).toEqual([]);
		const ok = checkSummary([{ sha: 'a'.repeat(40), itemRef: 'CKT-1', recorded: true }], []);
		expect(ok.conclusion).toBe('success');
		const warn = checkSummary(
			[
				{ sha: 'b'.repeat(40), itemRef: 'CKT-1', recorded: false },
				{ sha: 'c'.repeat(40), itemRef: null, recorded: false }
			],
			['d'.repeat(40)]
		);
		expect(warn.conclusion).toBe('neutral');
		expect(warn.summary).toMatch(/no step was recorded/);
		expect(warn.summary).toMatch(/not linked to any item/);
		expect(warn.summary).toMatch(/only warns/);
	});
});

describe.each([
	['pglite', makePglite],
	['postgres', makePostgres]
] as const)('tracking on %s', (_name, make) => {
	let db: TestDb;
	let w: World;
	const mock = createGithubMock();
	const github = createGithubApi(
		{ apiUrl: 'http://gh', appId: '1', privateKey: PKCS1 },
		mock.fetch
	);
	let n = 0;
	const agent = (
		who: 'member' | 'admin' | 'owner' | 'viewer',
		sessionId: string,
		tool = 'claude-code'
	) => ({
		...w.ctx(who, { kind: 'agent', sessionId, tool }),
		services: { github }
	});
	const person = (who: 'member' | 'admin' | 'owner' | 'viewer' = 'member') => ({
		...w.ctx(who),
		services: { github }
	});
	const newItem = (title: string, extra = {}) =>
		createItem(person(), { project: w.projectKey, title: `${title} ${++n}`, ...PLAN, ...extra });
	const newSession = async (tool = 'claude-code') =>
		(await startSession(w.ctx('member', { kind: 'agent', tool }), { tool })).sessionId;
	const sessionRow = (id: string) =>
		withTenant(
			db,
			{ orgId: w.orgId },
			async (tx) => (await tx.select().from(session).where(eq(session.id, id)))[0]
		);

	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
	}, 240_000);
	afterAll(() => db?.stop());

	it('a claim renews at most once a minute, goes idle after the allowance and is never released silently', async () => {
		const id = await newSession();
		await run(person(), (tx) =>
			tx
				.update(session)
				.set({ lastSeenAt: sql`now() - interval '10 seconds'` })
				.where(eq(session.id, id))
		);
		const before = (await sessionRow(id)).lastSeenAt.getTime();
		await run(person(), (tx) => renewSession(tx, id));
		expect((await sessionRow(id)).lastSeenAt.getTime()).toBe(before);
		await run(person(), (tx) =>
			tx
				.update(session)
				.set({ lastSeenAt: sql`now() - make_interval(secs => ${RENEW_SECONDS + 5})` })
				.where(eq(session.id, id))
		);
		await run(person(), (tx) => renewSession(tx, id));
		expect((await sessionRow(id)).lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
		expect(isIdle(new Date(Date.now() - (IDLE_MINUTES - 1) * 60_000))).toBe(false);
		expect(isIdle(new Date(Date.now() - (IDLE_MINUTES + 1) * 60_000))).toBe(true);
		// An idle claim is still a claim
		const it = await newItem('Idle claim');
		await claim(agent('member', id), id, it.ref, '1');
		await run(person(), (tx) =>
			tx
				.update(session)
				.set({ lastSeenAt: sql`now() - interval '5 hours'` })
				.where(eq(session.id, id))
		);
		expect((await sessionRow(id)).claimedItemId).toBe(it.id);
	});

	it('finishing a phase moves the claim to the next phase with an open step, and an item level claim stays item level', async () => {
		const it = await newItem('Moves');
		const phased = await newSession();
		const whole = await newSession();
		await claim(agent('member', phased), phased, it.ref, '1');
		// An item with no phases has no phase to claim: the claim is at item level and still shows the item as running
		const bare = await newItem('Bare', { phases: [], manualChecks: [] });
		await claim(agent('member', whole), whole, bare.ref);
		expect((await sessionRow(whole)).claimedPhase).toBeNull();
		expect((await sessionRow(whole)).claimedItemId).toBe(bare.id);
		const running = (await projectSummary(person(), w.projectKey)).running.find(
			(r) => r.itemRef === bare.ref
		);
		expect(running).toMatchObject({ phase: null, tool: 'claude-code' });
		const first = await recordSteps(agent('member', phased), {
			item: it.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		expect(first.claim).toEqual({ item: it.id, phase: '1', moved: false });
		const second = await recordSteps(agent('member', phased), {
			item: it.ref,
			marks: [{ key: '1.2', mark: 'done' }]
		});
		expect(second.finishedPhases).toEqual(['1']);
		expect(second.nextPhase).toBe('2');
		expect(second.claim).toEqual({ item: it.id, phase: '2', moved: true });
		expect((await sessionRow(phased)).claimedPhase).toBe('2');
		expect((await sessionRow(phased)).lastRecordAt).not.toBeNull();
		// The item level session is untouched by a record on another item
		expect((await sessionRow(whole)).claimedPhase).toBeNull();
		expect((await sessionRow(whole)).claimedItemId).toBe(bare.id);
		// Finishing the last phase leaves no phase to move to
		const last = await recordSteps(agent('member', phased), {
			item: it.ref,
			marks: [
				{ key: '2.1', mark: 'done' },
				{ key: '2.2', mark: 'done' }
			]
		});
		expect(last.nextPhase).toBeNull();
		expect(last.claim).toEqual({ item: it.id, phase: null, moved: true });
	});

	it('closing an item clears every claim on it in the same transaction, marks the sessions asked, and tells each one once', async () => {
		const it = await newItem('Closes');
		const other = await newItem('Stays open');
		const a = await newSession();
		const b = await newSession('antigravity');
		const c = await newSession();
		await claim(agent('member', a), a, it.ref, '1');
		await claim(agent('member', b, 'antigravity'), b, it.ref);
		await claim(agent('member', c), c, other.ref);
		await recordSteps(person(), {
			item: it.ref,
			marks: PLAN.phases.flatMap((p, i) =>
				p.steps.map((_, k) => ({ key: `${i + 1}.${k + 1}`, mark: 'done' as const }))
			)
		});
		await setStatus(person('owner'), {
			item: it.ref,
			status: 'COMPLETED',
			note: 'Signed off by a person'
		});
		for (const id of [a, b]) {
			const s = await sessionRow(id);
			expect(s.claimedItemId).toBeNull();
			expect(s.claimedPhase).toBeNull();
			expect(s.askedAt).not.toBeNull();
			expect(s.notices).toHaveLength(1);
		}
		// The session on another item is untouched
		expect((await sessionRow(c)).claimedItemId).toBe(other.id);
		expect((await sessionRow(c)).notices).toEqual([]);
		// Each holder hears about it in its next reply, once
		const first = await run(person(), (tx) => trackingNotes(tx, a));
		expect(first.join(' ')).toMatch(
			new RegExp(`${it.ref} was set to COMPLETED, so your claim on it was released`)
		);
		expect(await run(person(), (tx) => trackingNotes(tx, a))).toEqual([]);
		// A removed item clears claims the same way
		const gone = await newItem('Removed');
		const d = await newSession();
		await claim(agent('member', d), d, gone.ref);
		await setStatus(person('owner'), {
			item: gone.ref,
			status: 'REMOVED',
			note: 'No longer needed'
		});
		expect((await sessionRow(d)).claimedItemId).toBeNull();
	});

	it('an agent closing an item its session is not bound to is asked first, naming both, and repeats with confirmed; a person is never asked', async () => {
		await db.admin.exec(
			`update project set agents_may_complete = true where id = '${w.projectId}'`
		);
		const mine = await newItem('Mine');
		const theirs = await newItem('Theirs');
		const done = (it: { ref: string }) =>
			recordSteps(person(), {
				item: it.ref,
				marks: PLAN.phases.flatMap((p, i) =>
					p.steps.map((_, k) => ({ key: `${i + 1}.${k + 1}`, mark: 'done' as const }))
				)
			});
		await done(mine);
		await done(theirs);
		const id = await newSession();
		await claim(agent('member', id), id, mine.ref);
		// Closing another item asks, with both items named and the details an agent can show
		const ask = await setStatus(agent('member', id), {
			item: theirs.ref,
			status: 'COMPLETED',
			note: 'Done elsewhere'
		}).catch((e) => e);
		expect(ask).toMatchObject({ code: 'CONFIRM_REQUIRED' });
		expect(ask.message).toContain(mine.ref);
		expect(ask.message).toContain(theirs.ref);
		expect(ask.details).toMatchObject({ closing: { ref: theirs.ref }, bound: { ref: mine.ref } });
		const stillOpen = await run(person(), (tx) =>
			tx.select().from(session).where(eq(session.id, id))
		);
		expect(stillOpen[0].claimedItemId).toBe(mine.id);
		const confirmed = await setStatus(agent('member', id), {
			item: theirs.ref,
			status: 'COMPLETED',
			note: 'Done elsewhere',
			confirmed: true
		});
		expect(confirmed.statusChanges[0].to).toBe('COMPLETED');
		// The item it is bound to closes without a question, and the claim goes with it
		const mineClosed = await setStatus(agent('member', id), {
			item: mine.ref,
			status: 'COMPLETED',
			note: 'My own item'
		});
		expect(mineClosed.statusChanges[0].to).toBe('COMPLETED');
		expect((await sessionRow(id)).claimedItemId).toBeNull();
		// An unbound agent is asked too
		const loose = await newItem('Loose');
		await done(loose);
		const unbound = await newSession();
		const unboundAsk = await setStatus(agent('member', unbound), {
			item: loose.ref,
			status: 'COMPLETED',
			note: 'Loose end'
		}).catch((e) => e);
		expect(unboundAsk).toMatchObject({ code: 'CONFIRM_REQUIRED' });
		expect(unboundAsk.message).toContain('works on no item');
		// A person closing from the app is not asked
		const byPerson = await setStatus(person('owner'), {
			item: loose.ref,
			status: 'COMPLETED',
			note: 'A person closes'
		});
		expect(byPerson.statusChanges[0].to).toBe('COMPLETED');
		await db.admin.exec(
			`update project set agents_may_complete = false where id = '${w.projectId}'`
		);
	});

	it('evidence is checked by the server: a fake or empty commit, a wrong check run and a weak target are refused with the reason', async () => {
		const it = await newItem('Evidence', {
			phases: [
				{
					key: '1',
					title: 'Build',
					steps: [
						{ text: 'Plain step' },
						{ text: 'Needs a preview pass', requiredTarget: 'preview' },
						{ text: 'Another' }
					]
				}
			]
		});
		const other = await newItem('Other item');
		const id = await newSession();
		const ctx = () => agent('member', id);
		const refused = async (marks: Parameters<typeof recordSteps>[1]['marks'], message: RegExp) =>
			expect(recordSteps(ctx(), { item: it.ref, marks })).rejects.toMatchObject({
				code: 'INVALID',
				message: expect.stringMatching(message),
				details: expect.objectContaining({ reason: 'evidence' })
			});
		// No repository is connected, so a commit cannot be verified at all
		await refused(
			[{ key: '1.1', mark: 'done', evidence: { commit: 'abc1234def' } }],
			/no connected repository/
		);
		await refused(
			[{ key: '1.1', mark: 'done', evidence: { commit: 'not-a-hash' } }],
			/not a git hash/
		);
		await refused(
			[{ key: '1.1', mark: 'done', evidence: { target: 'preview' } }],
			/needs the checkRunId/
		);
		await refused([{ key: '1.2', mark: 'done' }], /needs a passed check run on preview/);
		await refused(
			[
				{
					key: '1.2',
					mark: 'done',
					evidence: { checkRunId: '00000000-0000-4000-8000-000000000099' }
				}
			],
			/no such check run/
		);
		// Connect a repository with a commit that changes files and one that changes none
		await db.admin.exec(
			`insert into github_installation (installation_id, org_id) values ('${INSTALL}', '${w.orgId}') on conflict do nothing`
		);
		await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx
				.insert(githubLink)
				.values({ orgId: w.orgId, projectId: w.projectId, installationId: INSTALL, repo: REPO })
				.onConflictDoNothing()
		);
		mock.seed(REPO, { private: true });
		await mock.fetch('http://gh/__mock/commit', {
			method: 'POST',
			body: JSON.stringify({
				repo: REPO,
				sha: 'a'.repeat(40),
				message: 'Real work',
				files: ['src/a.ts']
			}),
			headers: { 'content-type': 'application/json' }
		});
		await mock.fetch('http://gh/__mock/commit', {
			method: 'POST',
			body: JSON.stringify({ repo: REPO, sha: 'b'.repeat(40), message: 'Empty', files: [] }),
			headers: { 'content-type': 'application/json' }
		});
		await refused(
			[{ key: '1.1', mark: 'done', evidence: { commit: 'c'.repeat(40) } }],
			/not in the connected repository/
		);
		await refused(
			[{ key: '1.1', mark: 'done', evidence: { commit: 'b'.repeat(40) } }],
			/changes no files/
		);
		const ok = await recordSteps(ctx(), {
			item: it.ref,
			marks: [
				{
					key: '1.1',
					mark: 'done',
					evidence: { commit: 'a'.repeat(10), note: 'Verified by GitHub' }
				}
			]
		});
		expect(ok.changed).toEqual([{ key: '1.1', from: 'open', to: 'done' }]);
		// Check runs: set up a check on this item and one on another item
		const check = async (
			itemId: string,
			key: string,
			run: { target: string; result: string; commit?: string }
		) => {
			const rows = await db.admin.query<{ id: string }>(
				`insert into "check" (org_id, project_id, item_id, manual_key, script, required_target) values ('${w.orgId}', '${w.projectId}', '${itemId}', '${key}', 'x.mjs', 'preview') returning id`
			);
			const runRows = await db.admin.query<{ id: string }>(
				`insert into check_run (org_id, project_id, check_id, target, result${run.commit ? ', "commit"' : ''}) values ('${w.orgId}', '${w.projectId}', '${rows[0].id}', '${run.target}', '${run.result}'${run.commit ? `, '${run.commit}'` : ''}) returning id`
			);
			return runRows[0].id;
		};
		const failedRun = await check(it.id, 'M1', { target: 'preview', result: 'fail' });
		const devRun = await check(it.id, 'M2', { target: 'dev', result: 'pass' });
		const foreignRun = await check(other.id, 'M1', { target: 'preview', result: 'pass' });
		const goodRun = await check(it.id, 'M3', {
			target: 'deployed',
			result: 'pass',
			commit: 'a'.repeat(40)
		});
		await refused(
			[{ key: '1.2', mark: 'done', evidence: { checkRunId: failedRun } }],
			/did not pass \(fail\)/
		);
		await refused(
			[{ key: '1.2', mark: 'done', evidence: { checkRunId: devRun } }],
			/needs a pass on preview, and that run was on dev/
		);
		await refused(
			[{ key: '1.2', mark: 'done', evidence: { checkRunId: foreignRun } }],
			/belongs to another item/
		);
		await refused(
			[{ key: '1.2', mark: 'done', evidence: { checkRunId: goodRun, target: 'preview' } }],
			/ran on deployed, not preview/
		);
		await refused(
			[
				{ key: '1.2', mark: 'done', evidence: { checkRunId: goodRun, commit: 'a'.repeat(7) + 'f' } }
			],
			/different commit|not in the connected repository/
		);
		// A pass on a stronger target satisfies the requirement, on the same commit
		const good = await recordSteps(ctx(), {
			item: it.ref,
			marks: [
				{
					key: '1.2',
					mark: 'done',
					evidence: { checkRunId: goodRun, target: 'deployed', commit: 'a'.repeat(40) }
				}
			]
		});
		expect(good.changed[0].to).toBe('done');
		const stored = await withTenant(db, { orgId: w.orgId }, async (tx) =>
			(await tx.select().from(step).where(eq(step.itemId, it.id))).find((s) => s.key === '1.2')
		);
		expect(stored?.evidence).toMatchObject({ checkRunId: goodRun, target: 'deployed' });
		// A step with no evidence and no required target needs none, and waiving needs none either
		const plain = await recordSteps(ctx(), { item: it.ref, marks: [{ key: '1.3', mark: 'done' }] });
		expect(plain.changed[0].to).toBe('done');
	});

	it('a push links commits by trailer, then by claim, never by branch alone, and an unrecorded commit reaches the reply notes until a step is recorded', async () => {
		await db.admin.query(
			`update "user" set email = 'member-claims@example.com' where id = '${w.people.member}'`
		);
		const trailer = await newItem('Linked by trailer');
		const claimed = await newItem('Linked by claim');
		const id = await newSession();
		await claim(agent('member', id), id, claimed.ref, '1');
		const push = (commitsList: unknown[], ref = 'refs/heads/main') =>
			handleWebhook(
				db,
				'push',
				{
					installation: { id: INSTALL as never },
					repository: { full_name: REPO },
					ref,
					commits: commitsList as never
				},
				{ github }
			);
		const now = new Date().toISOString();
		const result = await push(
			[
				{
					id: '1'.repeat(40),
					message: `Add cards\n\nItem: ${trailer.ref}`,
					timestamp: now,
					author: { email: 'someone@example.com' },
					modified: ['src/a.ts']
				},
				{
					id: '2'.repeat(40),
					message: 'Tidy things up',
					timestamp: now,
					author: { email: 'member-claims@example.com' },
					added: ['src/b.ts']
				},
				{
					id: '3'.repeat(40),
					message: 'No item and nobody claims',
					timestamp: now,
					author: { email: 'nobody@example.com' },
					modified: ['src/c.ts']
				},
				{
					id: '4'.repeat(40),
					message: `Branch is named ${trailer.ref} but the message is not`,
					timestamp: now,
					author: { email: 'x@example.com' }
				}
			],
			`refs/heads/${trailer.ref}`
		);
		expect(result.detail).toBe('linked 2, unmatched 2');
		const rows = await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(commitLink));
		const by = (sha: string) => rows.find((r) => r.sha === sha)!;
		expect(by('1'.repeat(40))).toMatchObject({
			itemId: trailer.id,
			matchedBy: 'trailer',
			recorded: false,
			files: ['src/a.ts'],
			branch: `${trailer.ref}`
		});
		expect(by('2'.repeat(40))).toMatchObject({
			itemId: claimed.id,
			matchedBy: 'claim',
			authorEmail: 'member-claims@example.com'
		});
		expect(by('3'.repeat(40))).toMatchObject({ itemId: null, matchedBy: 'none' });
		expect(by('4'.repeat(40))).toMatchObject({ itemId: null, matchedBy: 'none' });
		// The same push again changes nothing
		expect((await push([{ id: '1'.repeat(40), message: 'Again', timestamp: now }])).detail).toBe(
			'linked 0, unmatched 0'
		);
		// The session on the claimed item is reminded in its next reply
		const notes = await run(person(), (tx) => trackingNotes(tx, id));
		expect(notes.join(' ')).toMatch(
			new RegExp(`1 commit on ${claimed.ref} has no recorded step \\(2222222\\)`)
		);
		// Recording a step marks the item's commits recorded and ends the reminder
		await recordSteps(agent('member', id), {
			item: claimed.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		expect(
			(await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(commitLink))).find(
				(r) => r.sha === '2'.repeat(40)
			)!.recorded
		).toBe(true);
		expect(await run(person(), (tx) => trackingNotes(tx, id))).toEqual([]);
		// The other item's commit is still unrecorded, and the health panel and the pull request check say so
		const health = await projectHealth(person('admin'), w.projectKey);
		expect(health.unrecordedCommits.map((c) => c.itemRef)).toContain(trailer.ref);
		expect(health.unrecordedCommits.every((c) => c.itemRef !== claimed.ref)).toBe(true);
		expect(health.unlinkedCommits).toBe(2);
		await mock.fetch('http://gh/__mock/pull', {
			method: 'POST',
			body: JSON.stringify({
				repo: REPO,
				number: 7,
				shas: ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]
			}),
			headers: { 'content-type': 'application/json' }
		});
		const pr = await handleWebhook(
			db,
			'pull_request',
			{
				action: 'opened',
				installation: { id: INSTALL as never },
				repository: { full_name: REPO },
				pull_request: { number: 7, head: { sha: '3'.repeat(40) } }
			},
			{ github }
		);
		expect(pr.detail).toBe('check neutral');
		const checks = (await (await mock.fetch('http://gh/__mock/checks')).json()) as {
			checks: { head_sha: string; conclusion: string; output: { summary: string } }[];
		};
		expect(checks.checks.at(-1)).toMatchObject({ head_sha: '3'.repeat(40), conclusion: 'neutral' });
		expect(checks.checks.at(-1)!.output.summary).toMatch(
			/1111111 belongs to .* no step was recorded/
		);
		expect(checks.checks.at(-1)!.output.summary).toMatch(/3333333 is not linked to any item/);
		// Without the App (no github dependency) a pull request event is accepted and ignored
		expect(
			(
				await handleWebhook(db, 'pull_request', {
					action: 'opened',
					installation: { id: INSTALL as never },
					repository: { full_name: REPO },
					pull_request: { number: 7, head: { sha: 'x' } }
				})
			).detail
		).toBe('ignored');
	});

	it('a quiet claim is reminded, and only a busy session that recorded nothing for a while', async () => {
		const it = await newItem('Quiet');
		const id = await newSession();
		await claim(agent('member', id), id, it.ref, '1');
		const now = new Date();
		expect(await run(person(), (tx) => trackingNotes(tx, id, now))).toEqual([]);
		const later = new Date(now.getTime() + (QUIET_RECORD_MINUTES + 5) * 60_000);
		const notes = await run(person(), (tx) => trackingNotes(tx, id, later));
		expect(notes.join(' ')).toMatch(
			new RegExp(`You claimed ${it.ref} .* and recorded nothing since`)
		);
		// Recording resets the clock
		await recordSteps(agent('member', id), { item: it.ref, marks: [{ key: '1.1', mark: 'done' }] });
		expect(await run(person(), (tx) => trackingNotes(tx, id, new Date()))).toEqual([]);
	});

	it('hooks: the brief, the session by the tool id, the title once, code changes, the close question and one stop reminder per change', async () => {
		const it = await newItem('Hooked');
		const input = (event: string, extra: Record<string, unknown> = {}) => ({
			tool: 'claude-code' as const,
			externalId: 'conversation-0001',
			event: event as never,
			...extra
		});
		const ctx = () => w.ctx('member', { kind: 'agent', tool: 'claude-code' });
		// Start: a brief that names open items, no title until something is claimed
		const start = await handleHook(ctx(), input('start'));
		expect(start.context).toContain(it.ref);
		expect(start.context).toContain('work_start');
		expect(start.title).toBeUndefined();
		// The same tool id is the same session
		const rows = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(session).where(eq(session.externalId, 'conversation-0001'))
		);
		expect(rows).toHaveLength(1);
		await handleHook(ctx(), input('start'));
		expect(
			(
				await withTenant(db, { orgId: w.orgId }, (tx) =>
					tx.select().from(session).where(eq(session.externalId, 'conversation-0001'))
				)
			).length
		).toBe(1);
		// Claim through the same session (as an MCP call would) and the title comes once
		await claim(agent('member', rows[0].id), rows[0].id, it.ref, '1');
		const first = await handleHook(ctx(), input('prompt'));
		expect(first.title).toMatch(new RegExp(`^HOOKED_\\d+: ${it.ref}$`));
		expect(await handleHook(ctx(), input('prompt'))).toEqual({});
		// A stop with no code change says nothing
		expect(await handleHook(ctx(), input('stop'))).toEqual({});
		// Docs, subagent and failed calls do not count; code does, and so does a commit from the shell
		await handleHook(ctx(), input('tool', { action: { kind: 'edit', file: 'docs/readme.ts' } }));
		await handleHook(
			ctx(),
			input('tool', { subagent: true, action: { kind: 'edit', file: 'src/a.ts' } })
		);
		await handleHook(
			ctx(),
			input('tool', { failed: true, action: { kind: 'edit', file: 'src/a.ts' } })
		);
		expect((await sessionRow(rows[0].id)).codeTouchedAt).toBeNull();
		await handleHook(ctx(), input('tool', { action: { kind: 'edit', file: 'src/a.ts' } }));
		expect((await sessionRow(rows[0].id)).codeTouchedAt).not.toBeNull();
		// The Stop reminder comes once for this change, never when the tool says it is already continuing
		expect(await handleHook(ctx(), input('stop', { stopActive: true }))).toEqual({});
		const block = await handleHook(ctx(), input('stop'));
		expect(block.block).toContain(`Code changed after the last record on ${it.ref}`);
		expect(await handleHook(ctx(), input('stop'))).toEqual({});
		// New code after the reminder earns one more, unless a step was recorded after it
		await new Promise((r) => setTimeout(r, 15));
		await handleHook(
			ctx(),
			input('tool', { action: { kind: 'shell', command: 'git commit -m "x"' } })
		);
		await recordSteps(agent('member', rows[0].id), {
			item: it.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		expect(await handleHook(ctx(), input('stop'))).toEqual({});
		// An unbound session that changed code is asked once to bind
		const loose = input('tool', { action: { kind: 'edit', file: 'lib/x.py' } });
		const l = { ...loose, externalId: 'conversation-unbound' };
		await handleHook(ctx(), { ...l, event: 'start' });
		await handleHook(ctx(), l);
		const ask = await handleHook(ctx(), { ...l, event: 'stop' });
		expect(ask.block).toMatch(/works on no item/);
		expect(await handleHook(ctx(), { ...l, event: 'stop' })).toEqual({});
		// The close question names both items, only for a session bound to another one
		const target = await newItem('Close target');
		const closing = [{ item: target.ref, status: 'COMPLETED' }];
		const q = await handleHook(ctx(), input('closing', { closing }));
		expect(q.ask).toContain(it.ref);
		expect(q.ask).toContain(target.ref);
		expect(
			await handleHook(
				ctx(),
				input('closing', { closing: [{ item: it.ref, status: 'COMPLETED' }] })
			)
		).toEqual({});
		expect(
			await handleHook(
				ctx(),
				input('closing', { closing: [{ item: target.ref, status: 'IN REVIEW' }] })
			)
		).toEqual({});
		expect(
			await handleHook(
				ctx(),
				input('closing', { closing: [{ item: 'NOPE-1', status: 'REMOVED' }] })
			)
		).toEqual({});
		// Other tools get their own sessions, and a bad event is refused before it does anything
		await handleHook(w.ctx('member', { kind: 'agent', tool: 'antigravity' }), {
			...input('start'),
			tool: 'antigravity',
			externalId: 'agy-conversation-1'
		});
		await expect(handleHook(ctx(), { ...input('start'), externalId: 'x' })).rejects.toThrow();
	});

	it('the health panel lists what needs attention, hides private items from people who may not see them, and shows failures to admins only', async () => {
		const quiet = await newItem('Quiet and old');
		await recordSteps(person(), { item: quiet.ref, marks: [{ key: '1.1', mark: 'done' }] });
		await db.admin.exec(
			`update item set last_activity_at = now() - interval '10 days' where id = '${quiet.id}'`
		);
		const secret = await createItem(person('owner'), {
			project: w.projectKey,
			title: 'Private and quiet',
			visibility: 'private',
			...PLAN
		});
		await recordSteps(person('owner'), { item: secret.ref, marks: [{ key: '1.1', mark: 'done' }] });
		await db.admin.exec(
			`update item set last_activity_at = now() - interval '10 days' where id = '${secret.id}'`
		);
		const stale = await newItem('Stale claim');
		const id = await newSession();
		await claim(agent('member', id), id, stale.ref, '1');
		await db.admin.exec(
			`update session set last_seen_at = now() - interval '5 hours' where id = '${id}'`
		);
		await db.admin.exec(
			`insert into commit_link (org_id, project_id, item_id, sha, repo, message, matched_by, recorded, files) values ('${w.orgId}', '${w.projectId}', '${secret.id}', '${'9'.repeat(40)}', '${REPO}', 'A private commit', 'trailer', false, '["a.ts"]')`
		);
		await db.admin.exec(
			`update step set required_target = 'preview' where item_id = '${quiet.id}' and key = '1.1'`
		);
		await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx
				.update(githubLink)
				.set({ failures: 3, pausedReason: 'Publishing failed 3 times in a row.' })
				.where(eq(githubLink.projectId, w.projectId))
		);
		// A review with a step still open is drift, and says so
		const review = await newItem('Review with an open step');
		await recordSteps(person(), { item: review.ref, marks: [{ key: '1.1', mark: 'done' }] });
		await setStatus(person('owner'), {
			item: review.ref,
			status: 'IN REVIEW',
			note: 'Moved to review early'
		});
		const admin = await projectHealth(
			{ ...person('admin'), services: { github, backups: true } },
			w.projectKey
		);
		expect(admin.quietItems.map((q) => q.ref)).toContain(quiet.ref);
		// Not even an admin sees a private item somebody else made
		expect(admin.quietItems.map((q) => q.ref)).not.toContain(secret.ref);
		expect(admin.staleClaims.find((c) => c.itemRef === stale.ref)).toMatchObject({
			tool: 'claude-code',
			phase: '1'
		});
		expect(
			admin.stepsWithoutEvidence.some((s) => s.itemRef === quiet.ref && s.target === 'preview')
		).toBe(true);
		expect(admin.unrecordedCommits.some((c) => c.itemRef === secret.ref)).toBe(false);
		// Its maker still sees it on the panel
		const maker = await projectHealth(person('owner'), w.projectKey);
		expect(maker.quietItems.map((q) => q.ref)).toContain(secret.ref);
		expect(maker.unrecordedCommits.some((c) => c.itemRef === secret.ref)).toBe(true);
		expect(admin.drift.find((d) => d.ref === review.ref)?.codes).toContain(
			'in-review-with-open-steps'
		);
		expect(admin.publish?.pausedReason).toMatch(/3 times in a row/);
		expect(admin.backup?.ok).toBe(false);
		// A member sees the public items only, and neither the publish nor the backup state
		const member = await projectHealth(person('member'), w.projectKey);
		expect(member.quietItems.map((q) => q.ref)).toContain(quiet.ref);
		expect(member.quietItems.map((q) => q.ref)).not.toContain(secret.ref);
		expect(member.unrecordedCommits.some((c) => c.itemRef === secret.ref)).toBe(false);
		expect(member.publish).toBeNull();
		expect(member.backup).toBeNull();
		// A closed item with a claim is flagged (a claim on a closed item should not survive, so it is made by hand here)
		await db.admin.exec(`update item set status = 'ON HOLD' where id = '${stale.id}'`);
		await db.admin.exec(
			`update github_installation set account = 'x' where installation_id = '${INSTALL}'`
		);
		expect(
			await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(githubInstallation))
		).toHaveLength(1);
		await updateItem(person('owner'), { item: quiet.ref, title: 'Quiet and old, renamed' });
	});

	it('turning an item private releases the claims of other people and tells their sessions', async () => {
		const it = await newItem('Claimed then made private');
		// An owner's session, not the maker's, works on the item
		const id = (
			await startSession(w.ctx('owner', { kind: 'agent', tool: 'claude-code' }), {
				tool: 'claude-code'
			})
		).sessionId;
		await claim(agent('owner', id), id, it.ref, '1');
		expect((await sessionRow(id)).claimedItemId).toBe(it.id);
		await updateItem(person('member'), { item: it.ref, visibility: 'private' });
		const after = await sessionRow(id);
		expect(after.claimedItemId).toBeNull();
		expect(JSON.stringify(after.notices)).toMatch(/made private by its creator/);
	});
});
