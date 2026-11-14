// THE MOCKUP REST ENDPOINTS (AFB-20261107-0346) THROUGH THE DISPATCHER, AND THE BODY LIMITS THE API ROUTE READS WITH

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { bodyLimit, readBodyCapped } from '../../src/lib/server/api/body';
import { handleApi, type ApiDeps, type ApiResponse } from '../../src/lib/server/api/dispatch';
import { buildOpenApi } from '../../src/lib/server/api/openapi';
import { match } from '../../src/lib/server/api/routes';
import { createItem } from '../../src/lib/server/ops/items';
import { MAX_MOCKUP_BYTES, MAX_SCREENSHOT_BYTES } from '../../src/lib/server/ops/mockups';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const PAGE = new TextEncoder().encode(
	'<html><body><main data-screen="main" data-state="default"><p data-ref="greeting">api page</p></main></body></html>'
);
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

// -- FUNCTIONS -- //

describe('mockup body limits', () => {
	it('gives each endpoint its own cap, and nothing to a read', () => {
		expect(bodyLimit('GET', '/orgs/a/mockups')).toBe(0);
		expect(bodyLimit('DELETE', '/orgs/a/mockups/1')).toBe(0);
		expect(bodyLimit('POST', '/orgs/a/mockups')).toBeGreaterThan(MAX_MOCKUP_BYTES);
		expect(bodyLimit('POST', '/orgs/a/mockups')).toBeLessThan(MAX_MOCKUP_BYTES + 1024 * 1024);
		expect(bodyLimit('PUT', '/orgs/a/projects/P/mockup-kit')).toBeGreaterThan(MAX_MOCKUP_BYTES);
		expect(bodyLimit('PUT', '/orgs/a/mockups/x/versions/2/screenshot')).toBeGreaterThan(
			MAX_SCREENSHOT_BYTES
		);
		expect(bodyLimit('PUT', '/orgs/a/mockups/x/versions/2/screenshot')).toBeLessThan(
			MAX_MOCKUP_BYTES
		);
		expect(bodyLimit('PUT', '/orgs/a/mockups/x/versions/2/notes')).toBe(1024 * 1024);
		expect(bodyLimit('POST', '/orgs/a/mockups/x/pins')).toBe(1024 * 1024);
		// Everything else keeps the general limit, which fits an attachment
		expect(bodyLimit('POST', '/orgs/a/items/X/attachments')).toBeGreaterThan(100 * 1024 * 1024);
	});

	it('reads a body up to its cap and refuses a larger one from its declared size or while it streams', async () => {
		const post = (body: BodyInit, headers: Record<string, string> = {}) =>
			new Request('http://x.test/', {
				method: 'POST',
				body,
				headers,
				duplex: 'half'
			} as RequestInit);
		expect((await readBodyCapped(post(new Uint8Array(10)), 10))?.byteLength).toBe(10);
		expect(await readBodyCapped(post(new Uint8Array(11)), 10)).toBeNull();
		// A sender that lies about its length is still cut while streaming
		const lying = post(new Uint8Array(50), { 'content-length': '5' });
		expect(await readBodyCapped(lying, 10)).toBeNull();
		expect(
			await readBodyCapped(post(new Uint8Array(100), { 'content-length': '100' }), 10)
		).toBeNull();
		expect((await readBodyCapped(new Request('http://x.test/'), 10))?.byteLength).toBe(0);
	});
});

