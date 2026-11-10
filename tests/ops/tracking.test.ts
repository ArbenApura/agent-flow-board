// PHASE 9: SESSION CLAIMS, EVIDENCE, CLOSE HANDLING, HOOK LOGIC, REMINDERS AND HEALTH

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { claim, startSession } from '../../src/lib/server/mcp/sessions';
import { session, step } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { run } from '../../src/lib/server/ops/context';
import { canonicalTool } from '../../src/lib/shared/tool';
import { handleHook } from '../../src/lib/server/ops/hooks';
import { projectSummary } from '../../src/lib/server/ops/board';
import { projectHealth } from '../../src/lib/server/ops/health';
import { listSessionEvents } from '../../src/lib/server/ops/sessionEvents';
import { createItem, updateItem } from '../../src/lib/server/ops/items';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { setStatus } from '../../src/lib/server/ops/status';
import {
	RUNNING_WINDOW_MINUTES,
	nudgeLevel,
	QUIET_RECORD_MINUTES,
	RENEW_SECONDS,
	isIdle,
	renewSession,
	trackingNotes
} from '../../src/lib/server/ops/tracking';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';
import { isCodeFile, commits } from '../../src/lib/shared/code';

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
});

describe('nudge levels', () => {
	const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
	it('rise with every 3 edits and every 5 minutes, and never go down', () => {
		expect(nudgeLevel(0, null)).toBe(0);
		expect(nudgeLevel(2, at(2))).toBe(0);
		expect(nudgeLevel(3, at(2))).toBe(1);
		expect(nudgeLevel(6, at(2))).toBe(2);
		// A slow start does not use up the 3 edit nudge: 5 minutes is level 1, 10 is level 2
		expect(nudgeLevel(1, at(6))).toBe(1);
		expect(nudgeLevel(3, at(6))).toBe(1);
		expect(nudgeLevel(4, at(11))).toBe(2);
	});
});

