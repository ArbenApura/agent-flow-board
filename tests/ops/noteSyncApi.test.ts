// THE LIVE EDITING ENDPOINTS THROUGH THE DISPATCHER: JSON ONLY, THIS SITE'S ORIGIN FOR A COOKIE CALLER (AFB-20261111-0035, 8.2)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
// IMPORTED MODULES
import { handleApi, type ApiDeps, type ApiResponse } from '../../src/lib/server/api/dispatch';
import { createNote } from '../../src/lib/server/ops/notes';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';

describe('live editing endpoints', () => {
	let db: TestDb;
	let w: World;
	let deps: ApiDeps;
	const slug = () => `world-${w.projectKey.slice(3)}`;
	const live = (ref: string) => `/orgs/${slug()}/projects/${w.projectKey}/notes/${ref}/live`;
	const call = (
		method: string,
		path: string,
		o: { as?: keyof World['people']; body?: unknown; headers?: Record<string, string> } = {}
	): Promise<ApiResponse> =>
		handleApi(
			{
				method,
				path,
				query: {},
				headers: new Headers(o.headers ?? {}),
				body:
					o.body !== undefined
						? new TextEncoder().encode(JSON.stringify(o.body))
						: new Uint8Array(),
				session: o.as ? { id: w.people[o.as], name: o.as } : null
			},
			deps
		);
	const json = { 'content-type': 'application/json', origin: BASE };

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		deps = { handle: db, baseUrl: BASE };
	}, 180_000);
	afterAll(() => db?.stop());

	it('stores a seed and returns the updates, and refuses other content types and other origins', async () => {
		const n = await createNote(w.ctx('member'), { project: w.projectKey, title: 'Api', body: '' });
		const doc = new Y.Doc();
		doc.getText('t').insert(0, 'hi');
		const body = {
			epoch: n.epoch,
			seed: true,
			updates: [Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')]
		};
		const ok = await call('POST', `${live(n.ref)}/updates`, { as: 'member', body, headers: json });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ ok: true, seqs: [1] });
		const read = await call('GET', `${live(n.ref)}/updates`, { as: 'viewer' });
		expect(read.status).toBe(200);
		expect((read.body as { updates: unknown[] }).updates).toHaveLength(1);
		// A form type, a missing type, another site and a missing Origin are all refused for a cookie caller
		for (const headers of [
			{ 'content-type': 'text/plain', origin: BASE },
			{ origin: BASE },
			{ 'content-type': 'application/json', origin: 'https://evil.example' },
			{ 'content-type': 'application/json' }
		]) {
			const r = await call('POST', `${live(n.ref)}/presence`, {
				as: 'member',
				body: { data: 'AQID' },
				headers
			});
			expect([403, 415]).toContain(r.status);
		}
		const presence = await call('POST', `${live(n.ref)}/presence`, {
			as: 'member',
			body: { data: 'AQID' },
			headers: json
		});
		expect(presence.status).toBe(200);
		// A viewer cannot post updates
		const viewer = await call('POST', `${live(n.ref)}/updates`, {
			as: 'viewer',
			body: { epoch: n.epoch, updates: body.updates },
			headers: json
		});
		expect(viewer.status).toBe(403);
		// Garbage is a 400
		const bad = await call('POST', `${live(n.ref)}/updates`, {
			as: 'member',
			body: { epoch: n.epoch, updates: ['@@@'] },
			headers: json
		});
		expect(bad.status).toBe(400);
	});
});