describe('mockup endpoints', () => {
	let db: TestDb;
	let w: World;
	let deps: ApiDeps;
	let ref = '';
	const slug = () => `world-${w.projectKey.slice(3)}`;
	const base = () => `/orgs/${slug()}`;
	const call = (
		method: string,
		path: string,
		o: {
			as?: keyof World['people'];
			body?: unknown;
			query?: Record<string, string>;
			bytes?: Uint8Array;
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
					o.bytes ??
					(o.body !== undefined
						? new TextEncoder().encode(JSON.stringify(o.body))
						: new Uint8Array()),
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
			storage: memoryStorage('api-mockup-secret-0123456789abcdef'),
			baseUrl: BASE
		};
		ref = (
			await createItem(w.ctx('member'), { project: w.projectKey, title: 'Mockup api', ...PLAN })
		).ref;
	}, 120_000);
	afterAll(() => db?.stop());

	it('is in the route table and the OpenAPI document, with no secrets', () => {
		expect(match('POST', '/orgs/acme/mockups')).toMatchObject({ route: { upload: true } });
		expect(match('PUT', '/orgs/acme/projects/P/mockup-kit')).toMatchObject({
			route: { upload: true }
		});
		const doc = buildOpenApi(BASE);
		for (const p of [
			'/orgs/{org}/mockups',
			'/orgs/{org}/mockups/{id}/public-link',
			'/orgs/{org}/projects/{project}/mockup-kit'
		])
			expect(Object.keys(doc.paths)).toContain(p);
		for (const p of [
			'/orgs/{org}/projects/{project}/mockup-settings',
			'/orgs/{org}/projects/{project}/mockup-templates'
		])
			expect(Object.keys(doc.paths)).not.toContain(p);
		expect(JSON.stringify(doc)).not.toMatch(/storage_key|public_token_hash/);
	});

	it('publishes with the file as the body, adds notes and a screenshot, reads, restores and lists', async () => {
		expect(
			(await call('POST', `${base()}/mockups`, { query: { item: ref }, bytes: PAGE })).status
		).toBe(401);
		expect(
			(await call('POST', `${base()}/mockups`, { as: 'viewer', query: { item: ref }, bytes: PAGE }))
				.status
		).toBe(403);
		const made = await call('POST', `${base()}/mockups`, {
			as: 'member',
			query: { item: ref, title: 'Rooms' },
			bytes: PAGE,
			key: 'api-mockup-publish-1'
		});
		expect(made.status).toBe(200);
		expect(b(made).version.number).toBe(1);
		expect(b(made).projectKey).toBe(w.projectKey);
		expect(b(made).warnings).toEqual([]);
		const again = await call('POST', `${base()}/mockups`, {
			as: 'member',
			query: { item: ref, title: 'Rooms' },
			bytes: PAGE,
			key: 'api-mockup-publish-1'
		});
		expect(b(again).version.id).toBe(b(made).version.id);
		const id = b(made).mockup.id as string;
		const notes = await call('PUT', `${base()}/mockups/${id}/versions/1/notes`, {
			as: 'member',
			body: { keepNotes: 'Keep the nav.', freeNotes: 'Colours free.' }
		});
		expect(notes.status).toBe(200);
		const shot = await call('PUT', `${base()}/mockups/${id}/versions/1/screenshot`, {
			as: 'member',
			bytes: PNG
		});
		expect(b(shot)).toMatchObject({ version: 1, hasScreenshot: true });
		expect(
			(
				await call('PUT', `${base()}/mockups/${id}/versions/1/screenshot`, {
					as: 'member',
					bytes: PAGE
				})
			).status
		).toBe(400);
		const got = await call('GET', `${base()}/mockups/${id}`, { as: 'viewer' });
		expect(b(got).notes).toMatchObject({ untrusted: true, keep: 'Keep the nav.' });
		const html = await call('GET', `${base()}/mockups/${id}/html`, {
			as: 'viewer',
			query: { offset: '6', limit: '6' }
		});
		expect(b(html)).toMatchObject({ untrusted: true, html: '<body>', more: true });
		// A stray letter in a version is a 400, never a database error
		for (const bad of ['abc', '0', '1.5'])
			expect(
				(
					await call('GET', `${base()}/mockups/${id}/html`, {
						as: 'viewer',
						query: { version: bad }
					})
				).status
			).toBe(400);
		expect(
			(await call('PUT', `${base()}/mockups/${id}/versions/x/notes`, { as: 'member', body: {} }))
				.status
		).toBe(400);
		await call('POST', `${base()}/mockups`, { as: 'member', query: { mockup: id }, bytes: PAGE });
		const restored = await call('POST', `${base()}/mockups/${id}/restore`, {
			as: 'member',
			body: { version: 1 }
		});
		expect(b(restored).version).toMatchObject({ number: 3, restoredFrom: 1 });
		const list = await call('GET', `${base()}/projects/${w.projectKey}/mockups`, { as: 'viewer' });
		expect(b(list).mockups).toHaveLength(1);
		expect(
			(await call('POST', `${base()}/mockups/${id}/restore`, { as: 'member', body: {} })).status
		).toBe(400);
	});

	it('pins, the public link, linking, the trash and the project settings follow the role rules', async () => {
		const made = await call('POST', `${base()}/mockups`, {
			as: 'member',
			query: { item: ref, another: 'true' },
			bytes: PAGE
		});
		const id = b(made).mockup.id as string;
		const pin = await call('POST', `${base()}/mockups/${id}/pins`, {
			as: 'member',
			body: { version: 1, x: 10, y: 20, hint: 'h1', body: 'Bigger please' }
		});
		expect(pin.status).toBe(200);
		expect(
			(
				await call('POST', `${base()}/mockups/${id}/pins`, {
					as: 'viewer',
					body: { version: 1, x: 1, y: 1, body: 'no' }
				})
			).status
		).toBe(403);
		const pins = await call('GET', `${base()}/mockups/${id}/pins`, {
			as: 'viewer',
			query: { version: '1' }
		});
		expect(b(pins).pins).toHaveLength(1);
		// A pin takes a device, resolves and reopens through its own route, and a made-up device is refused
		const phonePin = await call('POST', `${base()}/mockups/${id}/pins`, {
			as: 'member',
			body: { version: 1, x: 5, y: 6, body: 'On the phone', device: 'phone' }
		});
		expect(b(phonePin).pin).toMatchObject({ device: 'phone', resolved: false });
		expect(
			(
				await call('POST', `${base()}/mockups/${id}/pins`, {
					as: 'member',
					body: { version: 1, x: 5, y: 6, body: 'x', device: 'watch' }
				})
			).status
		).toBe(400);
		const resolveUrl = `${base()}/mockup-pins/${b(phonePin).pin.id}/resolve`;
		expect(
			(await call('POST', resolveUrl, { as: 'viewer', body: { resolved: true } })).status
		).toBe(403);
		expect(
			(await call('POST', resolveUrl, { as: 'member', body: { resolved: 'yes' } })).status
		).toBe(400);
		const resolvedRes = await call('POST', resolveUrl, { as: 'member', body: { resolved: true } });
		expect(b(resolvedRes).pin).toMatchObject({ resolved: true, resolvedBy: expect.any(String) });
		expect(
			b(await call('POST', resolveUrl, { as: 'admin', body: { resolved: false } })).pin.resolved
		).toBe(false);
		expect(
			(await call('DELETE', `${base()}/mockup-pins/${b(phonePin).pin.id}`, { as: 'member' })).status
		).toBe(200);
		expect(
			(await call('DELETE', `${base()}/mockup-pins/${b(pin).pin.id}`, { as: 'viewer' })).status
		).toBe(403);
		expect(
			(await call('DELETE', `${base()}/mockup-pins/${b(pin).pin.id}`, { as: 'member' })).status
		).toBe(200);
		expect(
			(
				await call('POST', `${base()}/mockups/${id}/public-link`, {
					as: 'member',
					body: { on: true }
				})
			).status
		).toBe(403);
		const on = await call('POST', `${base()}/mockups/${id}/public-link`, {
			as: 'admin',
			body: { on: true }
		});
		expect(b(on).url).toMatch(/^http:\/\/localhost:5180\/m\//);
		expect(
			(await call('GET', `${base()}/mockups/${id}`, { as: 'viewer' })).body
		).not.toHaveProperty('token');
		const unlinked = await call('POST', `${base()}/mockups/${id}/link`, {
			as: 'member',
			body: { item: null }
		});
		expect(b(unlinked).mockup.itemId).toBeNull();
		expect((await call('DELETE', `${base()}/mockups/${id}`, { as: 'member' })).status).toBe(200);
		expect((await call('GET', `${base()}/mockups/${id}`, { as: 'member' })).status).toBe(404);
		expect(
			(await call('POST', `${base()}/mockups/${id}/restore-from-trash`, { as: 'member' })).status
		).toBe(200);
		expect(
			b(await call('GET', `${base()}/mockups/${id}`, { as: 'member' })).mockup.publicLinkOn
		).toBe(false);

		// The style and template routes are gone
		const settings = `${base()}/projects/${w.projectKey}/mockup-settings`;
		expect((await call('GET', settings, { as: 'viewer' })).status).toBe(404);
		const kit = `${base()}/projects/${w.projectKey}/mockup-kit`;
		expect(
			(await call('PUT', kit, { as: 'viewer', query: { builtFromCommit: 'a' }, bytes: PAGE }))
				.status
		).toBe(403);
		const saved = await call('PUT', kit, {
			as: 'member',
			query: { builtFromCommit: 'abc', summary: 'One' },
			bytes: PAGE
		});
		expect(b(saved)).toMatchObject({ number: 1, stale: false });
		// The kit answer carries the plain words check: this page embeds no font, has no icons and no marked head
		expect((b(saved).warnings as string[]).join(' ')).toContain('embeds no font file');
		expect(b(await call('PUT', kit, { as: 'admin', query: { stale: 'true' } }))).toMatchObject({
			stale: true,
			warnings: []
		});
		// A summary that is too long is told in words, not as a schema path
		const long = await call('PUT', kit, {
			as: 'admin',
			query: { summary: 'x'.repeat(20_001) },
			bytes: PAGE
		});
		expect(long.status).toBe(400);
		expect(JSON.stringify(long.body)).toContain(
			'The summary is 20,001 characters; the limit is 20,000. Shorten it.'
		);
		const empty = await call('POST', `${base()}/mockups`, { as: 'member', query: { item: ref } });
		expect(empty.status).toBe(400);
		expect(JSON.stringify(empty.body)).toContain(
			'No page was sent. Send it in html, or push the file with the bridge command.'
		);
		expect(b(await call('GET', kit, { as: 'viewer', query: { limit: '6' } }))).toMatchObject({
			untrusted: true,
			html: '<html>',
			stale: true
		});
	});

	it('takes a bundle of parts, lists and reads them, gives the contract and the seeded inventory, and saves the shell (AFB-20261114-0409)', async () => {
		const shell = new TextEncoder().encode(
			'<html><head><!--afb-part:styles--></head><body><main><!--afb-part:screens--></main><!--afb-part:behavior--></body></html>'
		);
		const saveShell = `${base()}/projects/${w.projectKey}/mockup-shell`;
		expect((await call('PUT', saveShell, { bytes: shell })).status).toBe(401);
		expect((await call('PUT', saveShell, { as: 'viewer', bytes: shell })).status).toBe(403);
		expect((await call('PUT', saveShell, { as: 'member', bytes: shell })).status).toBe(200);
		expect(b(await call('GET', saveShell, { as: 'viewer' }))).toMatchObject({ untrusted: true });
		const planRef = (
			await createItem(w.ctx('member'), { project: w.projectKey, title: 'Bundle api', ...PLAN })
		).ref;
		const parts = [
			{ kind: 'style', key: 'page', content: '.card{transition:opacity .2s ease-out}' },
			{
				kind: 'screen',
				key: 'today',
				content: '<section data-ref="screen-today"><h1 data-ref="title">Today</h1></section>'
			},
			{ kind: 'behavior', key: 'main', content: 'const go = 1;' },
			{
				kind: 'contract',
				key: 'contract',
				content: JSON.stringify({ refs: [{ ref: 'title', binding: 'keep' }] })
			}
		];
		expect(
			(await call('POST', `${base()}/mockups/bundle`, { body: { item: planRef, parts } })).status
		).toBe(401);
		expect(
			(
				await call('POST', `${base()}/mockups/bundle`, {
					as: 'viewer',
					body: { item: planRef, parts }
				})
			).status
		).toBe(403);
		const made = await call('POST', `${base()}/mockups/bundle`, {
			as: 'member',
			body: { item: planRef, parts }
		});
		expect(made.status).toBe(200);
		const id = b(made).mockup.id as string;
		expect(b(made).composed.parts).toBe(5);
		expect(b(made).readCost.parts).toBeGreaterThan(2);
		const listed = await call('GET', `${base()}/mockups/${id}/parts`, { as: 'viewer' });
		expect(b(listed).parts.map((p: { kind: string }) => p.kind)).toEqual([
			'skeleton',
			'style',
			'screen',
			'behavior',
			'contract'
		]);
		const one = await call('GET', `${base()}/mockups/${id}/parts/screen/today`, { as: 'viewer' });
		expect(b(one).content).toContain('Today');
		expect(
			(await call('GET', `${base()}/mockups/${id}/parts/screen/nope`, { as: 'viewer' })).status
		).toBe(404);
		expect(
			b(await call('GET', `${base()}/mockups/${id}/contract`, { as: 'viewer' })).contract.refs
		).toHaveLength(1);
		const inventory = await call('GET', `${base()}/mockups/${id}/inventory`, {
			as: 'viewer',
			query: { scopes: 'today' }
		});
		expect(b(inventory).markdown).toContain('region data-ref=title');
		expect(b(inventory).markdown).toContain('motion css .card: transition opacity .2s ease-out');
		expect(
			(
				await call('GET', `${base()}/mockups/${id}/inventory`, {
					as: 'viewer',
					query: { scopes: 'nope' }
				})
			).status
		).toBe(404);
		expect((await call('GET', `${base()}/mockups/${id}/inventory`, { as: 'viewer' })).status).toBe(
			400
		);
	});

	it('takes a render of a screen at a width, and the routes are in the table', async () => {
		expect(match('POST', '/orgs/acme/mockups/bundle')).toMatchObject({ route: {} });
		expect(match('PUT', '/orgs/acme/mockups/x/versions/2/renders')).toMatchObject({ route: {} });
		expect(bodyLimit('POST', '/orgs/a/mockups/bundle')).toBeGreaterThan(MAX_MOCKUP_BYTES);
		expect(bodyLimit('PUT', '/orgs/a/mockups/x/versions/2/renders')).toBeGreaterThan(
			MAX_SCREENSHOT_BYTES
		);
		const made = await call('POST', `${base()}/mockups`, {
			as: 'member',
			query: { item: ref },
			bytes: PAGE
		});
		const id = b(made).mockup.id as string;
		const put = await call(
			'PUT',
			`${base()}/mockups/${id}/versions/${b(made).version.number}/renders`,
			{
				as: 'member',
				body: { screen: 'main', width: 1280, elements: [{ ref: 'greeting', text: 'api page' }] }
			}
		);
		expect(b(put)).toMatchObject({ screen: 'main', state: 'default', width: 1280, elements: 1 });
		expect(
			(
				await call('PUT', `${base()}/mockups/${id}/versions/${b(made).version.number}/renders`, {
					as: 'viewer',
					body: { screen: 'main', width: 1280, elements: [] }
				})
			).status
		).toBe(403);
	});
});
