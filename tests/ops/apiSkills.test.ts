// THE SKILL ROUTES OVER REST (AFB-20261018-0622): ROLE REFUSALS, VALIDATION, IDEMPOTENCY AND THE REVISION READ

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { handleApi, type ApiDeps, type ApiResponse } from '../../src/lib/server/api/dispatch';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';

// -- TESTS -- //

describe('skill routes', () => {
	let db: TestDb;
	let w: World;
	let deps: ApiDeps;
	let created: { id: string; name: string; version: number; revision: number };
	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		deps = { handle: db, baseUrl: BASE };
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	const slug = () => `world-${w.projectKey.slice(3)}`;
	const call = (
		method: string,
		path: string,
		options: { as?: keyof World['people']; body?: unknown; key?: string } = {}
	): Promise<ApiResponse> => {
		const headers = new Headers();
		if (options.key) headers.set('idempotency-key', options.key);
		return handleApi(
			{
				method,
				path,
				query: {},
				headers,
				body:
					options.body !== undefined
						? new TextEncoder().encode(JSON.stringify(options.body))
						: new Uint8Array(),
				session: options.as ? { id: w.people[options.as], name: options.as } : null
			},
			deps
		);
	};
	const base = () => `/orgs/${slug()}/projects/${w.projectKey}/skills`;

	it('creates a skill as a member and reads it back as a viewer', async () => {
		const made = await call('POST', base(), {
			as: 'member',
			body: {
				name: 'release-notes',
				summary: 'How we write the release notes',
				body: 'Read the commits since the last tag.'
			}
		});
		expect(made.status).toBe(200);
		created = made.body as typeof created;
		expect(created.revision).toBe(1);

		const list = await call('GET', base(), { as: 'viewer' });
		expect(list.status).toBe(200);
		expect((list.body as { name: string }[]).map((s) => s.name)).toContain('release-notes');

		const read = await call('GET', `${base()}/release-notes`, { as: 'viewer' });
		expect(read.status).toBe(200);
		expect((read.body as { text: string; source: string }).source).toBe('project');
		expect((read.body as { text: string }).text).toContain('Read the commits');
	});

	it('refuses a viewer write, a guest read, a built-in name and a duplicate, with plain messages', async () => {
		const viewer = await call('PATCH', `/orgs/${slug()}/skills/${created.id}`, {
			as: 'viewer',
			body: { body: 'Changed.' }
		});
		expect(viewer.status).toBe(403);

		const guest = await call('GET', base(), { as: 'guest' });
		expect(guest.status).toBe(404);

		const builtin = await call('POST', base(), {
			as: 'member',
			body: { name: 'flow', summary: 'Pretending', body: 'Body.' }
		});
		expect(builtin.status).toBe(400);
		expect(JSON.stringify(builtin.body)).toContain('own workflows');

		const dupe = await call('POST', base(), {
			as: 'member',
			body: { name: 'release-notes', summary: 'Again', body: 'Body.' }
		});
		expect(dupe.status).toBe(409);
		expect(JSON.stringify(dupe.body)).toContain('already exists');
	});

	it('saves a revision, refuses a stale save, and keeps the old text readable', async () => {
		const saved = await call('PATCH', `/orgs/${slug()}/skills/${created.id}`, {
			as: 'member',
			key: 'skills-api-save-1',
			body: { body: 'Read the commits, then write two paragraphs.', expectVersion: created.version }
		});
		expect(saved.status).toBe(200);
		const next = (saved.body as { skill: { version: number; revision: number } }).skill;
		expect(next.revision).toBe(2);

		// The same idempotency key answers with the first result and writes nothing twice
		const again = await call('PATCH', `/orgs/${slug()}/skills/${created.id}`, {
			as: 'member',
			key: 'skills-api-save-1',
			body: { body: 'Read the commits, then write two paragraphs.', expectVersion: created.version }
		});
		expect(again.status).toBe(200);

		const stale = await call('PATCH', `/orgs/${slug()}/skills/${created.id}`, {
			as: 'member',
			body: { body: 'A stale save.', expectVersion: created.version }
		});
		expect(stale.status).toBe(409);

		const revisions = await call('GET', `${base()}/release-notes/revisions`, { as: 'viewer' });
		expect((revisions.body as { revision: number }[]).map((r) => r.revision)).toEqual([2, 1]);
		const first = await call('GET', `${base()}/release-notes/revisions/1`, { as: 'viewer' });
		expect((first.body as { body: string }).body).toBe('Read the commits since the last tag.');
	});

	it('deletes a skill and stops serving it', async () => {
		const removed = await call('DELETE', `/orgs/${slug()}/skills/${created.id}`, {
			as: 'member'
		});
		expect(removed.status).toBe(200);
		const after = await call('GET', base(), { as: 'member' });
		expect((after.body as { name: string }[]).map((s) => s.name)).not.toContain('release-notes');
		const gone = await call('GET', `${base()}/release-notes`, { as: 'member' });
		expect(gone.status).toBe(404);
	});

	it('writes an organisation skill only as an owner, and reads it from the project', async () => {
		const denied = await call('POST', `/orgs/${slug()}/skills`, {
			as: 'member',
			body: { name: 'org-notes', summary: 'Org level', body: 'Organisation text.' }
		});
		expect(denied.status).toBe(403);
		const made = await call('POST', `/orgs/${slug()}/skills`, {
			as: 'owner',
			body: { name: 'org-notes', summary: 'Org level', body: 'Organisation text.' }
		});
		expect(made.status).toBe(200);
		const read = await call('GET', `${base()}/org-notes`, { as: 'viewer' });
		expect((read.body as { source: string }).source).toBe('org');
	});

	it('serves the organisation screen: its own list, its revisions, and a delete only an owner may do', async () => {
		const list = await call('GET', `/orgs/${slug()}/skills`, { as: 'viewer' });
		expect(list.status).toBe(200);
		const rows = list.body as { id: string; name: string; revision: number }[];
		expect(rows.map((s) => s.name)).toContain('org-notes');
		const id = rows.find((s) => s.name === 'org-notes')!.id;

		const revisions = await call('GET', `/orgs/${slug()}/skills/${id}/revisions`, { as: 'viewer' });
		expect((revisions.body as { revision: number }[]).length).toBe(1);
		const first = await call('GET', `/orgs/${slug()}/skills/${id}/revisions/1`, { as: 'viewer' });
		expect((first.body as { body: string }).body).toBe('Organisation text.');

		// A member cannot change it at the organisation level
		const denied = await call('PATCH', `/orgs/${slug()}/skills/${id}`, {
			as: 'member',
			body: { body: 'Member change.' }
		});
		expect(denied.status).toBe(403);

		const removed = await call('DELETE', `/orgs/${slug()}/skills/${id}`, { as: 'owner' });
		expect(removed.status).toBe(200);
		const after = await call('GET', `/orgs/${slug()}/skills`, { as: 'owner' });
		expect((after.body as { name: string }[]).map((s) => s.name)).not.toContain('org-notes');
	});
});
