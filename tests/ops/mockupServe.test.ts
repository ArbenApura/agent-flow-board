// MOCKUP ROUTES (AFB-20261107-0346): THE SAME ISOLATING HEADERS ON EVERY ANSWER, SIGNED LINKS, THE PUBLIC LINK AND THE PIN SCRIPT

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { isMockupKey, mockupKey } from '../../src/lib/server/mockups/keys';
import {
	PUBLIC_LIMIT,
	publicRateAllowed,
	resetPublicRate
} from '../../src/lib/server/mockups/limit';
import {
	MOCKUP_CSP,
	injectPinScript,
	readsNoSession,
	servePublicMockup,
	serveMemberMockup,
	signMockupGrant
} from '../../src/lib/server/mockups/serve';
import { createItem, trashItem, updateItem } from '../../src/lib/server/ops/items';
import {
	mockupFileGrant,
	publishMockup,
	setMockupPublicLink,
	trashMockup
} from '../../src/lib/server/ops/mockups';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const SECRET = 'mockup-serve-secret-0123456789abcdef';
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const PAGE = new TextEncoder().encode('<html><body><h1>Hello</h1></body></html>');

// -- FUNCTIONS -- //

describe('mockup routes', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage(SECRET);
	const as = (who: keyof World['people']) => ({
		...w.ctx(who),
		services: { storage, baseUrl: 'https://afb.test' }
	});
	const deps = () => ({ handle: db, storage });
	const plan = (title: string) =>
		createItem(as('member'), { project: w.projectKey, title, ...PLAN });
	const asParams = (g: Awaited<ReturnType<typeof mockupFileGrant>>) => ({
		org: g.orgId,
		project: g.projectId,
		mockup: g.mockupId,
		version: String(g.version),
		kind: g.kind
	});
	const linkOf = (g: Awaited<ReturnType<typeof mockupFileGrant>>, now?: number) => {
		const u = new URL(signMockupGrant(SECRET, g, now), 'https://afb.test');
		return { path: u.pathname, exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') };
	};
	const expectIsolated = (res: Response) => {
		expect(res.headers.get('content-security-policy')).toBe(MOCKUP_CSP);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('x-robots-tag')).toBe('noindex');
		expect(res.headers.get('cache-control')).toBe('no-store');
	};

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	it('the policy header is the exact sandbox the plan names', () => {
		expect(MOCKUP_CSP).toBe(
			"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"
		);
	});

	it('a signed link serves the page with the pin script and its screenshot, with the header on each', async () => {
		const m = await publishMockup(
			as('member'),
			{ item: (await plan('Serve plan')).ref },
			PAGE,
			PNG
		);
		const g = await mockupFileGrant(as('viewer'), m.mockup.id);
		const { exp, sig } = linkOf(g);
		const res = await serveMemberMockup(deps(), SECRET, asParams(g), { exp, sig });
		expect(res.status).toBe(200);
		expectIsolated(res);
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		const body = await res.text();
		expect(body).toContain('<h1>Hello</h1>');
		expect(body).toContain('afb-mockup-pin');
		const shot = await mockupFileGrant(as('viewer'), m.mockup.id, { screenshot: true });
		const s = linkOf(shot);
		const shotRes = await serveMemberMockup(deps(), SECRET, asParams(shot), s);
		expect(shotRes.status).toBe(200);
		expect(shotRes.headers.get('content-type')).toBe('image/png');
		expectIsolated(shotRes);
		await expect(
			mockupFileGrant(as('viewer'), m.mockup.id, { version: 1, screenshot: true })
		).resolves.toMatchObject({ kind: 'shot' });
	});

	it('an unsigned, tampered, expired or wrong link answers the plain page with the same header', async () => {
		const m = await publishMockup(as('member'), { item: (await plan('Refuse plan')).ref }, PAGE);
		const g = await mockupFileGrant(as('member'), m.mockup.id);
		const { exp, sig } = linkOf(g);
		const refused = [
			await serveMemberMockup(deps(), SECRET, asParams(g), { exp: null, sig: null }),
			await serveMemberMockup(deps(), SECRET, asParams(g), { exp, sig: 'x'.repeat(43) }),
			await serveMemberMockup(deps(), SECRET, { ...asParams(g), version: '2' }, { exp, sig }),
			await serveMemberMockup(deps(), SECRET, { ...asParams(g), kind: 'shot' }, { exp, sig }),
			await serveMemberMockup(deps(), 'another-secret-0123456789abcdef!!', asParams(g), {
				exp,
				sig
			}),
			await serveMemberMockup(
				deps(),
				SECRET,
				{ ...asParams(g), mockup: 'not-a-uuid' },
				{ exp, sig }
			)
		];
		for (const r of refused) {
			expect(r.status).toBe(404);
			expectIsolated(r);
		}
		const old = linkOf(g, Date.now() - 3600_000);
		const expired = await serveMemberMockup(deps(), SECRET, asParams(g), old);
		expect(expired.status).toBe(404);
		expectIsolated(expired);
		// A trashed mockup is gone even for a link that is still inside its 5 minutes
		await trashMockup(as('member'), m.mockup.id);
		const gone = await serveMemberMockup(deps(), SECRET, asParams(g), { exp, sig });
		expect(gone.status).toBe(404);
		expectIsolated(gone);
	});

	it('a failure inside the route is a 500 that still carries the header and no detail', async () => {
		const m = await publishMockup(as('member'), { item: (await plan('Broken plan')).ref }, PAGE);
		const g = await mockupFileGrant(as('member'), m.mockup.id);
		const { exp, sig } = linkOf(g);
		const broken = {
			handle: db,
			storage: {
				...storage,
				get: async () => {
					throw new Error('secret detail');
				}
			}
		};
		const res = await serveMemberMockup(broken, SECRET, asParams(g), { exp, sig });
		expect(res.status).toBe(500);
		expectIsolated(res);
		expect(await res.text()).not.toContain('secret detail');
		const pub = await publishMockup(
			as('member'),
			{ item: (await plan('Broken public')).ref },
			PAGE
		);
		const on = await setMockupPublicLink(as('admin'), pub.mockup.id, true);
		const pubRes = await servePublicMockup(broken, on.token!);
		expect(pubRes.status).toBe(500);
		expectIsolated(pubRes);
		expect(pubRes.headers.get('referrer-policy')).toBe('no-referrer');
	});

	it('the public link serves its mockup, and every kind of failure is the same plain page', async () => {
		const p = await plan('Public serve plan');
		const m = await publishMockup(as('member'), { item: p.ref }, PAGE, PNG);
		const none = await servePublicMockup(deps(), 'A'.repeat(32));
		expect(none.status).toBe(404);
		const plain = await none.text();
		const off = await servePublicMockup(deps(), 'B'.repeat(32));
		expect(await off.text()).toBe(plain);
		const on = await setMockupPublicLink(as('admin'), m.mockup.id, true);
		const ok = await servePublicMockup(deps(), on.token!);
		expect(ok.status).toBe(200);
		expectIsolated(ok);
		expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
		const html = await ok.text();
		expect(html).toContain('<h1>Hello</h1>');
		// The public view never carries the pin script
		expect(html).not.toContain('afb-mockup-pin');
		const shot = await servePublicMockup(deps(), on.token!, undefined, true);
		expect(shot.headers.get('content-type')).toBe('image/png');
		expect(none.headers.get('referrer-policy')).toBe('no-referrer');
		expectIsolated(none);
		// A token with odd characters never reaches the database
		expect((await servePublicMockup(deps(), "x' or 1=1 --")).status).toBe(404);
		// A plan that goes private, and a plan in the trash, give the plain page
		await updateItem(as('member'), { item: p.ref, visibility: 'private' });
		expect(await (await servePublicMockup(deps(), on.token!)).text()).toBe(plain);
		await updateItem(as('member'), { item: p.ref, visibility: 'public' });
		expect((await servePublicMockup(deps(), on.token!)).status).toBe(404);
		const again = await setMockupPublicLink(as('admin'), m.mockup.id, true);
		expect((await servePublicMockup(deps(), again.token!)).status).toBe(200);
		await trashItem(as('member'), p.ref);
		expect((await servePublicMockup(deps(), again.token!)).status).toBe(404);
		// A token of one organisation reads nothing of another: the other org's rows are not reachable by any token but their own
		expect((await servePublicMockup(deps(), 'C'.repeat(32))).status).toBe(404);
	});

	it('the pin script goes before the last closing body tag, or at the end, and a page script is left alone', () => {
		expect(injectPinScript('<html><body>x</body></html>')).toMatch(
			/x<script>.*<\/script><\/body>/s
		);
		expect(injectPinScript('<BODY>x</BODY>')).toMatch(/x<script>.*<\/script><\/BODY>/s);
		expect(injectPinScript('plain text')).toMatch(/^plain text<script>/);
		const own = '<body><script>var a="</body>";</script></body>';
		const out = injectPinScript(own);
		expect(out.startsWith('<body><script>var a="</body>";</script><script>')).toBe(true);
		expect(out.endsWith('</script></body>')).toBe(true);
		// Only the pin script talks to its own parent, and it posts nothing but a type, two numbers and a hint
		const script = injectPinScript('');
		expect(script).toContain('e.source!==parent');
		expect(script).not.toMatch(/cookie|localStorage|fetch\(|XMLHttpRequest/);
	});

	it('the mockup routes read no session, and mockup keys have their own prefix', () => {
		expect(readsNoSession('/m/abc')).toBe(true);
		expect(readsNoSession('/m/abc/file')).toBe(true);
		expect(readsNoSession('/mf/o/p/m/1/html')).toBe(true);
		expect(readsNoSession('/mockups')).toBe(false);
		expect(readsNoSession('/arbenger/AFB/mockups')).toBe(false);
		expect(isMockupKey(mockupKey('o', 'p', 'html'))).toBe(true);
		expect(isMockupKey('o/p/file.png')).toBe(false);
		expect(isMockupKey('mockups-not/x')).toBe(false);
	});

	it('the public routes are limited per address', () => {
		resetPublicRate();
		for (let i = 0; i < PUBLIC_LIMIT; i++) expect(publicRateAllowed('1.2.3.4')).toBe(true);
		expect(publicRateAllowed('1.2.3.4')).toBe(false);
		expect(publicRateAllowed('5.6.7.8')).toBe(true);
		expect(publicRateAllowed('1.2.3.4', Date.now() + 61_000)).toBe(true);
	});
});
