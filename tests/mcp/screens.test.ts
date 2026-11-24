// THE SCREEN MCP TOOLS THROUGH A REAL CLIENT (AFB-20261124-0926): ADD, LIST, ANNOTATE AND REMOVE, WITH THEIR LIMITS

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createItem } from '../../src/lib/server/ops/items';
import { createToken } from '../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../support/db';
import { call, connect } from '../support/mcp';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const ALL = ['read', 'comment', 'write', 'complete', 'delete', 'manage'] as const;
const b64 = (n: number) =>
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, n % 256]).toString('base64');

// -- FUNCTIONS -- //

describe('screen tools', () => {
	let db: TestDb;
	let w: World;
	let member: Awaited<ReturnType<typeof connect>>;
	let reader: Awaited<ReturnType<typeof connect>>;
	let ref = '';
	let sessionId = '';

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const deps = {
			handle: db,
			storage: memoryStorage('mcp-screen-secret-0123456789abcd'),
			baseUrl: BASE
		};
		const tokenFor = async (who: keyof World['people'], permissions: string[], name: string) =>
			(await createToken(w.ctx(who), { name, permissions: permissions as never })).token;
		member = await connect(deps, await tokenFor('member', ALL.slice(0, 5), 'member-agent'));
		reader = await connect(deps, await tokenFor('member', ['read'], 'reader-agent'));
		ref = (
			await createItem(w.ctx('member'), { project: w.projectKey, title: 'Screen tools', ...PLAN })
		).ref;
		sessionId = (await call(member, 'session_start', { tool: 'claude-code' })).sessionId;
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	it('lists the screen tools next to the others', async () => {
		const names = (await member.listTools()).tools.map((t) => t.name);
		for (const n of ['screen_add', 'screen_list', 'screen_annotate', 'screen_remove'])
			expect(names).toContain(n);
	});

	it('adds a screenshot, keeps the first as before, annotates it and removes it', async () => {
		const first = await call(member, 'screen_add', {
			sessionId,
			item: ref,
			screen: 'settings-members',
			mode: 'light',
			width: 1440,
			pngBase64: b64(1),
			caption: 'The members page'
		});
		expect(first.screen).toMatchObject({ role: 'before', untrusted: true });
		const second = await call(member, 'screen_add', {
			sessionId,
			item: ref,
			screen: 'settings-members',
			mode: 'light',
			width: 1440,
			pngBase64: b64(2)
		});
		expect(second.screen.role).toBe('after');
		const pin = await call(member, 'screen_annotate', {
			sessionId,
			screen: second.screen.id,
			kind: 'pin',
			x: 0.5,
			y: 0.4,
			body: 'The title and the button share a baseline'
		});
		expect(pin.annotation).toMatchObject({ kind: 'pin', untrusted: true });
		const done = await call(member, 'screen_annotate', {
			sessionId,
			annotation: pin.annotation.id,
			resolved: true
		});
		expect(done.annotation.resolved).toBe(true);
		const listed = await call(member, 'screen_list', { sessionId, item: ref });
		expect(listed.screens).toHaveLength(2);
		// Nothing a reader gets carries a storage key
		expect(JSON.stringify(listed)).not.toMatch(/storage|screens\//);
		const gone = await call(member, 'screen_remove', { sessionId, screen: first.screen.id });
		expect(gone.removed).toBe(true);
	});

	it('refuses a picture that is not a PNG, a name that is not a slug and a reader that tries to write', async () => {
		const notPng = await call(member, 'screen_add', {
			sessionId,
			item: ref,
			screen: 'other',
			mode: 'dark',
			width: 390,
			pngBase64: Buffer.from('<svg></svg>').toString('base64')
		});
		expect(notPng.error?.code).toBe('INVALID');
		// A name that is not a slug is refused by the tool's own input schema, before any verb runs
		const badName = await member.callTool({
			name: 'screen_add',
			arguments: {
				sessionId,
				item: ref,
				screen: 'Has Spaces',
				mode: 'dark',
				width: 390,
				pngBase64: b64(3)
			}
		});
		expect(badName.isError).toBe(true);
		const denied = await call(reader, 'screen_add', {
			item: ref,
			screen: 'other',
			mode: 'dark',
			width: 390,
			pngBase64: b64(4)
		});
		expect(denied.error?.code).toBe('FORBIDDEN');
		const seen = await call(reader, 'screen_list', { item: ref });
		expect(seen.screens.length).toBeGreaterThan(0);
	});
});
