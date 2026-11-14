// THE READ ONLY SESSION STATUS LOOKUP: WHICH ITEM IS THE CONVERSATION WITH THIS EXTERNAL ID WORKING ON?
// Real rows, real tokens and the real dispatcher. Each rule has a negative control, so a test cannot pass on an empty answer.

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleApi, type ApiDeps, type ApiResponse } from '../../src/lib/server/api/dispatch';
import { buildOpenApi } from '../../src/lib/server/api/openapi';
import { claim } from '../../src/lib/server/mcp/sessions';
import { handleHook } from '../../src/lib/server/ops/hooks';
import { NOTE_LIMIT } from '../../src/lib/server/ops/sessionStatus';
import { createToken } from '../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- TYPES -- //

type Answer = {
	sessionId: string;
	tool: string;
	externalId: string;
	etag: string;
	unchanged?: boolean;
	item: null | {
		ref: string;
		aliases: string[];
		title: string;
		tabName: string | null;
		status: string;
		percent: number;
		phase: { key: string; title: string; position: number; of: number } | null;
		steps: { done: number; open: number; waived: number; total: number };
		manualChecksOpen: number;
		resumeHere: string;
		blockers: string;
		updatedAt: string;
		url: string | null;
	};
};

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const MEMBER_CONVERSATION = 'conversation-member-0001';
const ADMIN_CONVERSATION = 'conversation-admin-0001';

// -- FUNCTIONS -- //

