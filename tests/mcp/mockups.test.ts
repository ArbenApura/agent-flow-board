// THE MOCKUP MCP TOOLS THROUGH A REAL CLIENT (AFB-20261107-0346): PUBLISH, READ IN PARTS, RESTORE, LINK, STYLE AND KIT

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createItem } from '../../src/lib/server/ops/items';
import { createToken } from '../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../support/db';
import { call, connect } from '../support/mcp';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const PAGE = '<html><body><h1>Rooms</h1><p>Book a room</p></body></html>';
const ALL = ['read', 'comment', 'write', 'complete', 'delete', 'manage'] as const;

// -- FUNCTIONS -- //

describe('mockup tools', () => {
	let db: TestDb;
	let w: World;
	let deps: Parameters<typeof connect>[0];
	let member: Awaited<ReturnType<typeof connect>>;
	let admin: Awaited<ReturnType<typeof connect>>;
	let reader: Awaited<ReturnType<typeof connect>>;
	let ref = '';

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		deps = { handle: db, storage: memoryStorage('mcp-mockup-secret-0123456789abc'), baseUrl: BASE };
		const tokenFor = async (who: keyof World['people'], permissions: string[], name: string) =>
			(await createToken(w.ctx(who), { name, permissions: permissions as never })).token;
		member = await connect(deps, await tokenFor('member', ALL.slice(0, 5), 'member-agent'));
		admin = await connect(deps, await tokenFor('admin', [...ALL], 'admin-agent'));
		reader = await connect(deps, await tokenFor('member', ['read'], 'reader-agent'));
		ref = (
			await createItem(w.ctx('member'), { project: w.projectKey, title: 'Mockup tools', ...PLAN })
		).ref;
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});

	it('lists the nine mockup tools next to the others', async () => {
		const names = (await member.listTools()).tools.map((t) => t.name);
		for (const n of [
			'mockup_publish',
			'mockup_get',
			'mockup_list',
			'mockup_restore',
			'mockup_link',
			'mockup_style_get',
			'mockup_style_set',
			'mockup_kit_get',
			'mockup_kit_set'
		])
			expect(names).toContain(n);
		expect(names).toContain('session_start');
	});

	it('publishes as plain text, reads the notes first and the HTML only by part, and restores an earlier version', async () => {
		const s = await call(member, 'session_start', { tool: 'claude-code' });
		const first = await call(member, 'mockup_publish', {
			sessionId: s.sessionId,
			item: ref,
			html: PAGE,
			keepNotes: 'Keep the room list.',
			freeNotes: 'Colours are free.',
			requestId: 'mockup-tool-publish-1'
		});
		expect(first.error).toBeUndefined();
		expect(first.version.number).toBe(1);
		expect(first.warnings).toEqual([]);
		// The same request id answers the first result and writes nothing again
		const again = await call(member, 'mockup_publish', {
			sessionId: s.sessionId,
			item: ref,
			html: PAGE,
			keepNotes: 'Keep the room list.',
			freeNotes: 'Colours are free.',
			requestId: 'mockup-tool-publish-1'
		});
		expect(again.version.id).toBe(first.version.id);
		const id = first.mockup.id;
		await call(member, 'mockup_publish', {
			sessionId: s.sessionId,
			mockup: id,
			html: PAGE.replace('Rooms', 'Rooms two')
		});
		const notesOnly = await call(member, 'mockup_get', { mockup: id, version: 1 });
		expect(notesOnly).toMatchObject({ untrusted: true });
		expect(notesOnly.notes).toMatchObject({
			untrusted: true,
			keep: expect.stringContaining('room list')
		});
		expect(notesOnly.html).toBeUndefined();
		expect(JSON.stringify(notesOnly)).not.toContain('storage');
		const part = await call(member, 'mockup_get', {
			mockup: id,
			version: 1,
			htmlOffset: 6,
			htmlLimit: 6
		});
		expect(part.html).toMatchObject({ untrusted: true, html: '<body>', version: 1, more: true });
		const restored = await call(member, 'mockup_restore', {
			sessionId: s.sessionId,
			mockup: id,
			version: 1
		});
		expect(restored.version).toMatchObject({ number: 3, restoredFrom: 1 });
		const list = await call(member, 'mockup_list', { project: w.projectKey, item: ref });
		expect(list.mockups).toHaveLength(1);
		expect(list.mockups[0]).toMatchObject({ versions: 3, plan: { ref } });
	});

	it('says in plain words what to fix: a missing page, notes or a page that is too long, and warns about what will not render', async () => {
		const s = await call(member, 'session_start', { tool: 'claude-code' });
		const none = await call(member, 'mockup_publish', { sessionId: s.sessionId, item: ref });
		expect(none.error).toMatchObject({
			code: 'INVALID',
			message: 'No page was sent. Send it in html, or push the file with the bridge command.'
		});
		const notes = await call(member, 'mockup_publish', {
			sessionId: s.sessionId,
			item: ref,
			html: PAGE,
			keepNotes: 'k'.repeat(23_114)
		});
		expect(notes.error?.message).toBe(
			'The Keep notes are 23,114 characters; the limit is 20,000. Shorten them.'
		);
		const huge = await call(member, 'mockup_publish', {
			sessionId: s.sessionId,
			item: ref,
			html: 'x'.repeat(3_000_001)
		});
		expect(huge.error?.message).toContain(
			'The page is 3,000,001 characters; the limit is 3,000,000.'
		);
		expect(huge.error?.message).toContain('bridge command');
		const bad = await call(member, 'mockup_publish', {
			sessionId: s.sessionId,
			item: ref,
			html: '<html><head><link href="https://fonts.example/a.css" rel="stylesheet"></head><body><button>⚙ Settings</button></body></html>'
		});
		expect(bad.error).toBeUndefined();
		expect((bad.warnings as string[]).join(' ')).toContain('from the network');
		expect((bad.warnings as string[]).join(' ')).toContain('emoji or symbol');
	});

	it('a read only token cannot publish, and the public link and the project settings are for managers', async () => {
		const s = await call(member, 'session_start', { tool: 'claude-code' });
		const denied = await call(reader, 'mockup_publish', { item: ref, html: PAGE });
		expect(denied.error?.code).toBe('FORBIDDEN');
		const made = await call(member, 'mockup_publish', {
			sessionId: s.sessionId,
			item: ref,
			html: PAGE,
			another: true
		});
		const id = made.mockup.id;
		const asMember = await call(member, 'mockup_link', {
			sessionId: s.sessionId,
			mockup: id,
			publicLink: true
		});
		expect(asMember.error?.code).toBe('FORBIDDEN');
		const sa = await call(admin, 'session_start', { tool: 'claude-code' });
		const on = await call(admin, 'mockup_link', {
			sessionId: sa.sessionId,
			mockup: id,
			publicLink: true
		});
		expect(on.publicLink.url).toMatch(/\/m\/[A-Za-z0-9_-]{32,}$/);
		const off = await call(admin, 'mockup_link', {
			sessionId: sa.sessionId,
			mockup: id,
			publicLink: false
		});
		expect(off.publicLink.mockup.publicLinkOn).toBe(false);
		const empty = await call(admin, 'mockup_link', { sessionId: sa.sessionId, mockup: id });
		expect(empty.error?.code).toBe('INVALID');
		const noStyle = await call(member, 'mockup_style_set', {
			sessionId: s.sessionId,
			project: w.projectKey,
			style: 'Playful.'
		});
		expect(noStyle.error?.code).toBe('FORBIDDEN');
		const set = await call(admin, 'mockup_style_set', {
			sessionId: sa.sessionId,
			project: w.projectKey,
			style: 'Calm and quiet.',
			screens: ['wide', 'phone'],
			themes: ['light', 'dark'],
			templates: [{ name: 'Form page', prompt: 'A card with a form.' }]
		});
		expect(set.error).toBeUndefined();
		const got = await call(member, 'mockup_style_get', { project: w.projectKey });
		expect(got).toMatchObject({
			untrusted: true,
			screens: ['wide', 'phone'],
			style: { text: 'Calm and quiet.' },
			templates: [{ name: 'Form page' }]
		});
		const del = await call(admin, 'mockup_style_set', {
			sessionId: sa.sessionId,
			project: w.projectKey,
			deleteTemplates: ['Form page']
		});
		expect(del['deleted:Form page']).toMatchObject({ removed: true });
	});

	it('saves a kit, reads it in parts, and marks it out of date', async () => {
		const sa = await call(admin, 'session_start', { tool: 'claude-code' });
		const none = await call(member, 'mockup_kit_get', { project: w.projectKey });
		expect(none.kit).toBeNull();
		const saved = await call(admin, 'mockup_kit_set', {
			sessionId: sa.sessionId,
			project: w.projectKey,
			html: '<html><body>kit</body></html>',
			builtFromCommit: 'abc1234',
			summary: 'Tokens and shell'
		});
		expect(saved).toMatchObject({ number: 1, stale: false });
		expect((saved.warnings as string[]).join(' ')).toContain('embeds no font file');
		const longSummary = await call(admin, 'mockup_kit_set', {
			sessionId: sa.sessionId,
			project: w.projectKey,
			html: '<html></html>',
			summary: 's'.repeat(20_001)
		});
		expect(longSummary.error?.message).toBe(
			'The summary is 20,001 characters; the limit is 20,000. Shorten it.'
		);
		const part = await call(member, 'mockup_kit_get', {
			project: w.projectKey,
			offset: 0,
			limit: 6
		});
		expect(part).toMatchObject({
			untrusted: true,
			builtFromCommit: 'abc1234',
			html: '<html>',
			more: true
		});
		await call(admin, 'mockup_kit_set', {
			sessionId: sa.sessionId,
			project: w.projectKey,
			stale: true
		});
		expect((await call(member, 'mockup_kit_get', { project: w.projectKey, limit: 1 })).stale).toBe(
			true
		);
		const nothing = await call(admin, 'mockup_kit_set', {
			sessionId: sa.sessionId,
			project: w.projectKey
		});
		expect(nothing.error?.code).toBe('INVALID');
	});
});
