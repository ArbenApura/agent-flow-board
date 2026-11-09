// PHASE 10: ORGANISATION SETTINGS (NAME, PALETTE, LOGO, LIMITS, AUDIT LOG), PROJECT SETTINGS, THE EXPORT, AND THE
// NOTIFICATIONS A PERSON CAN SWITCH OFF. Each verb changes one group of fields, and only admins and owners change them.

// -- DEP-MODULES -- //
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { adminFromExecutor } from '../../src/lib/server/backup/admin';
import { runBackup } from '../../src/lib/server/backup/run';
import { org, userPref } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import type { Mail, Mailer } from '../../src/lib/server/email/mailer';
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { loadPublishable, renderExport } from '../../src/lib/server/ops/export';
import { createInvite } from '../../src/lib/server/orgs/invites';
import { createItem } from '../../src/lib/server/ops/items';
import { createToken } from '../../src/lib/server/ops/tokens';
import { updateProject } from '../../src/lib/server/ops/projects';
import {
	DEFAULT_SETTINGS,
	clearOrgLogo,
	emailStatus,
	exportAsMarkdown,
	exportProject,
	getOrgSettings,
	orgAuditLog,
	orgBackups,
	sendTestEmail,
	setOrgLogo,
	settingsOf,
	updateOrgSettings
} from '../../src/lib/server/ops/settings';
import { paletteCss, paletteVars, storedPalette, styleFor } from '../../src/lib/theme/css';
import { generatePalette } from '../../src/lib/theme/palette';
import { DEFAULT_ACCENT, PRESETS } from '../../src/lib/theme/presets';
import { makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const mails: Mail[] = [];
const mailer: Mailer = { kind: 'log', send: async (m) => void mails.push(m) };

// -- FUNCTIONS -- //

describe('palette styles', () => {
	it('every preset makes a palette that reads comfortably, and the CSS carries both modes', () => {
		for (const p of [...PRESETS, { name: 'Default', hex: DEFAULT_ACCENT }]) {
			const stored = storedPalette(generatePalette(p.hex));
			const css = paletteCss(stored);
			expect(css, p.name).toContain("html:root,html[data-mode='light']{--accent:");
			expect(css, p.name).toContain("html[data-mode='dark']{--accent:");
			expect(css).toContain('--accent-ink:');
			expect(css).toContain('--accent-soft:');
			expect(css).toContain('--accent-text:');
		}
		expect(Object.keys(paletteVars(generatePalette('#0d9488'), 'dark'))).toEqual([
			'--accent',
			'--accent-ink',
			'--accent-soft',
			'--accent-text'
		]);
	});

	it('only six digit colours can reach a page, and a later palette comes after an earlier one', () => {
		expect(paletteCss(null)).toBe('');
		expect(
			paletteCss({
				seed: '#000000',
				light: { '--accent': 'red;}</style><script>alert(1)</script>' },
				dark: { '--accent-ink': 'url(x)' }
			})
		).toBe('');
		const org = storedPalette(generatePalette('#2563eb'));
		const mine = storedPalette(generatePalette('#e11d48'));
		const css = styleFor(org, mine);
		expect(css.indexOf(org.light['--accent'])).toBeLessThan(css.indexOf(mine.light['--accent']));
		expect(styleFor(null, undefined)).toBe('');
	});
});

describe('settings', () => {
	const make = makePostgres;
	let db: TestDb;
	let w: World;
	const ctx = (who: 'owner' | 'admin' | 'member' | 'viewer' = 'admin') => ({
		...w.ctx(who),
		services: { mailer, backups: true }
	});

	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
	}, 240_000);
	afterAll(() => db?.stop());

	it('everyone reads the org settings, only admins and owners change them, and each section changes only its own fields', async () => {
		const before = await getOrgSettings(ctx('viewer'));
		expect(before).toMatchObject({
			canManage: false,
			accent: null,
			logo: null,
			settings: DEFAULT_SETTINGS
		});
		await expect(updateOrgSettings(ctx('member'), { name: 'Nope' })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(updateOrgSettings(ctx('viewer'), { accent: '#e11d48' })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		// Name alone
		expect((await updateOrgSettings(ctx(), { name: 'Renamed org' })).changed).toBe(true);
		let s = await getOrgSettings(ctx());
		expect(s).toMatchObject({
			name: 'Renamed org',
			accent: null,
			canManage: true,
			settings: DEFAULT_SETTINGS
		});
		// Palette alone: stored generated, never raw CSS, and it checks out
		await updateOrgSettings(ctx(), { accent: '#E11D48' });
		s = await getOrgSettings(ctx());
		expect(s.accent).toBe('#e11d48');
		expect(s.name).toBe('Renamed org');
		expect(s.paletteChecks.length).toBeGreaterThan(10);
		expect(s.paletteChecks.every((c) => c.pass)).toBe(true);
		const [row] = await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(org).where(eq(org.id, w.orgId))
		);
		expect(row.palette?.light['--accent']).toMatch(/^#[0-9a-f]{6}$/);
		// A colour that is not a six digit colour, and a limit out of range, are refused
		await expect(updateOrgSettings(ctx(), { accent: 'red' })).rejects.toThrow();
		await expect(updateOrgSettings(ctx(), { accent: '#12345' })).rejects.toThrow();
		await expect(updateOrgSettings(ctx(), { tokenMaxDays: 400 })).rejects.toThrow();
		await expect(updateOrgSettings(ctx(), { name: 'x' })).rejects.toThrow();
		// Limits alone
		await updateOrgSettings(ctx(), { tokenMaxDays: 14, allowGuestInvites: false });
		s = await getOrgSettings(ctx());
		expect(s.settings).toEqual({
			tokenMaxDays: 14,
			allowGuestInvites: false
		});
		expect(s.accent).toBe('#e11d48');
		// Back to the default palette, and an unchanged save says so
		await updateOrgSettings(ctx(), { accent: null });
		expect((await getOrgSettings(ctx())).accent).toBeNull();
		expect((await updateOrgSettings(ctx(), { tokenMaxDays: 14 })).changed).toBe(false);
		expect(settingsOf(null)).toEqual(DEFAULT_SETTINGS);
		expect(settingsOf({ tokenMaxDays: 7 })).toEqual({
			tokenMaxDays: 7,
			allowGuestInvites: true
		});
	});

	it('the org limits are enforced: token lifetime and guest invitations', async () => {
		// The org now allows 14 days at most
		await expect(
			createToken(ctx('member'), { name: 'too long', days: 30, permissions: ['read'] })
		).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/14 days at most/)
		});
		const ok = await createToken(ctx('member'), {
			name: 'short enough',
			days: 14,
			permissions: ['read']
		});
		expect(new Date(ok.expiresAt).getTime()).toBeLessThan(Date.now() + 15 * 86_400_000);
		// With no days given the default is the smaller of 30 and the limit
		const dflt = await createToken(ctx('member'), { name: 'default life', permissions: ['read'] });
		expect(new Date(dflt.expiresAt).getTime()).toBeLessThan(Date.now() + 15 * 86_400_000);
		// Guests may not be invited while the switch is off, other roles may
		await expect(
			createInvite(db, mailer, 'http://x', w.orgId, w.people.owner, {
				email: 'guest@example.com',
				role: 'guest'
			})
		).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: expect.stringMatching(/does not allow inviting guests/)
		});
		await createInvite(db, mailer, 'http://x', w.orgId, w.people.owner, {
			email: 'member2@example.com',
			role: 'member'
		});
		await updateOrgSettings(ctx(), { allowGuestInvites: true, tokenMaxDays: 90 });
		await createInvite(db, mailer, 'http://x', w.orgId, w.people.owner, {
			email: 'guest@example.com',
			role: 'guest'
		});
		const big = await createToken(ctx('member'), {
			name: 'long life',
			days: 90,
			permissions: ['read']
		});
		expect(big.id).toBeTruthy();
	});

	it('the logo is a small real picture, and a renamed file or a big one is refused', async () => {
		await expect(setOrgLogo(ctx('member'), PNG, 'image/png')).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(setOrgLogo(ctx(), PNG, 'image/gif')).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			setOrgLogo(ctx(), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'image/png')
		).rejects.toThrow(/not the kind of picture/);
		await expect(setOrgLogo(ctx(), new Uint8Array(200 * 1024 + 1), 'image/png')).rejects.toThrow(
			/smaller than 200 KB/
		);
		await expect(setOrgLogo(ctx(), new Uint8Array(), 'image/png')).rejects.toThrow();
		const saved = await setOrgLogo(ctx(), PNG, 'image/png');
		expect(saved.size).toBe(PNG.length);
		const s = await getOrgSettings(ctx('viewer'));
		expect(s.logo).toMatch(/^data:image\/png;base64,/);
		await clearOrgLogo(ctx());
		expect((await getOrgSettings(ctx())).logo).toBeNull();
		await expect(clearOrgLogo(ctx('member'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('the audit log is for admins and owners, covers the whole org, filters by project and pages by keyset', async () => {
		await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Audited item one',
			...PLAN
		});
		await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Audited item two',
			...PLAN
		});
		await expect(orgAuditLog(ctx('member'), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(orgAuditLog(ctx('viewer'), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const all = await orgAuditLog(ctx(), { limit: 200 });
		expect(all.events.length).toBeGreaterThan(3);
		expect(all.events[0].id).toBeGreaterThan(all.events.at(-1)!.id);
		expect(all.events.every((e) => e.project === w.projectKey)).toBe(true);
		// Org level changes are in the log under the org's first project
		expect(all.events.some((e) => e.verb === 'org.settings')).toBe(true);
		// Keyset paging: two pages never repeat an event
		const first = await orgAuditLog(ctx(), { limit: 2 });
		expect(first.events).toHaveLength(2);
		expect(first.next).toBe(first.events[1].id);
		const second = await orgAuditLog(ctx(), { limit: 2, before: first.next! });
		expect(second.events.every((e) => e.id < first.next!)).toBe(true);
		// A project filter, and an unknown project is an empty log, not an error and not another org's rows
		expect(
			(await orgAuditLog(ctx(), { project: w.projectKey.toLowerCase(), limit: 200 })).events.length
		).toBe(all.events.length);
		expect(await orgAuditLog(ctx(), { project: 'NOPE' })).toEqual({ events: [], next: null });
		const other = {
			...ctx(),
			orgId: w.other.orgId,
			actor: { userId: w.other.userId, kind: 'person' as const }
		};
		expect((await orgAuditLog(other, { limit: 200 })).events).toEqual([]);
	});

	it('project settings: the reference pages and the other fields are saved by the section that owns them', async () => {
		await expect(
			updateProject(ctx('member'), { project: w.projectKey, staleDays: 5 })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const r = await updateProject(ctx(), {
			project: w.projectKey,
			referencePages: ['/settings', '/acme/CKT'],
			themes: [
				{ key: 'light', label: 'Light' },
				{ key: 'dark', label: 'Dark' }
			],
			staleDays: 7,
			agentsMayComplete: false
		});
		expect(r.changed).toBe(true);
		expect(r.project).toMatchObject({
			referencePages: ['/settings', '/acme/CKT'],
			staleDays: 7,
			agentsMayComplete: false
		});
		await expect(
			updateProject(ctx(), { project: w.projectKey, referencePages: ['no-slash'] })
		).rejects.toThrow();
		await expect(
			updateProject(ctx(), { project: w.projectKey, referencePages: ['/has space'] })
		).rejects.toThrow();
		await expect(updateProject(ctx(), { project: w.projectKey, staleDays: 0 })).rejects.toThrow();
		// Only the sent field changes
		const again = await updateProject(ctx(), { project: w.projectKey, name: 'Renamed project' });
		expect(again.project).toMatchObject({
			name: 'Renamed project',
			staleDays: 7,
			referencePages: ['/settings', '/acme/CKT']
		});
	});

	it('the export is deterministic: the same data renders the same files and hashes', async () => {
		const a = await withTenant(db, { orgId: w.orgId }, async (tx) =>
			renderExport(await loadPublishable(tx, w.projectId))
		);
		const b = await withTenant(db, { orgId: w.orgId }, async (tx) =>
			renderExport(await loadPublishable(tx, w.projectId))
		);
		expect(a).toEqual(b);
	});

	it('the export holds the public items only, as JSON and as one Markdown file', async () => {
		await createItem(w.ctx('owner'), {
			project: w.projectKey,
			title: 'Hidden from the export',
			visibility: 'private'
		});
		const out = await exportProject(ctx('viewer'), w.projectKey);
		expect(out.itemCount).toBe(2);
		const snapshot = JSON.parse(out.files['snapshot.json']);
		expect(snapshot.items.map((i: { title: string }) => i.title).sort()).toEqual([
			'Audited item one',
			'Audited item two'
		]);
		expect(JSON.stringify(out.files)).not.toContain('Hidden from the export');
		const md = exportAsMarkdown(out.files);
		expect(md).toContain('<!-- registry.md -->');
		expect(md).toContain('Audited item one');
		expect(md).not.toContain('Hidden from the export');
		expect(md.indexOf('registry.md')).toBeLessThan(md.indexOf('PLAN.md'));
		expect(md).not.toContain('"format": "agent-flow-board-snapshot"');
		await expect(
			exportProject(
				{
					...ctx(),
					orgId: w.other.orgId,
					actor: { userId: w.other.userId, kind: 'person' as const }
				},
				w.projectKey
			)
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('email status, a test email that says what went wrong, and backups shown only to admins', async () => {
		expect(emailStatus(ctx())).toEqual({ configured: true, provider: 'log' });
		expect(emailStatus({ ...ctx(), services: {} })).toEqual({ configured: false, provider: null });
		mails.length = 0;
		expect(await sendTestEmail(ctx(), 'me@example.com')).toEqual({ sent: true, via: 'log' });
		expect(mails[0]).toMatchObject({
			to: 'me@example.com',
			subject: expect.stringMatching(/test email/i)
		});
		await expect(sendTestEmail(ctx('member'), 'me@example.com')).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(sendTestEmail({ ...ctx(), services: {} }, 'me@example.com')).rejects.toThrow(
			/no way to send email/
		);
		const failing: Mailer = {
			kind: 'smtp',
			send: async () => {
				throw new Error('The mail server refused this address.');
			}
		};
		await expect(
			sendTestEmail({ ...ctx(), services: { mailer: failing } }, 'me@example.com')
		).rejects.toThrow(/refused this address/);
		const off = await orgBackups({ ...ctx(), services: { mailer } });
		expect(off.enabled).toBe(false);
		const on = await orgBackups(ctx());
		expect(on.enabled).toBe(true);
		expect(on.health).toMatchObject({ ok: false, late: true });
		expect(on.runs).toEqual([]);
		await expect(orgBackups(ctx('member'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('mails about backups go to the people who did not switch them off', async () => {
		await db.admin.exec(
			`update "user" set email = 'owner-pref@example.com' where id = '${w.people.owner}'`
		);
		await db.admin.exec(
			`update "user" set email = 'admin-pref@example.com' where id = '${w.people.admin}'`
		);
		// The owner switches the alert off, the admin leaves it on
		await withTenant(db, { userId: w.people.owner }, (tx) =>
			tx.insert(userPref).values({
				userId: w.people.owner,
				notifications: { backupAlerts: false }
			})
		);
		mails.length = 0;
		// Backup alerts: a live attachment whose file is gone fails the backup. The owner opted out, so nobody is mailed
		mails.length = 0;
		const files = memoryStorage('storage-secret-for-tests-0123456789');
		const backups = memoryStorage('backups-secret-for-tests-0123456789');
		const item = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Holds a lost file'
		});
		await db.admin.exec(
			`insert into attachment (org_id, project_id, item_id, visibility, caption, kind, filename, mime, size, checksum, storage_key) values ('${w.orgId}', '${w.projectId}', '${item.id}', 'private', 'Lost', 'file', 'lost.png', 'image/png', 3, 'abc', 'lost/file.png')`
		);
		const deps = {
			handle: db,
			admin: adminFromExecutor(db.admin),
			storage: files,
			backups,
			key: 'a-backup-key-of-more-than-32-characters!!',
			mailer
		};
		const failed = await runBackup(deps, { now: new Date() });
		expect(failed.find((r) => r.orgId === w.orgId)).toMatchObject({ state: 'failed' });
		expect(mails).toEqual([]);
		// The owner switches the alert back on and the next failure reaches them
		await withTenant(db, { userId: w.people.owner }, (tx) =>
			tx
				.update(userPref)
				.set({ notifications: { backupAlerts: true } })
				.where(eq(userPref.userId, w.people.owner))
		);
		await runBackup(deps, { now: new Date(Date.now() + 1000) });
		expect(mails.map((m) => m.to)).toEqual(['owner-pref@example.com']);
		expect(mails[0].subject).toMatch(/need attention/);
	});
});
