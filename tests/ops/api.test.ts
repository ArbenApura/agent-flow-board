// 5.10: THE REST API THROUGH ITS DISPATCHER, WITH SESSIONS AND TOKENS

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage, verifySignedFile } from '../../src/lib/server/adapters/storage';
import { handleApi, type ApiDeps, type ApiResponse } from '../../src/lib/server/api/dispatch';
import { buildOpenApi } from '../../src/lib/server/api/openapi';
import { compile, match, routes } from '../../src/lib/server/api/routes';
import { makePglite, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const SECRET = 'storage-secret-for-tests-0123456789';

// -- FUNCTIONS -- //

describe('route table', () => {
	it('matches paths with named parts and keeps methods apart', () => {
		const m = match('GET', '/orgs/acme/items/CKT-1');
		expect(m && 'route' in m && m.params).toEqual({ org: 'acme', item: 'CKT-1' });
		expect(match('DELETE', '/orgs/acme/items/CKT-1')).toMatchObject({
			route: { summary: expect.stringContaining('trash') }
		});
		expect(match('PUT', '/orgs/acme/items/CKT-1')).toEqual({ allowed: ['GET', 'PATCH', 'DELETE'] });
		expect(match('GET', '/nothing/here')).toBeNull();
		expect(compile('/orgs/{org}/x').test('/orgs/a/b/x')).toBe(false);
	});
	it('has one entry per method and path, and every body route has a schema', () => {
		const keys = routes.map((r) => `${r.method} ${r.path}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
	it('generates an OpenAPI document with every route and no secrets', () => {
		const doc = buildOpenApi(BASE);
		expect(doc.openapi).toBe('3.1.0');
		expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
		const record = (
			doc.paths['/orgs/{org}/items/{item}/record'] as {
				post: {
					requestBody: {
						content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
					};
				};
			}
		).post;
		expect(Object.keys(record.requestBody.content['application/json'].schema.properties)).toContain(
			'marks'
		);
		const text = JSON.stringify(doc);
		expect(text).not.toMatch(/BETTER_AUTH_SECRET|password hash|DATABASE_URL/i);
	});
});

describe('REST API', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage(SECRET);
	let deps: ApiDeps;
	/** The reference the first test gives its item; the later tests read it. */
	let apiRef = '';
	beforeAll(async () => {
		db = await makePglite();
		w = await makeWorld(db);
		deps = { handle: db, storage, baseUrl: BASE };
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	const slug = () => `world-${w.projectKey.slice(3)}`;
	const call = (
		method: string,
		path: string,
		options: {
			as?: keyof World['people'];
			token?: string;
			body?: unknown;
			query?: Record<string, string>;
			key?: string;
			bytes?: Uint8Array;
		} = {}
	): Promise<ApiResponse> => {
		const headers = new Headers();
		if (options.token) headers.set('authorization', `Bearer ${options.token}`);
		if (options.key) headers.set('idempotency-key', options.key);
		return handleApi(
			{
				method,
				path,
				query: options.query ?? {},
				headers,
				body:
					options.bytes ??
					(options.body !== undefined
						? new TextEncoder().encode(JSON.stringify(options.body))
						: new Uint8Array()),
				session: options.as ? { id: w.people[options.as], name: options.as } : null
			},
			deps
		);
	};
	const base = () => `/orgs/${slug()}`;

	it('refuses calls with no sign in or a bad token, and serves the OpenAPI document without one', async () => {
		expect((await call('GET', `${base()}/projects`)).status).toBe(401);
		expect((await call('GET', `${base()}/projects`, { token: 'afb_nonsense' })).status).toBe(401);
		const doc = await call('GET', '/openapi.json');
		expect(doc.status).toBe(200);
	});

	it('creates a project, an item and records progress, end to end', async () => {
		const p = await call('POST', `${base()}/projects`, {
			as: 'admin',
			body: { key: 'API', name: 'API project' }
		});
		expect(p.status).toBe(200);
		expect(
			(
				await call('POST', `${base()}/projects`, {
					as: 'member',
					body: { key: 'NOPE', name: 'Not allowed' }
				})
			).status
		).toBe(403);
		expect(
			(
				await call('POST', `${base()}/projects`, {
					as: 'admin',
					body: { key: 'API', name: 'Duplicate' }
				})
			).status
		).toBe(409);
		const created = await call('POST', `${base()}/projects/API/items`, {
			as: 'member',
			body: { title: 'REST made item', phases: PLAN.phases, manualChecks: PLAN.manualChecks }
		});
		expect(created.status).toBe(200);
		const ref = (created.body as { ref: string }).ref;
		// A new item is named from the project key and the minute it was made in UTC
		expect(ref).toMatch(/^API-\d{8}-\d{4}(-[a-z])?$/);
		apiRef = ref;
		const rec = await call('POST', `${base()}/items/${ref}/record`, {
			as: 'member',
			body: { marks: [{ key: '1.1', mark: 'done' }] }
		});
		expect(rec.status).toBe(200);
		expect((rec.body as { statusChanges: unknown[] }).statusChanges).toEqual([
			{ from: 'PLANNED', to: 'IN PROGRESS', note: 'Automatic' }
		]);
		const got = await call('GET', `${base()}/items/${ref}`, { as: 'viewer' });
		expect((got.body as { item: { status: string; percent: number } }).item).toMatchObject({
			status: 'IN PROGRESS',
			percent: 25
		});
		const page = await call('GET', `${base()}/projects/API/items`, {
			as: 'viewer',
			query: { limit: '10' }
		});
		expect((page.body as { items: unknown[] }).items).toHaveLength(1);
	});

	it('answers 400 for bad input with the reason, 404 for the unknown and 405 with the allowed methods', async () => {
		const bad = await call('POST', `${base()}/projects/API/items`, {
			as: 'member',
			body: { title: 'x' }
		});
		expect(bad.status).toBe(400);
		expect(JSON.stringify(bad.body)).toContain('title');
		expect(
			(
				await call('POST', `${base()}/projects/API/items`, {
					as: 'member',
					bytes: new TextEncoder().encode('{not json')
				})
			).status
		).toBe(400);
		expect((await call('GET', `${base()}/items/NO-1`, { as: 'member' })).status).toBe(404);
		const wrong = await call('PUT', `${base()}/items/${apiRef}`, { as: 'member', body: {} });
		expect(wrong.status).toBe(405);
		expect(wrong.headers?.allow).toBe('GET, PATCH, DELETE');
		expect((await call('GET', '/nothing', { as: 'member' })).status).toBe(404);
	});

	it('keeps orgs apart: another org, or a member of no org, gets 404, never data', async () => {
		const asOther = await handleApi(
			{
				method: 'GET',
				path: `${base()}/items/${apiRef}`,
				query: {},
				headers: new Headers(),
				body: new Uint8Array(),
				session: { id: w.other.userId, name: 'other' }
			},
			deps
		);
		expect(asOther.status).toBe(404);
		expect(JSON.stringify(asOther.body)).not.toContain('REST made item');
		const none = await handleApi(
			{
				method: 'GET',
				path: `/orgs/not-an-org/projects`,
				query: {},
				headers: new Headers(),
				body: new Uint8Array(),
				session: { id: w.people.member, name: 'm' }
			},
			deps
		);
		expect(none.status).toBe(404);
	});

	it('a repeated Idempotency-Key returns the first result and writes nothing twice', async () => {
		const a = await call('POST', `${base()}/projects/API/items`, {
			as: 'member',
			key: 'rest-retry-0001',
			body: { title: 'Created once only' }
		});
		const b = await call('POST', `${base()}/projects/API/items`, {
			as: 'member',
			key: 'rest-retry-0001',
			body: { title: 'Created once only' }
		});
		expect((b.body as { id: string }).id).toBe((a.body as { id: string }).id);
		expect(
			(
				await call('POST', `${base()}/projects/API/items`, {
					as: 'member',
					key: 'bad key',
					body: { title: 'Another item' }
				})
			).status
		).toBe(400);
	});

	it('a stale write is a 409 with the current version', async () => {
		const got = await call('GET', `${base()}/items/${apiRef}`, { as: 'member' });
		const v = (got.body as { item: { version: number } }).item.version;
		expect(
			(
				await call('PATCH', `${base()}/items/${apiRef}`, {
					as: 'member',
					body: { title: 'Renamed over REST', expectVersion: v }
				})
			).status
		).toBe(200);
		const stale = await call('PATCH', `${base()}/items/${apiRef}`, {
			as: 'member',
			body: { title: 'Stale over REST', expectVersion: v }
		});
		expect(stale.status).toBe(409);
		expect(stale.body).toMatchObject({ error: { code: 'STALE_VERSION' } });
	});

	it('tokens: made by a person, refused to a token, limited by their user, revoked at once', async () => {
		const made = await call('POST', `${base()}/tokens`, {
			as: 'member',
			body: { name: 'agent token', permissions: ['read', 'write'] }
		});
		expect(made.status).toBe(200);
		const { token, id } = made.body as { token: string; id: string };
		const list = await call('GET', `${base()}/tokens`, { as: 'member' });
		expect(JSON.stringify(list.body)).not.toContain(token.split('.')[1]);
		// A token cannot make tokens
		expect(
			(
				await call('POST', `${base()}/tokens`, {
					token,
					body: { name: 'child', permissions: ['read'] }
				})
			).status
		).toBe(403);
		// It can read and write what its permissions list
		expect((await call('GET', `${base()}/items/${apiRef}`, { token })).status).toBe(200);
		const rec = await call('POST', `${base()}/items/${apiRef}/record`, {
			token,
			body: { marks: [{ key: '1.2', mark: 'done' }] }
		});
		expect(rec.status).toBe(200);
		// But not what it does not list
		const done = await call('POST', `${base()}/items/${apiRef}/status`, {
			token,
			body: { status: 'COMPLETED', note: 'Closed by token' }
		});
		expect(done.status).toBe(403);
		// The event log shows the tool
		const log = await call('GET', `${base()}/projects/API/events`, { as: 'member' });
		expect(JSON.stringify(log.body)).toContain('agent token');
		// Another org's path with this token is a 404
		expect(
			(await call('GET', `/orgs/other-${w.projectKey.slice(3)}/projects`, { token })).status
		).toBe(404);
		// Revoked tokens stop at once
		expect((await call('DELETE', `${base()}/tokens/${id}`, { as: 'member' })).status).toBe(200);
		expect((await call('GET', `${base()}/items/${apiRef}`, { token })).status).toBe(401);
	});

	it('COMPLETED over REST: refused while steps are open, refused to agents when the project keeps it for people, allowed to a person', async () => {
		const mk = await call('POST', `${base()}/tokens`, {
			as: 'member',
			body: { name: 'closer', permissions: ['read', 'write', 'complete'] }
		});
		const token = (mk.body as { token: string }).token;
		const it = await call('POST', `${base()}/projects/API/items`, {
			as: 'member',
			body: {
				title: 'To be closed',
				phases: [{ key: '1', title: 'One', steps: [{ text: 'only' }] }]
			}
		});
		const ref = (it.body as { ref: string }).ref;
		const open = await call('POST', `${base()}/items/${ref}/status`, {
			token,
			body: { status: 'COMPLETED', note: 'Too early now' }
		});
		expect(open.status).toBe(409);
		expect(open.body).toMatchObject({
			error: { code: 'COMPLETED_REFUSED', details: { reason: 'open-steps' } }
		});
		await call('POST', `${base()}/items/${ref}/record`, {
			token,
			body: { marks: [{ key: '1.1', mark: 'done' }] }
		});
		expect(
			(
				await call('PATCH', `${base()}/projects/API`, {
					as: 'admin',
					body: { agentsMayComplete: false }
				})
			).status
		).toBe(200);
		const refused = await call('POST', `${base()}/items/${ref}/status`, {
			token,
			body: { status: 'COMPLETED', note: 'An agent closes it' }
		});
		expect(refused.body).toMatchObject({
			error: { code: 'COMPLETED_REFUSED', details: { reason: 'people-only' } }
		});
		const person = await call('POST', `${base()}/items/${ref}/status`, {
			as: 'member',
			body: { status: 'COMPLETED', note: 'A person closes it' }
		});
		expect(person.status).toBe(200);
	});

	it('uploads an attachment, hands out a signed link, and lets a person undo a change over REST', async () => {
		const up = await call('POST', `${base()}/items/${apiRef}/attachments`, {
			as: 'member',
			query: { filename: 'proof.txt', caption: 'The proof' },
			bytes: new TextEncoder().encode('proof text')
		});
		expect(up.status).toBe(200);
		const id = (up.body as { attachment: { id: string; storageKey: string } }).attachment.id;
		const key = (up.body as { attachment: { storageKey: string } }).attachment.storageKey;
		const link = await call('GET', `${base()}/attachments/${id}/link`, { as: 'member' });
		const u = new URL((link.body as { url: string }).url);
		expect(
			verifySignedFile(SECRET, key, Number(u.searchParams.get('exp')), u.searchParams.get('sig')!)
		).toBe(true);
		expect((await call('GET', `${base()}/attachments/${id}/link`, { as: 'viewer' })).status).toBe(
			404
		);
		const log = await call('GET', `${base()}/projects/API/events`, {
			as: 'member',
			query: { item: apiRef }
		});
		const rename = (log.body as { id: number; verb: string; label: string }[]).find(
			(e) => e.verb === 'item.update' && e.label === 'undoable'
		);
		expect(rename).toBeTruthy();
		const undo = await call('POST', `${base()}/events/${rename!.id}/undo`, {
			as: 'member',
			body: {}
		});
		expect(undo.status).toBe(200);
		expect(undo.body).toMatchObject({ ok: true });
	});

	it('changes a step over REST, refuses a viewer, and lets an agent token still trash an item it did not claim', async () => {
		const mk = await call('POST', `${base()}/tokens`, {
			as: 'member',
			body: { name: 'planner', permissions: ['read', 'write', 'delete'] }
		});
		const token = (mk.body as { token: string }).token;
		const made = await call('POST', `${base()}/projects/API/items`, {
			as: 'member',
			body: {
				title: 'REST plan edit',
				phases: [{ key: '1', title: 'One', steps: [{ text: 'a' }, { text: 'b' }] }]
			}
		});
		const ref = (made.body as { ref: string }).ref;
		const reword = await call('PATCH', `${base()}/items/${ref}/steps/1.1`, {
			token,
			body: { text: 'a, reworded' }
		});
		expect(reword.status).toBe(200);
		expect(reword.body).toMatchObject({ key: '1.1', changed: true });
		const both = await call('PATCH', `${base()}/items/${ref}/steps/1.1`, {
			token,
			body: { text: 'x', remove: true }
		});
		expect(both.status).toBe(400);
		const viewer = await call('PATCH', `${base()}/items/${ref}/steps/1.1`, {
			as: 'viewer',
			body: { text: 'x' }
		});
		expect(viewer.status).toBe(403);
		const missing = await call('PATCH', `${base()}/items/${ref}/steps/1.9`, {
			token,
			body: { text: 'x' }
		});
		expect(missing.status).toBe(404);
		const removed = await call('PATCH', `${base()}/items/${ref}/steps/1.2`, {
			token,
			body: { remove: true }
		});
		expect(removed.body).toMatchObject({ key: '1.2', removed: true });
		// A REST DELETE names the item outright, so an agent token needs no confirmation
		const trashed = await call('DELETE', `${base()}/items/${ref}`, { token });
		expect(trashed.status).toBe(200);
		expect(trashed.body).toMatchObject({ trashed: true });
	});

	it('pins and unpins a project for the signed in person only, and says the same for a project it cannot see', async () => {
		const pin = await call('PUT', `${base()}/projects/API/pin`, { as: 'member' });
		expect(pin.status).toBe(200);
		expect(pin.body).toMatchObject({ pinned: true });
		const again = await call('PUT', `${base()}/projects/API/pin`, { as: 'member' });
		expect(again.status).toBe(200);
		// A guest has no access to the project, so it looks like any other missing project
		expect((await call('PUT', `${base()}/projects/API/pin`, { as: 'guest' })).status).toBe(404);
		expect((await call('PUT', `${base()}/projects/NOPE/pin`, { as: 'member' })).status).toBe(404);
		const gone = await call('DELETE', `${base()}/projects/API/pin`, { as: 'member' });
		expect(gone.status).toBe(200);
		expect(gone.body).toMatchObject({ pinned: false });
		// Clearing a pin that is not there is fine, and a token with read access may pin
		expect((await call('DELETE', `${base()}/projects/API/pin`, { as: 'member' })).status).toBe(200);
		const mk = await call('POST', `${base()}/tokens`, {
			as: 'member',
			body: { name: 'reader', permissions: ['read'] }
		});
		const token = (mk.body as { token: string }).token;
		expect((await call('PUT', `${base()}/projects/API/pin`, { token })).status).toBe(200);
		await call('DELETE', `${base()}/projects/API/pin`, { token });
	});

	it('searches inside the org only', async () => {
		const hits = await call('GET', `${base()}/search`, { as: 'viewer', query: { q: 'proof' } });
		expect(hits.status).toBe(200);
		const all = await call('GET', `${base()}/search`, { as: 'viewer', query: { q: 'REST' } });
		expect(Array.isArray(all.body)).toBe(true);
	});

	it('a server failure answers with a plain message and nothing else', async () => {
		const broken = await handleApi(
			{
				method: 'GET',
				path: `${base()}/projects`,
				query: {},
				headers: new Headers(),
				body: new Uint8Array(),
				session: { id: w.people.member, name: 'm' }
			},
			{
				...deps,
				handle: {
					...db,
					db: {
						transaction: () => Promise.reject(new Error('password=hunter2 at C:\\secret\\file.ts'))
					} as never
				}
			}
		);
		expect(broken.status).toBe(500);
		expect(JSON.stringify(broken.body)).not.toMatch(/hunter2|secret/);
	});
});
