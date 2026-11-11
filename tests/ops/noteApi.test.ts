// THE NOTE REST ENDPOINTS THROUGH THE DISPATCHER: 200, 403, 404 AND 409 ON NOTES, FOLDERS AND FAVOURITES (AFB-20261111-0035, step 2.4)

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleApi, type ApiDeps, type ApiResponse } from '../../src/lib/server/api/dispatch';
import { buildOpenApi } from '../../src/lib/server/api/openapi';
import { match } from '../../src/lib/server/api/routes';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';

describe('note endpoints', () => {
	let db: TestDb;
	let w: World;
	let deps: ApiDeps;
	const slug = () => `world-${w.projectKey.slice(3)}`;
	const notes = () => `/orgs/${slug()}/projects/${w.projectKey}/notes`;
	const folders = () => `/orgs/${slug()}/projects/${w.projectKey}/note-folders`;
	const call = (
		method: string,
		path: string,
		o: {
			as?: keyof World['people'];
			body?: unknown;
			query?: Record<string, string>;
			key?: string;
		} = {}
	): Promise<ApiResponse> => {
		const headers = new Headers();
		if (o.key) headers.set('idempotency-key', o.key);
		return handleApi(
			{
				method,
				path,
				query: o.query ?? {},
				headers,
				body:
					o.body !== undefined
						? new TextEncoder().encode(JSON.stringify(o.body))
						: new Uint8Array(),
				session: o.as ? { id: w.people[o.as], name: o.as } : null
			},
			deps
		);
	};
	const b = (r: ApiResponse) => r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		deps = {
			handle: db,
			storage: memoryStorage('api-note-secret-0123456789abcdef'),
			baseUrl: BASE
		};
	}, 180_000);
	afterAll(() => db?.stop());

	it('is in the route table and the OpenAPI document', () => {
		expect(match('POST', '/orgs/acme/projects/P/notes')).not.toBeNull();
		expect(match('PATCH', '/orgs/acme/projects/P/notes/N-1')).not.toBeNull();
		expect(match('PUT', '/orgs/acme/projects/P/notes/N-1/favourite')).not.toBeNull();
		expect(match('POST', '/orgs/acme/projects/P/note-folders/x/restore')).not.toBeNull();
		const doc = buildOpenApi(BASE);
		for (const p of [
			'/orgs/{org}/projects/{project}/notes',
			'/orgs/{org}/projects/{project}/notes/{note}',
			'/orgs/{org}/projects/{project}/note-folders/{folder}'
		])
			expect(Object.keys(doc.paths), p).toContain(p);
	});

	it('notes: create, read, change, list, trash and restore answer 200 for a member', async () => {
		const made = await call('POST', notes(), {
			as: 'member',
			body: { title: 'From the API', body: 'Hello' }
		});
		expect(made.status).toBe(200);
		expect(b(made).ref).toBe('N-1');
		expect(JSON.stringify(made.body)).not.toContain('Hello');
		const read = await call('GET', `${notes()}/N-1`, { as: 'viewer', query: { full: 'true' } });
		expect([read.status, b(read).body.text]).toEqual([200, 'Hello']);
		const changed = await call('PATCH', `${notes()}/N-1`, {
			as: 'member',
			body: { body: 'Hello again', expectVersion: 1 }
		});
		expect([changed.status, b(changed).version]).toEqual([200, 2]);
		// A body sent to the endpoint is an outside write, even from a cookie session: it moves the epoch so an open window
		// reloads instead of overwriting it at its next checkpoint, and it keeps a version
		expect(b(changed).epoch).toBe(2);
		const renamed = await call('PATCH', `${notes()}/N-1`, {
			as: 'member',
			body: { title: 'Renamed' }
		});
		expect(b(renamed).epoch).toBe(2);
		const list = await call('GET', notes(), { as: 'viewer', query: { q: 'again' } });
		expect([list.status, b(list).notes.length]).toEqual([200, 1]);
		expect((await call('DELETE', `${notes()}/N-1`, { as: 'member' })).status).toBe(200);
		expect((await call('GET', `${notes()}/N-1`, { as: 'member' })).status).toBe(404);
		expect((await call('POST', `${notes()}/N-1/restore`, { as: 'member' })).status).toBe(200);
		expect((await call('GET', `${notes()}/N-1`, { as: 'member' })).status).toBe(200);
	});

	it('notes: 401 without a session, 403 for a viewer who writes, 404 for an unknown or private note, 409 for a stale version, 400 for bad input', async () => {
		expect((await call('GET', notes())).status).toBe(401);
		expect((await call('POST', notes(), { as: 'viewer', body: { title: 'No' } })).status).toBe(403);
		expect(
			(await call('PATCH', `${notes()}/N-1`, { as: 'viewer', body: { title: 'No' } })).status
		).toBe(403);
		expect((await call('DELETE', `${notes()}/N-1`, { as: 'viewer' })).status).toBe(403);
		expect((await call('GET', `${notes()}/N-999`, { as: 'member' })).status).toBe(404);
		expect((await call('GET', `${notes()}/not-a-note`, { as: 'member' })).status).toBe(404);
		const priv = await call('POST', notes(), {
			as: 'member',
			body: { title: 'Private', visibility: 'private' }
		});
		expect((await call('GET', `${notes()}/${b(priv).ref}`, { as: 'owner' })).status).toBe(404);
		const stale = await call('PATCH', `${notes()}/N-1`, {
			as: 'member',
			body: { title: 'Late', expectVersion: 1 }
		});
		expect([stale.status, b(stale).error.code]).toEqual([409, 'STALE_VERSION']);
		expect((await call('POST', notes(), { as: 'member', body: { title: '' } })).status).toBe(400);
		expect((await call('GET', notes(), { as: 'member', query: { limit: 'many' } })).status).toBe(
			400
		);
		// A guest of the organisation has no project at all
		expect((await call('GET', notes(), { as: 'guest' })).status).toBe(404);
	});

	it('a retried create with the same key makes one note', async () => {
		const body = { title: 'Once' };
		const a = await call('POST', notes(), { as: 'member', body, key: 'note-api-once-1' });
		const again = await call('POST', notes(), { as: 'member', body, key: 'note-api-once-1' });
		expect(b(again).id).toBe(b(a).id);
	});

	it('favourites: 200 for a reader, 404 for a note that is not there', async () => {
		const on = await call('PUT', `${notes()}/N-1/favourite`, { as: 'viewer', body: { on: true } });
		expect([on.status, b(on).favourite]).toEqual([200, true]);
		const mine = await call('GET', notes(), { as: 'viewer', query: { favourites: 'true' } });
		expect(b(mine).notes.map((n: { ref: string }) => n.ref)).toEqual(['N-1']);
		expect(
			(await call('PUT', `${notes()}/N-999/favourite`, { as: 'viewer', body: { on: true } })).status
		).toBe(404);
		expect((await call('PUT', `${notes()}/N-1/favourite`, { as: 'viewer', body: {} })).status).toBe(
			400
		);
	});

	it('folders: 200 to create, rename, move, list, trash and restore; 403, 404 and 409 where they belong', async () => {
		const top = await call('POST', folders(), { as: 'member', body: { name: 'Research' } });
		expect(top.status).toBe(200);
		const sub = await call('POST', folders(), {
			as: 'member',
			body: { name: 'Rivals', parentId: b(top).id }
		});
		expect(sub.status).toBe(200);
		expect(
			(await call('POST', folders(), { as: 'member', body: { name: 'research' } })).status
		).toBe(409);
		expect((await call('POST', folders(), { as: 'viewer', body: { name: 'No' } })).status).toBe(
			403
		);
		const tree = await call('GET', folders(), { as: 'viewer' });
		expect(b(tree).folders.map((f: { path: string }) => f.path)).toEqual([
			'Research',
			'Research/Rivals'
		]);
		const renamed = await call('PATCH', `${folders()}/${b(sub).id}`, {
			as: 'member',
			body: { name: 'Competitors' }
		});
		expect([renamed.status, b(renamed).name]).toEqual([200, 'Competitors']);
		// Into itself is refused as bad input; to the top works
		expect(
			(
				await call('PATCH', `${folders()}/${b(top).id}`, {
					as: 'member',
					body: { parentId: b(sub).id }
				})
			).status
		).toBe(400);
		const moved = await call('PATCH', `${folders()}/${b(sub).id}`, {
			as: 'member',
			body: { parentId: null }
		});
		expect([moved.status, b(moved).parentId]).toEqual([200, null]);
		expect(
			(await call('PATCH', `${folders()}/${b(sub).id}`, { as: 'member', body: {} })).status
		).toBe(400);
		// A name and a parentId together are refused with or without an Idempotency-Key: one change per request, so a
		// retried key can never replay the first verb's answer for the second
		for (const key of [undefined, 'note-api-both-1'])
			expect(
				(
					await call('PATCH', `${folders()}/${b(sub).id}`, {
						as: 'member',
						key,
						body: { name: 'Both', parentId: b(top).id }
					})
				).status,
				String(key)
			).toBe(400);
		expect(
			b(await call('GET', folders(), { as: 'viewer' })).folders.map((f: { name: string }) => f.name)
		).not.toContain('Both');
		const ghost = '00000000-0000-4000-8000-00000000dead';
		expect(
			(await call('PATCH', `${folders()}/${ghost}`, { as: 'member', body: { name: 'x' } })).status
		).toBe(404);
		expect((await call('DELETE', `${folders()}/${b(top).id}`, { as: 'viewer' })).status).toBe(403);
		expect((await call('DELETE', `${folders()}/${b(top).id}`, { as: 'member' })).status).toBe(200);
		expect((await call('DELETE', `${folders()}/${b(top).id}`, { as: 'member' })).status).toBe(404);
		expect((await call('POST', `${folders()}/${b(top).id}/restore`, { as: 'member' })).status).toBe(
			200
		);
		expect((await call('POST', `${folders()}/${ghost}/restore`, { as: 'member' })).status).toBe(
			404
		);
	});
	it('link routes: add, read both ends, remove, and the refusals', async () => {
		const src = b(
			await call('POST', notes(), { as: 'member', body: { title: 'Api link source' } })
		);
		const dst = b(
			await call('POST', notes(), { as: 'member', body: { title: 'Api link target' } })
		);
		const links = `${notes()}/${src.ref}/links`;
		const body = { targetKind: 'note', target: dst.ref };
		expect((await call('POST', links, { as: 'viewer', body })).status).toBe(403);
		expect(
			(await call('POST', links, { as: 'member', body: { targetKind: 'user', target: 'x' } }))
				.status
		).toBe(400);
		expect(
			(await call('POST', links, { as: 'member', body: { targetKind: 'note', target: 'N-9999' } }))
				.status
		).toBe(404);
		expect((await call('POST', links, { as: 'member', body })).status).toBe(200);
		expect(
			b(await call('GET', links, { as: 'viewer' })).links.map((l: { ref: string }) => l.ref)
		).toEqual([dst.ref]);
		const back = b(await call('GET', `${notes()}/${dst.ref}/links`, { as: 'viewer' }));
		expect(back.mentionedBy.map((m: { ref: string }) => m.ref)).toEqual([src.ref]);
		const del = { as: 'member' as const, query: { targetKind: 'note', target: dst.ref } };
		expect((await call('DELETE', links, { ...del, as: 'viewer' })).status).toBe(403);
		expect((await call('DELETE', links, del)).status).toBe(200);
		expect(b(await call('GET', links, { as: 'viewer' })).links).toEqual([]);
		const none = await call('GET', `${notes()}/linked-to`, {
			as: 'viewer',
			query: { kind: 'task', target: 'T-1' }
		});
		expect(none.status).toBe(404);
	});
});