describe('session status by external id', () => {
	let db: TestDb;
	let w: World;
	let deps: ApiDeps;
	let ref = '';
	let memberSession = '';
	let adminSession = '';

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		deps = {
			handle: db,
			storage: memoryStorage('storage-secret-for-tests-0123456789'),
			baseUrl: BASE
		};
		// Two people, each with a conversation the hooks know about
		const start = async (who: 'member' | 'admin', externalId: string) => {
			const out = await handleHook(w.ctx(who), { tool: 'claude-code', event: 'start', externalId });
			return /s_[A-Za-z0-9_-]+/.exec(out.context ?? '')?.[0] ?? '';
		};
		memberSession = await start('member', MEMBER_CONVERSATION);
		adminSession = await start('admin', ADMIN_CONVERSATION);
		const made = await call('POST', `${projects()}/${w.projectKey}/items`, {
			as: 'member',
			body: {
				title: 'Status line item',
				tabName: 'STATUS_LINE',
				phases: PLAN.phases,
				manualChecks: PLAN.manualChecks
			}
		});
		ref = (made.body as { ref: string }).ref;
		await claim(w.ctx('member'), memberSession, ref, '1');
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	const slug = () => `world-${w.projectKey.slice(3)}`;
	const projects = () => `/orgs/${slug()}/projects`;
	const call = (
		method: string,
		path: string,
		options: {
			as?: keyof World['people'] | 'stranger';
			token?: string;
			body?: unknown;
			query?: Record<string, string>;
		} = {}
	): Promise<ApiResponse> => {
		const headers = new Headers();
		if (options.token) headers.set('authorization', `Bearer ${options.token}`);
		const who =
			options.as === 'stranger' ? w.other.userId : options.as ? w.people[options.as] : null;
		return handleApi(
			{
				method,
				path,
				query: options.query ?? {},
				headers,
				body:
					options.body !== undefined
						? new TextEncoder().encode(JSON.stringify(options.body))
						: new Uint8Array(),
				session: who ? { id: who, name: String(options.as) } : null
			},
			deps
		);
	};
	const lookup = (externalId: string, options: Parameters<typeof call>[2] = {}, org = slug()) =>
		call('GET', `/orgs/${org}/sessions/by-external/${externalId}`, options);
	const answer = async (
		externalId = MEMBER_CONVERSATION,
		options: Parameters<typeof call>[2] = {}
	) => {
		const r = await lookup(externalId, { as: 'member', ...options });
		expect(r.status).toBe(200);
		return r.body as Answer;
	};
	/** Everything a read must leave alone: the log tables and the session row of the conversation. */
	const snapshot = async (sessionId: string) => {
		const [counts] = await db.admin.query<{ events: number; session_events: number }>(
			`SELECT (SELECT count(*)::int FROM event) AS events, (SELECT count(*)::int FROM session_event) AS session_events`
		);
		const [row] = await db.admin.query(
			`SELECT updated_at::text AS updated_at, last_seen_at::text AS last_seen_at, token_id, claimed_item_id, claimed_phase FROM session WHERE id = $1`,
			[sessionId]
		);
		return { counts, row };
	};
	const getItem = async () =>
		(
			(await call('GET', `/orgs/${slug()}/items/${ref}`, { as: 'member' })).body as {
				item: { percent: number; status: string };
			}
		).item;

	it('is in the OpenAPI document with its query and no x-session-id advice missing', () => {
		const doc = buildOpenApi(BASE);
		const op = (
			doc.paths['/orgs/{org}/sessions/by-external/{externalId}'] as {
				get: { summary: string; parameters: { name: string; in: string }[] };
			}
		).get;
		expect(op.summary).toContain('x-session-id');
		const names = op.parameters.filter((p) => p.in === 'query').map((p) => p.name);
		expect(names).toEqual(expect.arrayContaining(['tool', 'etag']));
	});

	it('answers the claimed item with the percent and status the item page shows', async () => {
		await call('POST', `/orgs/${slug()}/items/${ref}/record`, {
			as: 'member',
			body: {
				marks: [
					{ key: '1.1', mark: 'done' },
					{ key: '2.2', mark: 'waived', reason: 'Not needed here' }
				]
			}
		});
		const a = await answer();
		expect(a.sessionId).toBe(memberSession);
		expect(a.tool).toBe('claude-code');
		expect(a.externalId).toBe(MEMBER_CONVERSATION);
		expect(a.item).toMatchObject({
			ref,
			title: 'Status line item',
			tabName: 'STATUS_LINE',
			status: 'IN PROGRESS',
			phase: { key: '1', title: 'Build', position: 1, of: 2 },
			// Four steps, one waived: three count, one is done, two are open
			steps: { done: 1, open: 2, waived: 1, total: 3 },
			manualChecksOpen: 2,
			url: `${BASE}/${slug()}/${w.projectKey}/${ref}`
		});
		const page = await getItem();
		expect(a.item?.percent).toBe(page.percent);
		expect(a.item?.status).toBe(page.status);
		// Negative control: a stored percent of zero would have passed an equal-to-itself check, so pin the real value
		expect(page.percent).toBe(33);
	});

	it('shows the percent the item page shows for an imported item with a frozen percent', async () => {
		await db.admin.exec(`UPDATE item SET legacy_percent = 77, percent = 77 WHERE ref = '${ref}'`);
		const a = await answer();
		expect(a.item?.percent).toBe(77);
		expect((await getItem()).percent).toBe(77);
		await db.admin.exec(`UPDATE item SET legacy_percent = NULL, percent = 33 WHERE ref = '${ref}'`);
	});

	it('gives no phase when the claimed phase is missing or was removed', async () => {
		await db.admin.exec(`UPDATE session SET claimed_phase = NULL WHERE id = '${memberSession}'`);
		expect((await answer()).item?.phase).toBeNull();
		await db.admin.exec(`UPDATE session SET claimed_phase = 'gone' WHERE id = '${memberSession}'`);
		expect((await answer()).item?.phase).toBeNull();
		await db.admin.exec(`UPDATE session SET claimed_phase = '2' WHERE id = '${memberSession}'`);
		expect((await answer()).item?.phase).toMatchObject({ key: '2', position: 2, of: 2 });
	});

	it('cuts a very long note with a marker, and keeps a short one whole', async () => {
		await call('PUT', `/orgs/${slug()}/items/${ref}/sections/resume-here`, {
			as: 'member',
			body: { title: 'Resume here', body: 'x'.repeat(NOTE_LIMIT * 5) }
		});
		await call('PUT', `/orgs/${slug()}/items/${ref}/sections/blockers`, {
			as: 'member',
			body: { title: 'Blockers', body: 'Waiting for **sign off**' }
		});
		const a = await answer();
		expect(a.item?.resumeHere.length).toBeLessThan(NOTE_LIMIT + 20);
		expect(a.item?.resumeHere.endsWith('[cut]')).toBe(true);
		// The text is returned as written: the caller must never render it as Markdown
		expect(a.item?.blockers).toBe('Waiting for **sign off**');
	});

	it('answers item null when the conversation claims nothing, and when the claim ended', async () => {
		const a = await answer(ADMIN_CONVERSATION, { as: 'admin' });
		expect(a.sessionId).toBe(adminSession);
		expect(a.item).toBeNull();
		await claim(w.ctx('admin'), adminSession, ref, '1');
		expect((await answer(ADMIN_CONVERSATION, { as: 'admin' })).item?.ref).toBe(ref);
		await claim(w.ctx('admin'), adminSession, null);
		expect((await answer(ADMIN_CONVERSATION, { as: 'admin' })).item).toBeNull();
	});

	it('hides a claimed item the person may no longer see', async () => {
		const made = await call('POST', `${projects()}/${w.projectKey}/items`, {
			as: 'admin',
			body: { title: 'Soon private', phases: PLAN.phases }
		});
		const hidden = (made.body as { ref: string }).ref;
		await claim(w.ctx('member'), memberSession, hidden, '1');
		expect((await answer()).item?.ref).toBe(hidden);
		// Turned private by its creator without the claim being released: the lookup must still hide it
		await db.admin.exec(`UPDATE item SET visibility = 'private' WHERE ref = '${hidden}'`);
		const a = await answer();
		expect(a.item).toBeNull();
		expect(JSON.stringify(a)).not.toContain('Soon private');
		await claim(w.ctx('member'), memberSession, ref, '2');
		expect((await answer()).item?.ref).toBe(ref);
	});

	it('hides the item from a person who lost the right to see its project', async () => {
		await db.admin.exec(
			`UPDATE member SET role = 'guest' WHERE org_id = '${w.orgId}' AND user_id = '${w.people.member}'`
		);
		try {
			expect((await answer()).item).toBeNull();
		} finally {
			await db.admin.exec(
				`UPDATE member SET role = 'member' WHERE org_id = '${w.orgId}' AND user_id = '${w.people.member}'`
			);
		}
		expect((await answer()).item?.ref).toBe(ref);
	});

	it('answers the same not found for another person, another organisation and an unknown id', async () => {
		// The admin's conversation exists, so asking for it as the member must look exactly like asking for a made up id
		const foreign = await lookup(ADMIN_CONVERSATION, { as: 'member' });
		const unknown = await lookup('conversation-nobody-0000', { as: 'member' });
		const otherOrg = await lookup(MEMBER_CONVERSATION, { as: 'stranger' });
		for (const r of [foreign, unknown, otherOrg]) expect(r.status).toBe(404);
		expect(foreign.body).toEqual(unknown.body);
		expect(otherOrg.body).toEqual(unknown.body);
		// Negative control: the owner of that conversation does get an answer
		expect((await lookup(ADMIN_CONVERSATION, { as: 'admin' })).status).toBe(200);
		// Another tool's conversation of the same id is another session, so it is not found either
		expect(
			(await lookup(MEMBER_CONVERSATION, { as: 'member', query: { tool: 'gemini' } })).status
		).toBe(404);
	});

	it('needs the read permission, and a project limited token does not see other projects', async () => {
		const noRead = await createToken(w.ctx('member'), {
			name: 'no read',
			permissions: ['comment']
		});
		const refused = await lookup(MEMBER_CONVERSATION, { token: noRead.token });
		expect(refused.status).toBe(403);
		expect(JSON.stringify(refused.body)).not.toContain(ref);

		const readOnly = await createToken(w.ctx('member'), {
			name: 'status line',
			permissions: ['read']
		});
		const ok = await lookup(MEMBER_CONVERSATION, { token: readOnly.token });
		expect(ok.status).toBe(200);
		expect((ok.body as Answer).item?.ref).toBe(ref);

		const [side] = await db.admin.query<{ id: string }>(
			`INSERT INTO project (id, org_id, key, name) VALUES (gen_random_uuid(), '${w.orgId}', 'SIDE', 'Side project') RETURNING id`
		);
		const limited = await createToken(w.ctx('member'), {
			name: 'side only',
			permissions: ['read'],
			projectIds: [side.id]
		});
		const blind = await lookup(MEMBER_CONVERSATION, { token: limited.token });
		expect(blind.status).toBe(200);
		expect((blind.body as Answer).item).toBeNull();
		expect(JSON.stringify(blind.body)).not.toContain('Status line item');
	});

	it('writes nothing, and the etag says unchanged until something the answer shows changes', async () => {
		const first = await answer();
		const before = await snapshot(memberSession);
		for (let i = 0; i < 3; i++) await answer();
		expect(await snapshot(memberSession)).toEqual(before);

		// Negative control: the same snapshot does change around a call that does write
		await claim(w.ctx('member'), memberSession, ref, '1');
		expect(await snapshot(memberSession)).not.toEqual(before);

		// Unchanged, then a changed phase, a step, and a note each change the etag
		const again = await answer();
		expect(again.item?.phase?.key).toBe('1');
		expect(again.etag).not.toBe(first.etag);
		const same = await lookup(MEMBER_CONVERSATION, { as: 'member', query: { etag: again.etag } });
		expect(same.body).toEqual({ unchanged: true, etag: again.etag });
		await call('POST', `/orgs/${slug()}/items/${ref}/record`, {
			as: 'member',
			body: { marks: [{ key: '1.2', mark: 'done' }] }
		});
		const afterStep = await lookup(MEMBER_CONVERSATION, {
			as: 'member',
			query: { etag: again.etag }
		});
		expect((afterStep.body as Answer).etag).not.toBe(again.etag);
		expect((afterStep.body as Answer).unchanged).toBeUndefined();
		const stepEtag = (afterStep.body as Answer).etag;
		await call('PUT', `/orgs/${slug()}/items/${ref}/sections/resume-here`, {
			as: 'member',
			body: { title: 'Resume here', body: 'A new note' }
		});
		expect((await answer()).etag).not.toBe(stepEtag);
	});

	// -- THE STATUS IN THE HOOK ANSWER (AFB-20261108-0427, S.1) -- //

	describe('the status in the hook answer', () => {
		const hook = (
			who: 'member' | 'admin',
			event: 'start' | 'prompt' | 'stop' | 'tool' | 'end',
			externalId: string,
			more: Record<string, unknown> = {}
		) =>
			// The route builds its context with the site address; the same here, so the item url is the same in both answers
			handleHook(
				{ ...w.ctx(who), services: { baseUrl: BASE } } as never,
				{
					tool: 'claude-code',
					event,
					externalId,
					...more
				} as never
			);

		it('carries the status of the hook own session only when the flag is set', async () => {
			await claim(w.ctx('member'), memberSession, ref, '1');
			const without = await hook('member', 'prompt', MEMBER_CONVERSATION);
			expect('status' in without).toBe(false);
			const asked = await hook('member', 'prompt', MEMBER_CONVERSATION, { status: true });
			expect(asked.status?.item?.ref).toBe(ref);
			expect(asked.status?.sessionId).toBe(memberSession);
			// The same fields and etag as the lookup route gives for the same moment
			const route = await answer();
			expect(asked.status).toEqual(route);
		});

		it('shows no item for a conversation that claims nothing, and drops it after a release', async () => {
			const idle = await hook('admin', 'prompt', ADMIN_CONVERSATION, { status: true });
			expect(idle.status?.item).toBeNull();
			await claim(w.ctx('admin'), adminSession, ref, '1');
			expect(
				(await hook('admin', 'stop', ADMIN_CONVERSATION, { status: true })).status?.item?.ref
			).toBe(ref);
			await claim(w.ctx('admin'), adminSession, null);
			expect(
				(
					await hook('admin', 'tool', ADMIN_CONVERSATION, {
						status: true,
						action: { kind: 'read' }
					})
				).status?.item
			).toBeNull();
		});

		it('never shows another person the item of a conversation id they do not own', async () => {
			// The admin sends the member's conversation id: it is the admin's own new session, with no claim
			const foreign = await hook('admin', 'prompt', MEMBER_CONVERSATION, { status: true });
			expect(foreign.status?.item).toBeNull();
			expect(foreign.status?.sessionId).not.toBe(memberSession);
			expect(JSON.stringify(foreign)).not.toContain('Status line item');
		});

		it('hides a claimed item that turned private', async () => {
			const made = await call('POST', `${projects()}/${w.projectKey}/items`, {
				as: 'admin',
				body: { title: 'Hidden from the hook', phases: PLAN.phases }
			});
			const hidden = (made.body as { ref: string }).ref;
			await claim(w.ctx('member'), memberSession, hidden, '1');
			const shown = await hook('member', 'prompt', MEMBER_CONVERSATION, { status: true });
			expect(shown.status?.item?.ref).toBe(hidden);
			await db.admin.exec(`UPDATE item SET visibility = 'private' WHERE ref = '${hidden}'`);
			const out = await hook('member', 'prompt', MEMBER_CONVERSATION, { status: true });
			expect(out.status?.item).toBeNull();
			expect(JSON.stringify(out)).not.toContain('Hidden from the hook');
			await claim(w.ctx('member'), memberSession, ref, '1');
		});

		it('has no status at the end of a conversation, flag or not', async () => {
			const out = await hook('member', 'end', MEMBER_CONVERSATION, { status: true });
			expect('status' in out).toBe(false);
			await claim(w.ctx('member'), memberSession, ref, '1');
		});

		it('measures what the status adds to one hook call (P.3)', async () => {
			const time = async (status: boolean) => {
				const samples: number[] = [];
				for (let i = 0; i < 15; i++) {
					const t = performance.now();
					await hook('member', 'prompt', MEMBER_CONVERSATION, status ? { status: true } : {});
					samples.push(performance.now() - t);
				}
				samples.sort((a, b) => a - b);
				return samples[Math.floor(samples.length / 2)];
			};
			await time(true);
			const plain = await time(false);
			const withStatus = await time(true);
			const added = withStatus - plain;
			console.info(
				`P.3 hook call median: ${plain.toFixed(1)} ms without status, ${withStatus.toFixed(1)} ms with status, +${added.toFixed(1)} ms (6 selects: item, phases, waived count, notes, aliases, project)`
			);
			// The budget set in the plan: the flag adds no more than 200 ms to a hook call
			expect(added).toBeLessThan(200);
		});
	});
});