describe('tracking', () => {
	const make = makePostgres;
	let db: TestDb;
	let w: World;
	let n = 0;
	const agent = (
		who: 'member' | 'admin' | 'owner' | 'viewer',
		sessionId: string,
		tool = 'claude-code'
	) => w.ctx(who, { kind: 'agent', sessionId, tool });
	const person = (who: 'member' | 'admin' | 'owner' | 'viewer' = 'member') => w.ctx(who);
	const newItem = (title: string, extra = {}) =>
		createItem(person(), { project: w.projectKey, title: `${title} ${++n}`, ...PLAN, ...extra });
	// An item on a fixed minute of its own, so a test that needs several does not use up the suffixes of the current minute
	const newItemAt = (title: string, minute: number) =>
		createItem(
			person(),
			{ project: w.projectKey, title: `${title} ${++n}`, ...PLAN },
			{ now: new Date(Date.UTC(2026, 0, 1, 3, minute)) }
		);
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
		expect(isIdle(new Date(Date.now() - (RUNNING_WINDOW_MINUTES - 1) * 60_000))).toBe(false);
		expect(isIdle(new Date(Date.now() - (RUNNING_WINDOW_MINUTES + 1) * 60_000))).toBe(true);
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
		// A commit is plain text: it must look like a git hash, and nothing asks a repository about it
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
		const ok = await recordSteps(ctx(), {
			item: it.ref,
			marks: [
				{
					key: '1.1',
					mark: 'done',
					evidence: { commit: 'a'.repeat(10), note: 'Checked by hand' }
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
			/different commit/
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
		// Docs and failed calls do not count; code does, and so does a commit from the shell
		await handleHook(ctx(), input('tool', { action: { kind: 'edit', file: 'docs/readme.ts' } }));
		await handleHook(
			ctx(),
			input('tool', { failed: true, action: { kind: 'edit', file: 'src/a.ts' } })
		);
		expect((await sessionRow(rows[0].id)).codeTouchedAt).toBeNull();
		// A subagent's edit counts for the session but never sends a nudge
		for (let i = 0; i < 7; i++)
			expect(
				await handleHook(
					ctx(),
					input('tool', { subagent: true, action: { kind: 'edit', file: 'src/a.ts' } })
				)
			).toEqual({});
		expect(await sessionRow(rows[0].id)).toMatchObject({ codeEditsSinceRecord: 7 });
		expect((await sessionRow(rows[0].id)).codeTouchedAt).not.toBeNull();
		// The Stop reminder comes once for this change, never when the tool says it is already continuing
		expect(await handleHook(ctx(), input('stop', { stopActive: true }))).toEqual({});
		const block = await handleHook(ctx(), input('stop'));
		expect(block.block).toContain(`Code changed after the last record on ${it.ref}`);
		// The reminder names the steps still open in the claimed phase
		expect(block.block).toContain('Steps still open: 1.1');
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
		// A step was recorded after the code, so there is no unrecorded work; the open steps get their one reminder instead
		expect((await handleHook(ctx(), input('stop'))).block).toContain('still has open steps');
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

	it('stop guard: a release answers the item question, and open steps get one reminder per record', async () => {
		const hookCtx = () => w.ctx('member', { kind: 'agent', tool: 'claude-code' });
		const stopOf = (externalId: string) =>
			handleHook(hookCtx(), { tool: 'claude-code', externalId, event: 'stop' });
		const start = async (externalId: string) => {
			await handleHook(hookCtx(), { tool: 'claude-code', externalId, event: 'start' });
			const [row] = await withTenant(db, { orgId: w.orgId }, (tx) =>
				tx.select().from(session).where(eq(session.externalId, externalId))
			);
			return row.id;
		};
		const edit = (externalId: string) =>
			handleHook(hookCtx(), {
				tool: 'claude-code',
				externalId,
				event: 'tool',
				action: { kind: 'edit', file: 'src/z.ts' }
			});

		// Work_stop after edits: the Stop hook has nothing to ask
		const done = await newItemAt('Released', 1);
		const idA = await start('stop-guard-conversation-a');
		await claim(agent('member', idA), idA, done.ref, '1');
		await edit('stop-guard-conversation-a');
		await claim(agent('member', idA), idA, null);
		expect(await stopOf('stop-guard-conversation-a')).toEqual({});

		// A session that recorded one step and holds an item with open steps is reminded once, and again only after the next record
		const busy = await newItemAt('Open steps', 2);
		const idB = await start('stop-guard-conversation-b');
		await claim(agent('member', idB), idB, busy.ref, '1');
		expect(await stopOf('stop-guard-conversation-b')).toEqual({});
		await recordSteps(agent('member', idB), {
			item: busy.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		const reminder = await stopOf('stop-guard-conversation-b');
		expect(reminder.block).toContain(busy.ref);
		expect(reminder.block).toContain('1.2');
		expect(await stopOf('stop-guard-conversation-b')).toEqual({});
		await new Promise((r) => setTimeout(r, 15));
		await recordSteps(agent('member', idB), {
			item: busy.ref,
			marks: [{ key: '1.2', mark: 'done' }]
		});
		expect((await stopOf('stop-guard-conversation-b')).block).toContain('2.1');

		// A session made by the hooks is the same session for the MCP calls of the same person, even with another token
		const idC = await start('stop-guard-conversation-c');
		await expect(
			claim(
				w.ctx('member', {
					kind: 'agent',
					tool: 'claude-code',
					tokenId: '00000000-0000-4000-8000-0000000000c1'
				}),
				idC,
				busy.ref,
				'2'
			)
		).resolves.toBeDefined();
	});

	it('claims, releases, reminders and session ends are logged, and the history gives the claim minutes', async () => {
		const it = await newItemAt('Logged claim', 3);
		const id = await newSession();
		await claim(agent('member', id), id, it.ref, '1');
		// Pretend the claim began 25 minutes ago so the duration is visible
		await db.admin.query(
			`update session_event set created_at = now() - interval '25 minutes' where session_id = $1`,
			[id]
		);
		await claim(agent('member', id), id, null);
		const history = await listSessionEvents(person(), { item: it.ref });
		expect(history.events.map((e) => e.kind)).toEqual(['claim', 'release']);
		expect(history.events[0]).toMatchObject({ sessionId: id, detail: 'phase 1', minutes: null });
		expect(history.events[1]).toMatchObject({ detail: 'work_stop' });
		expect(history.events[1].minutes).toBeGreaterThanOrEqual(24);
		// The same item claimed again by the same session is one more claim, and a move off it is a release
		const other = await newItemAt('Moved to', 4);
		await claim(agent('member', id), id, it.ref, '1');
		await claim(agent('member', id), id, other.ref, '1');
		const again = await listSessionEvents(person(), { item: it.ref });
		expect(again.events.map((e) => e.kind)).toEqual(['claim', 'release', 'claim', 'release']);
		expect(again.events[3].detail).toBe('moved to another item');
	});

	it('progress first: a nudge at 3 edits, once per level, from the time rule too, and reset by a recorded step of any session', async () => {
		const hookCtx = () => w.ctx('member', { kind: 'agent', tool: 'claude-code' });
		const hookSession = async (externalId: string, itemRef: string | null) => {
			await handleHook(hookCtx(), { tool: 'claude-code', externalId, event: 'start' });
			const [row] = await withTenant(db, { orgId: w.orgId }, (tx) =>
				tx.select().from(session).where(eq(session.externalId, externalId))
			);
			if (itemRef) await claim(agent('member', row.id), row.id, itemRef, '1');
			return row.id;
		};
		const edit = (externalId: string) =>
			handleHook(hookCtx(), {
				tool: 'claude-code',
				externalId,
				event: 'tool',
				action: { kind: 'edit', file: 'src/a.ts' }
			});
		const it = await newItem('Nudged');
		const idA = await hookSession('nudge-conversation-a', it.ref);
		// Two edits say nothing, the third nudges, and the next two stay quiet
		for (let i = 0; i < 2; i++) expect(await edit('nudge-conversation-a')).toEqual({});
		const third = await edit('nudge-conversation-a');
		expect(third.nudge).toContain(it.ref);
		expect(third.nudge).toContain('3 code edits');
		// The nudge names the steps to record
		expect(third.nudge).toContain('Steps still open: 1.1');
		for (let i = 0; i < 2; i++) expect(await edit('nudge-conversation-a')).toEqual({});
		// Every further 3 edits earn one more level
		expect((await edit('nudge-conversation-a')).nudge).toContain('6 code edits');
		// The reply line of a board tool says it too, and does not consume anything
		const notes = await run(person(), (tx) => trackingNotes(tx, idA, new Date()));
		expect(notes.join(' ')).toContain(`6 code edits on ${it.ref} since the last step_done`);
		expect(await run(person(), (tx) => trackingNotes(tx, idA, new Date()))).toEqual(notes);
		// A step recorded by another session of the same item clears this session's count
		const idB = await newSession('antigravity');
		await claim(agent('member', idB, 'antigravity'), idB, it.ref, '1');
		await recordSteps(agent('member', idB, 'antigravity'), {
			item: it.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		const cleared = await sessionRow(idA);
		expect(cleared).toMatchObject({ codeEditsSinceRecord: 0, nudgedLevel: 0 });
		expect(cleared.firstUnrecordedEditAt).toBeNull();
		expect(await run(person(), (tx) => trackingNotes(tx, idA, new Date()))).toEqual([]);

		// A progress log line with no step change is a record too: it clears the count and the Not recorded badge, as the Stop hook says it may
		await edit('nudge-conversation-a');
		await edit('nudge-conversation-a');
		expect((await sessionRow(idA)).codeEditsSinceRecord).toBe(2);
		expect((await sessionRow(idA)).firstUnrecordedEditAt).not.toBeNull();
		await recordSteps(agent('member', idB, 'antigravity'), {
			item: it.ref,
			log: 'Built the sign in and checked it locally.'
		});
		const logged = await sessionRow(idA);
		expect(logged).toMatchObject({ codeEditsSinceRecord: 0, nudgedLevel: 0 });
		expect(logged.firstUnrecordedEditAt).toBeNull();

		// The time rule: one edit, 11 minutes after the first unrecorded one
		const timed = it;
		const idT = await hookSession('nudge-conversation-t', timed.ref);
		expect(await edit('nudge-conversation-t')).toEqual({});
		await db.admin.exec(
			`update session set first_unrecorded_edit_at = now() - interval '11 minutes' where id = '${idT}'`
		);
		expect((await edit('nudge-conversation-t')).nudge).toContain(timed.ref);

		// A new prompt repeats the reminder while edits are unrecorded, whatever the edit count, and does not consume it
		await hookSession('nudge-conversation-q', it.ref);
		const prompt = (externalId: string) =>
			handleHook(hookCtx(), { tool: 'claude-code', externalId, event: 'prompt' });
		expect((await prompt('nudge-conversation-q')).nudge).toBeUndefined();
		await edit('nudge-conversation-q');
		expect((await prompt('nudge-conversation-q')).nudge).toContain('1 code edit on');
		expect((await prompt('nudge-conversation-q')).nudge).toContain('Steps still open');

		// No claim and no open step mean no nudge
		await hookSession('nudge-conversation-n', null);
		for (let i = 0; i < 7; i++) expect((await edit('nudge-conversation-n')).nudge).toBeUndefined();
		const bare = await newItem('No open steps', { phases: [], manualChecks: [] });
		await hookSession('nudge-conversation-b', bare.ref);
		for (let i = 0; i < 7; i++) expect((await edit('nudge-conversation-b')).nudge).toBeUndefined();

		// Edits made for one item are not charged to the next one
		const first = it;
		const second = bare;
		const idM = await hookSession('nudge-conversation-m', first.ref);
		for (let i = 0; i < 3; i++) await edit('nudge-conversation-m');
		expect((await sessionRow(idM)).codeEditsSinceRecord).toBe(3);
		await claim(agent('member', idM), idM, second.ref, '1');
		expect(await sessionRow(idM)).toMatchObject({ codeEditsSinceRecord: 0, nudgedLevel: 0 });

		// A subagent's edits send no nudge themselves, and the main agent hears it on its next call of any kind, once
		const idS = await hookSession('nudge-conversation-s', it.ref);
		for (let i = 0; i < 4; i++)
			expect(
				await handleHook(hookCtx(), {
					tool: 'claude-code',
					externalId: 'nudge-conversation-s',
					event: 'tool',
					subagent: true,
					action: { kind: 'edit', file: 'src/a.ts' }
				})
			).toEqual({});
		const read = () =>
			handleHook(hookCtx(), {
				tool: 'claude-code',
				externalId: 'nudge-conversation-s',
				event: 'tool',
				action: { kind: 'read' }
			});
		expect((await read()).nudge).toContain('4 code edits');
		expect(await read()).toEqual({});
		// A commit is a code change for the Stop reminder, never an unrecorded edit
		const beforeCommit = await sessionRow(idS);
		await handleHook(hookCtx(), {
			tool: 'claude-code',
			externalId: 'nudge-conversation-s',
			event: 'tool',
			action: { kind: 'shell', command: 'git commit -m "x"' }
		});
		expect((await sessionRow(idS)).codeEditsSinceRecord).toBe(beforeCommit.codeEditsSinceRecord);
		// On a clean session a commit touches the code time and starts no unrecorded clock
		const idK = await hookSession('nudge-conversation-k', it.ref);
		await handleHook(hookCtx(), {
			tool: 'claude-code',
			externalId: 'nudge-conversation-k',
			event: 'tool',
			action: { kind: 'shell', command: 'git commit -m "x"' }
		});
		const committed = await sessionRow(idK);
		expect(committed.codeTouchedAt).not.toBeNull();
		expect(committed).toMatchObject({ codeEditsSinceRecord: 0, firstUnrecordedEditAt: null });
		// After one reminder, a turn that ends while the tool is already continuing says nothing more, but it is noted when
		// later edits are unrecorded, so the badge sees the work that was left
		const stopK = (stopActive: boolean) =>
			handleHook(hookCtx(), {
				tool: 'claude-code',
				externalId: 'nudge-conversation-k',
				event: 'stop',
				stopActive
			});
		await edit('nudge-conversation-k');
		expect(await stopK(true)).toEqual({});
		expect((await sessionRow(idK)).remindedAt).toBeNull();
		expect((await stopK(false)).block).toContain('Code changed after the last record');
		const reminded = (await sessionRow(idK)).remindedAt!;
		await new Promise((r) => setTimeout(r, 15));
		await edit('nudge-conversation-k');
		expect(await stopK(true)).toEqual({});
		expect((await sessionRow(idK)).remindedAt!.getTime()).toBeGreaterThan(reminded.getTime());

		// Two edits at once count twice
		const idP = await hookSession('nudge-conversation-p', it.ref);
		await Promise.all([edit('nudge-conversation-p'), edit('nudge-conversation-p')]);
		expect((await sessionRow(idP)).codeEditsSinceRecord).toBe(2);

		// With no step open in the claimed phase the Stop reminder says to release the claim
		const idE = await hookSession('end-conversation-e', bare.ref);
		await edit('end-conversation-e');
		const stop = await handleHook(hookCtx(), {
			tool: 'claude-code',
			externalId: 'end-conversation-e',
			event: 'stop'
		});
		expect(stop.block).toContain('work_stop');
		// The end of a conversation lets go of its own claim only, and never makes a session
		// Another person's hook session with the very same conversation id keeps its claim
		const adminCtx = w.ctx('admin', { kind: 'agent', tool: 'claude-code' });
		await handleHook(adminCtx, {
			tool: 'claude-code',
			externalId: 'end-conversation-e',
			event: 'start'
		});
		const adminId = (
			await withTenant(db, { orgId: w.orgId }, (tx) =>
				tx.select().from(session).where(eq(session.externalId, 'end-conversation-e'))
			)
		).find((r) => r.userId === adminCtx.actor.userId)!.id;
		await claim(agent('admin', adminId), adminId, bare.ref);
		const before = await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(session));
		const end = (externalId: string) =>
			handleHook(hookCtx(), { tool: 'claude-code', externalId, event: 'end' });
		expect(await end('end-conversation-unknown')).toEqual({});
		expect(
			(await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(session))).length
		).toBe(before.length);
		expect(await end('end-conversation-e')).toEqual({});
		expect((await sessionRow(idE)).claimedItemId).toBeNull();
		expect((await sessionRow(adminId)).claimedItemId).toBe(bare.id);
	});

	it('the running badge carries a stale flag only while an open step and old unrecorded edits exist, and the last step says to review and release', async () => {
		const it = await newItem('Stale flag');
		const id = await newSession();
		await claim(agent('member', id), id, it.ref, '1');
		const flag = async () =>
			(await projectSummary(person(), w.projectKey)).running.find((r) => r.itemRef === it.ref)
				?.staleMinutes;
		expect(await flag()).toBeNull();
		await db.admin.exec(
			`update session set code_edits_since_record = 2, first_unrecorded_edit_at = now() - interval '4 minutes' where id = '${id}'`
		);
		expect(await flag()).toBeNull();
		// A session that is still working shows no flag, however long its step takes (AFB-20261110-1448)
		await db.admin.exec(
			`update session set first_unrecorded_edit_at = now() - interval '14 minutes', last_seen_at = now() where id = '${id}'`
		);
		expect(await flag()).toBeNull();
		// A Stop reminder from before these edits does not count, and one just given leaves the grace time to record
		await db.admin.exec(
			`update session set reminded_at = now() - interval '20 minutes' where id = '${id}'`
		);
		expect(await flag()).toBeNull();
		await db.admin.exec(`update session set reminded_at = now() where id = '${id}'`);
		expect(await flag()).toBeNull();
		// The turn ended on the reminder and nothing was recorded: the work was left unrecorded
		await db.admin.exec(
			`update session set reminded_at = now() - interval '3 minutes' where id = '${id}'`
		);
		expect(await flag()).toBeGreaterThanOrEqual(13);
		// A session that edited a moment ago is working again, so the flag waits
		await db.admin.exec(`update session set code_touched_at = now() where id = '${id}'`);
		expect(await flag()).toBeNull();
		await db.admin.exec(
			`update session set code_touched_at = now() - interval '3 minutes' where id = '${id}'`
		);
		expect(await flag()).toBeGreaterThanOrEqual(13);
		// Open steps of another phase only do not mark a session whose own phase is finished
		await db.admin.exec(`update session set claimed_phase = '9' where id = '${id}'`);
		expect(await flag()).toBeNull();
		await db.admin.exec(`update session set claimed_phase = '1' where id = '${id}'`);
		// A session that went quiet with unrecorded edits is marked without any reminder
		await db.admin.exec(
			`update session set reminded_at = null, last_seen_at = now() - interval '11 minutes' where id = '${id}'`
		);
		expect(await flag()).toBeGreaterThanOrEqual(13);
		// The session is back: the rest of this test runs on a live one, marked by its ended turn
		await db.admin.exec(
			`update session set last_seen_at = now(), reminded_at = now() - interval '3 minutes' where id = '${id}'`
		);
		// The health panel lists it as unrecorded work
		const health = await projectHealth(person('admin'), w.projectKey);
		expect(health.staleClaims.find((c) => c.itemRef === it.ref)).toMatchObject({
			kind: 'unrecorded'
		});
		// A recorded step clears it
		const part = await recordSteps(agent('member', id), {
			item: it.ref,
			marks: [{ key: '1.1', mark: 'done' }]
		});
		expect(await flag()).toBeNull();
		// The last recorded step says to run the review and release the claim; the claim stays for the review
		expect(part).not.toHaveProperty('reminder');
		const all = await recordSteps(agent('member', id), {
			item: it.ref,
			marks: [
				{ key: '1.2', mark: 'done' },
				{ key: '2.1', mark: 'done' },
				{ key: '2.2', mark: 'done' }
			]
		});
		expect(all.status).toBe('IN REVIEW');
		expect((all as { reminder?: string }).reminder).toMatch(/work_stop/);
		expect((await sessionRow(id)).claimedItemId).toBe(it.id);
		// A quiet finished item shows idle, not running
		const idle = async () =>
			(await projectSummary(person(), w.projectKey)).running.find((r) => r.itemRef === it.ref)
				?.reviewIdle;
		expect(await idle()).toBe(false);
		await db.admin.exec(
			`update session set last_seen_at = now() - interval '11 minutes' where id = '${id}'`
		);
		expect(await idle()).toBe(true);
	});

	it('one tab shows one running badge: tool names are one family, a phase badge replaces the item badge, and a live parallel conversation keeps its claim', async () => {
		const running = async (ref: string) =>
			(await projectSummary(person(), w.projectKey)).running.filter((r) => r.itemRef === ref);
		// A hook session says claude-code, an MCP session says Claude Code: one person, one tool, one badge
		const it = await newItem('One badge');
		const hookRow = await newSession('claude-code');
		const mcpRow = await newSession('Claude Code');
		// The phase claim comes first and the newer item level claim must not replace it
		await claim(agent('member', mcpRow, 'Claude Code'), mcpRow, it.ref, '1');
		await claim(agent('member', hookRow), hookRow, it.ref);
		const badges = await running(it.ref);
		expect(badges).toHaveLength(1);
		// The row says how old the claim is
		expect(badges[0]).toMatchObject({
			startedAt: expect.anything(),
			lastSeenAt: expect.anything()
		});
		// The phase level badge replaces the item level one
		expect(badges[0].phase).toBe('1');
		// The badge keeps the name the tool gave it
		expect(canonicalTool(badges[0].tool)).toBe('claude-code');
		// Another tool of the same person is another tab and keeps its own badge
		const other = await newSession('antigravity');
		await claim(agent('member', other, 'antigravity'), other, it.ref, '1');
		expect((await running(it.ref)).map((r) => canonicalTool(r.tool)).sort()).toEqual([
			'antigravity',
			'claude-code'
		]);
		// Two different people on one item and tool stay two badges
		const admin = (
			await startSession(w.ctx('admin', { kind: 'agent', tool: 'claude-code' }), {
				tool: 'claude-code'
			})
		).sessionId;
		await claim(agent('admin', admin), admin, it.ref, '1');
		expect(
			(await running(it.ref)).filter((r) => canonicalTool(r.tool) === 'claude-code')
		).toHaveLength(2);
		// Two live conversations of one person and tool on one item both keep their claim, and show one badge
		const live = await newItem('Parallel conversations');
		const first = await newSession('claude-code');
		const second = await newSession('claude-code');
		await claim(agent('member', first), first, live.ref, '1');
		await claim(agent('member', second), second, live.ref, '1');
		expect((await sessionRow(first)).claimedItemId).toBe(live.id);
		expect((await sessionRow(second)).claimedItemId).toBe(live.id);
		expect(await running(live.ref)).toHaveLength(1);
		// A conversation that went quiet for over 10 minutes lets go when another one claims the item
		const third = await newSession('claude-code');
		await db.admin.exec(
			`update session set last_seen_at = now() - interval '11 minutes' where id = '${first}'`
		);
		await claim(agent('member', third), third, live.ref, '1');
		expect((await sessionRow(first)).claimedItemId).toBeNull();
		expect((await sessionRow(second)).claimedItemId).toBe(live.id);
		// A claim nobody released stops counting as running after the one shared limit
		await db.admin.exec(
			`update session set last_seen_at = now() - interval '121 minutes' where id in ('${second}', '${third}')`
		);
		expect(await running(live.ref)).toHaveLength(0);
		// The badge and the health panel agree on the one limit: at 100 minutes running and not idle, at 125 idle and not running
		const stale = async () =>
			(await projectHealth(person('admin'), w.projectKey)).staleClaims.filter(
				(c) => c.itemRef === live.ref && c.kind === 'idle'
			);
		expect(await stale()).toHaveLength(2);
		await db.admin.exec(
			`update session set last_seen_at = now() - interval '100 minutes' where id in ('${second}', '${third}')`
		);
		expect(await running(live.ref)).toHaveLength(1);
		expect(await stale()).toHaveLength(0);
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
			`update step set required_target = 'preview' where item_id = '${quiet.id}' and key = '1.1'`
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
			{ ...person('admin'), services: { backups: true } },
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
		// Its maker still sees it on the panel
		const maker = await projectHealth(person('owner'), w.projectKey);
		expect(maker.quietItems.map((q) => q.ref)).toContain(secret.ref);
		expect(admin.drift.find((d) => d.ref === review.ref)?.codes).toContain(
			'in-review-with-open-steps'
		);
		expect(admin.backup?.ok).toBe(false);
		// A member sees the public items only, and not the backup state
		const member = await projectHealth(person('member'), w.projectKey);
		expect(member.quietItems.map((q) => q.ref)).toContain(quiet.ref);
		expect(member.quietItems.map((q) => q.ref)).not.toContain(secret.ref);
		expect(member.backup).toBeNull();
		// A closed item with a claim is flagged (a claim on a closed item should not survive, so it is made by hand here)
		await db.admin.exec(`update item set status = 'ON HOLD' where id = '${stale.id}'`);
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
