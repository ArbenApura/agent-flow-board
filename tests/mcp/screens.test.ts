// THE SCREEN MCP TOOLS THROUGH A REAL CLIENT (AFB-20261124-0926): ADD, LIST AND REMOVE, WITH THEIR LIMITS

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
/** A small PNG-looking file with a real header, 1440 px wide, made different by its last byte. */
const b64 = (n: number) => {
	const b = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
	b[11] = 13;
	b.write('IHDR', 12, 'ascii');
	b.writeUInt32BE(1440, 16);
	b.writeUInt32BE(900, 20);
	b[30] = n % 256;
	return b.toString('base64');
};

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
		for (const n of ['screen_add', 'screen_list', 'screen_remove']) expect(names).toContain(n);
		// Annotations were removed: no tool for them
		expect(names).not.toContain('screen_annotate');
	});

	it('adds a screenshot, keeps the first as before and removes it', async () => {
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
		const listed = await call(member, 'screen_list', { sessionId, item: ref });
		expect(listed.screens).toHaveLength(2);
		// Nothing a reader gets carries a storage key
		expect(JSON.stringify(listed)).not.toMatch(/storage|screens\//);
		const gone = await call(member, 'screen_remove', { sessionId, screen: first.screen.id });
		expect(gone.removed).toBe(true);
	});

	it('says it when a plan in review with a design brief has no screens, at work_stop and in board_validate', async () => {
		const visible = (
			await createItem(w.ctx('member'), {
				project: w.projectKey,
				title: 'Visible tools plan',
				sections: [{ slug: 'design-brief', title: 'Design brief', body: 'A screen changes.' }]
			})
		).ref;
		await call(member, 'work_start', { sessionId, item: visible });
		// Not in review yet: nothing is said
		const early = await call(member, 'work_stop', { sessionId });
		expect(early.screensNotice).toBeUndefined();
		await db.admin.exec(`update item set status = 'IN REVIEW' where ref = '${visible}'`);
		const validated = await call(member, 'board_validate', { ids: [visible] });
		expect(JSON.stringify(validated)).toContain('in-review-without-screens');
		await call(member, 'work_start', { sessionId, item: visible });
		const stopped = await call(member, 'work_stop', { sessionId });
		expect(stopped.screensNotice).toContain(visible);
		// A screen on the tab ends the notice
		await call(member, 'screen_add', {
			sessionId,
			item: visible,
			screen: 'visible-tools',
			mode: 'light',
			width: 1440,
			pngBase64: b64(9)
		});
		await call(member, 'work_start', { sessionId, item: visible });
		const quiet = await call(member, 'work_stop', { sessionId });
		expect(quiet.screensNotice).toBeUndefined();
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
		// The picture comes under one name: none or both are refused, and each name alone works
		const base = { sessionId, item: ref, screen: 'names', mode: 'light', width: 1440 };
		expect((await call(member, 'screen_add', base)).error?.code).toBe('INVALID');
		expect(
			(await call(member, 'screen_add', { ...base, imageBase64: b64(5), pngBase64: b64(5) })).error
				?.code
		).toBe('INVALID');
		expect(
			(await call(member, 'screen_add', { ...base, imageBase64: b64(6) })).error
		).toBeUndefined();
		expect(
			(await call(member, 'screen_add', { ...base, pngBase64: b64(7) })).error
		).toBeUndefined();
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
