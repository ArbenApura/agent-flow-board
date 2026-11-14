// 4.7: ORGS, MEMBERS, ROLES, PER PROJECT OVERRIDES, EMAIL BOUND INVITES, THE LAST OWNER RULE AND THE OWNER RESET

// IMPORTED DEP-MODULES
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { createAuth, type Auth } from '../../src/lib/server/auth/auth';
import { apiToken, authAccount, member, project } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import { createMailer, outbox } from '../../src/lib/server/email/mailer';
import {
	acceptInvite,
	createInvite,
	listInvites,
	parseToken,
	revokeInvite
} from '../../src/lib/server/orgs/invites';
import {
	OrgError,
	changeRole,
	createOrg,
	listMembers,
	listMyOrgs,
	orgForSlug,
	projectRole,
	removeMember,
	roleOf,
	setProjectRole
} from '../../src/lib/server/orgs/orgs';
import { resetOwnerPassword } from '../../src/lib/server/orgs/ownerReset';
import { canAssignRole, canRemove, effectiveProjectRole } from '../../src/lib/server/orgs/roles';
import { makePostgres, type TestDb } from '../support/db';

// -- FUNCTIONS -- //

describe('role rules', () => {
	it('an owner may do anything, an admin works only below admin, others nothing', () => {
		expect(canAssignRole('owner', 'member', 'owner')).toBe(true);
		expect(canAssignRole('admin', 'member', 'viewer')).toBe(true);
		expect(canAssignRole('admin', 'member', 'admin')).toBe(false);
		expect(canAssignRole('admin', 'owner', 'member')).toBe(false);
		expect(canAssignRole('admin', null, 'guest')).toBe(true);
		expect(canAssignRole('member', null, 'guest')).toBe(false);
		expect(canRemove('admin', 'admin')).toBe(false);
		expect(canRemove('admin', 'viewer')).toBe(true);
	});
	it('a project override replaces an org role, owners and admins keep admin, guests need an override', () => {
		expect(effectiveProjectRole('member', 'viewer')).toBe('viewer');
		expect(effectiveProjectRole('viewer', 'admin')).toBe('admin');
		expect(effectiveProjectRole('admin', 'viewer')).toBe('admin');
		expect(effectiveProjectRole('owner', null)).toBe('owner');
		expect(effectiveProjectRole('guest', null)).toBeNull();
		expect(effectiveProjectRole('guest', 'member')).toBe('member');
		expect(effectiveProjectRole(null, 'admin')).toBeNull();
	});
});

describe('orgs and invites', () => {
	const make = makePostgres;
	let db: TestDb;
	const mailer = createMailer({
		provider: 'log',
		from: 'board@example.com',
		failPattern: '^refuse@'
	});
	const BASE = 'http://localhost:5180';
	let n = 0;
	const person = async (label: string, verified = true) => {
		const id = `u-${label}-${++n}`;
		await db.admin.exec(
			`insert into "user" (id, name, email, email_verified) values ('${id}', '${label}', '${label}${n}@example.com', ${verified})`
		);
		return { id, email: `${label}${n}@example.com`, name: label, emailVerified: verified };
	};
	const slug = (s: string) => `${s}-${++n}`;

	beforeAll(async () => {
		db = await make();
	}, 180_000);
	afterAll(async () => {
		await db?.stop();
	});

	it('creates an org with its creator as the Owner, and refuses a taken or invalid address', async () => {
		const ana = await person('ana');
		const o = await createOrg(db, ana.id, { name: 'Acme', slug: slug('acme') });
		expect(await roleOf(db, o.id, ana.id)).toBe('owner');
		await expect(createOrg(db, ana.id, { name: 'Again', slug: o.slug })).rejects.toMatchObject({
			code: 'SLUG_TAKEN'
		});
		await expect(createOrg(db, ana.id, { name: 'Bad', slug: 'Not A Slug' })).rejects.toMatchObject({
			code: 'INVALID'
		});
	});

	it('lists only my orgs, and resolves a slug only for a member', async () => {
		const ana = await person('ana');
		const ben = await person('ben');
		const a = await createOrg(db, ana.id, { name: 'Ana org', slug: slug('ana') });
		const b = await createOrg(db, ben.id, { name: 'Ben org', slug: slug('ben') });
		expect((await listMyOrgs(db, ana.id)).map((o) => o.slug)).toEqual([a.slug]);
		expect((await listMyOrgs(db, ben.id)).map((o) => o.slug)).toEqual([b.slug]);
		expect(await orgForSlug(db, a.slug, ana.id)).toMatchObject({ id: a.id, role: 'owner' });
		expect(await orgForSlug(db, a.slug, ben.id)).toBeNull();
		expect(await orgForSlug(db, 'no-such-org', ana.id)).toBeNull();
	});

	it('an invite works once, only for its own verified email, and older links stop working', async () => {
		const owner = await person('owner');
		const guest = await person('invitee');
		const stranger = await person('stranger');
		const o = await createOrg(db, owner.id, { name: 'Invites', slug: slug('inv') });
		outbox.length = 0;
		const first = await createInvite(db, mailer, BASE, o.id, owner.id, {
			email: guest.email.toUpperCase(),
			role: 'member'
		});
		expect(first.emailFailed).toBe(false);
		expect(outbox[0].to).toBe(guest.email);
		const token = first.url.split('/invite/')[1];
		expect(parseToken(token)?.orgId).toBe(o.id);
		expect(await acceptInvite(db, token, stranger)).toMatchObject({
			ok: false,
			code: 'WRONG_EMAIL'
		});
		expect(await acceptInvite(db, token, { ...guest, emailVerified: false })).toMatchObject({
			ok: false,
			code: 'UNVERIFIED'
		});
		expect(await acceptInvite(db, 'garbage', guest)).toMatchObject({ ok: false, code: 'INVALID' });
		expect(await acceptInvite(db, token, guest)).toMatchObject({
			ok: true,
			orgSlug: o.slug,
			role: 'member'
		});
		expect(await roleOf(db, o.id, guest.id)).toBe('member');
		expect(await acceptInvite(db, token, guest)).toMatchObject({ ok: false, code: 'USED' });
		// A new invite for the same address replaces the open one
		const stranger2 = await person('second');
		const a = await createInvite(db, mailer, BASE, o.id, owner.id, {
			email: stranger2.email,
			role: 'viewer'
		});
		const b = await createInvite(db, mailer, BASE, o.id, owner.id, {
			email: stranger2.email,
			role: 'guest'
		});
		expect(await acceptInvite(db, a.url.split('/invite/')[1], stranger2)).toMatchObject({
			ok: false,
			code: 'USED'
		});
		expect(await acceptInvite(db, b.url.split('/invite/')[1], stranger2)).toMatchObject({
			ok: true,
			role: 'guest'
		});
	});

	it('an expired invite is refused, and a token for another org is not found in this one', async () => {
		const owner = await person('owner');
		const guest = await person('late');
		const o = await createOrg(db, owner.id, { name: 'Expiry', slug: slug('exp') });
		const inv = await createInvite(db, mailer, BASE, o.id, owner.id, {
			email: guest.email,
			role: 'member'
		});
		await db.admin.exec(
			`update invite set expires_at = now() - interval '1 minute' where id = '${inv.inviteId}'`
		);
		expect(await acceptInvite(db, inv.url.split('/invite/')[1], guest)).toMatchObject({
			ok: false,
			code: 'EXPIRED'
		});
		const other = await createOrg(db, owner.id, { name: 'Other', slug: slug('oth') });
		const forged = `${other.id}.${inv.url.split('.').pop()}`;
		expect(await acceptInvite(db, forged, guest)).toMatchObject({ ok: false, code: 'INVALID' });
	});

	it('only owners and admins invite, and an admin cannot invite an owner', async () => {
		const owner = await person('owner');
		const admin = await person('admin');
		const plain = await person('plain');
		const o = await createOrg(db, owner.id, { name: 'Roles', slug: slug('roles') });
		await db.admin.exec(
			`insert into member (org_id, user_id, role) values ('${o.id}', '${admin.id}', 'admin'), ('${o.id}', '${plain.id}', 'member')`
		);
		await expect(
			createInvite(db, mailer, BASE, o.id, admin.id, { email: 'x@example.com', role: 'owner' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			createInvite(db, mailer, BASE, o.id, plain.id, { email: 'x@example.com', role: 'guest' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			createInvite(db, mailer, BASE, o.id, admin.id, {
				email: 'viewer@example.com',
				role: 'viewer'
			})
		).resolves.toMatchObject({ emailFailed: false });
		const open = await listInvites(db, o.id, owner.id);
		expect(open).toHaveLength(1);
		await revokeInvite(db, o.id, owner.id, open[0].id);
		expect(await listInvites(db, o.id, owner.id)).toHaveLength(0);
	});

	it('a failed invite mail is reported with the link so the inviter can pass it on', async () => {
		const owner = await person('owner');
		const o = await createOrg(db, owner.id, { name: 'Mail', slug: slug('mail') });
		const r = await createInvite(db, mailer, BASE, o.id, owner.id, {
			email: 'refuse@example.com',
			role: 'member'
		});
		expect(r).toMatchObject({ emailFailed: true });
		expect(r.url).toContain('/invite/');
	});

	it('the last Owner cannot be demoted or removed, and admins cannot touch owners', async () => {
		const owner = await person('owner');
		const admin = await person('admin');
		const o = await createOrg(db, owner.id, { name: 'Last owner', slug: slug('last') });
		await db.admin.exec(
			`insert into member (org_id, user_id, role) values ('${o.id}', '${admin.id}', 'admin')`
		);
		await expect(changeRole(db, o.id, owner.id, owner.id, 'admin')).rejects.toMatchObject({
			code: 'LAST_OWNER'
		});
		await expect(removeMember(db, o.id, owner.id, owner.id)).rejects.toMatchObject({
			code: 'LAST_OWNER'
		});
		await expect(changeRole(db, o.id, admin.id, owner.id, 'member')).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(removeMember(db, o.id, admin.id, owner.id)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await changeRole(db, o.id, owner.id, admin.id, 'owner');
		await expect(changeRole(db, o.id, owner.id, owner.id, 'member')).resolves.toMatchObject({
			role: 'member'
		});
		expect((await listMembers(db, o.id)).map((m) => m.role).sort()).toEqual(['member', 'owner']);
	});

	it('two owners leaving at the same moment cannot leave the org with none', async () => {
		const a = await person('ownerA');
		const b = await person('ownerB');
		const o = await createOrg(db, a.id, { name: 'Race', slug: slug('race') });
		await db.admin.exec(
			`insert into member (org_id, user_id, role) values ('${o.id}', '${b.id}', 'owner')`
		);
		const results = await Promise.allSettled([
			removeMember(db, o.id, a.id, a.id),
			removeMember(db, o.id, b.id, b.id)
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(
			results.filter((r) => r.status === 'rejected' && (r.reason as OrgError).code === 'LAST_OWNER')
		).toHaveLength(1);
		expect((await listMembers(db, o.id)).filter((m) => m.role === 'owner')).toHaveLength(1);
	});

	it('removing a member revokes their tokens in that org', async () => {
		const owner = await person('owner');
		const gone = await person('gone');
		const o = await createOrg(db, owner.id, { name: 'Tokens', slug: slug('tok') });
		await db.admin.exec(
			`insert into member (org_id, user_id, role) values ('${o.id}', '${gone.id}', 'member')`
		);
		await db.admin.exec(
			`insert into api_token (org_id, user_id, name, prefix, hash, expires_at) values ('${o.id}', '${gone.id}', 'ci', 'afb_x', 'hash-${gone.id}', now() + interval '30 days')`
		);
		await removeMember(db, o.id, owner.id, gone.id);
		const [t] = await withTenant(db, { orgId: o.id }, (tx) =>
			tx.select().from(apiToken).where(eq(apiToken.userId, gone.id))
		);
		expect(t.revokedAt).not.toBeNull();
		expect(await roleOf(db, o.id, gone.id)).toBeNull();
		const rows = await withTenant(db, { orgId: o.id }, (tx) =>
			tx.select().from(member).where(eq(member.userId, gone.id))
		);
		expect(rows).toHaveLength(0);
	});

	it('per project overrides change what a person can do in that project only', async () => {
		const owner = await person('owner');
		const viewer = await person('viewer');
		const o = await createOrg(db, owner.id, { name: 'Projects', slug: slug('proj') });
		const pid = '00000000-0000-4000-8000-0000000000aa';
		const pid2 = '00000000-0000-4000-8000-0000000000ab';
		await db.admin.exec(
			`insert into project (id, org_id, key, name) values ('${pid}', '${o.id}', 'ONE', 'One'), ('${pid2}', '${o.id}', 'TWO', 'Two')`
		);
		await db.admin.exec(
			`insert into member (org_id, user_id, role) values ('${o.id}', '${viewer.id}', 'viewer')`
		);
		expect(await projectRole(db, o.id, pid, viewer.id)).toBe('viewer');
		await setProjectRole(db, o.id, owner.id, pid, viewer.id, 'member');
		expect(await projectRole(db, o.id, pid, viewer.id)).toBe('member');
		expect(await projectRole(db, o.id, pid2, viewer.id)).toBe('viewer');
		expect(await projectRole(db, o.id, pid, owner.id)).toBe('owner');
		await setProjectRole(db, o.id, owner.id, pid, viewer.id, null);
		expect(await projectRole(db, o.id, pid, viewer.id)).toBe('viewer');
		await expect(
			setProjectRole(db, o.id, viewer.id, pid, viewer.id, 'admin')
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		const rows = await withTenant(db, { orgId: o.id }, (tx) => tx.select().from(project));
		expect(rows).toHaveLength(2);
	});

	it('the owner reset sets a new password for an Owner only', async () => {
		const owner = await person('resetowner');
		const plain = await person('plain');
		const o = await createOrg(db, owner.id, { name: 'Reset', slug: slug('reset') });
		await db.admin.exec(
			`insert into member (org_id, user_id, role) values ('${o.id}', '${plain.id}', 'member')`
		);
		const auth: Auth = createAuth({
			handle: db,
			mailer,
			config: {
				secret: 'z'.repeat(40),
				baseUrl: BASE,
				checkBreachedPasswords: false,
				disableRateLimit: true
			}
		});
		const done = await resetOwnerPassword(db, auth, { orgSlug: o.slug, email: owner.email });
		expect(done.password.length).toBeGreaterThanOrEqual(20);
		const signed = await auth.api.signInEmail({
			body: { email: owner.email, password: done.password }
		});
		expect(signed.user.id).toBe(owner.id);
		await expect(
			resetOwnerPassword(db, auth, { orgSlug: o.slug, email: plain.email })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			resetOwnerPassword(db, auth, { orgSlug: o.slug, email: 'nobody@example.com' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(
			resetOwnerPassword(db, auth, { orgSlug: o.slug, email: owner.email, newPassword: 'short' })
		).rejects.toMatchObject({ code: 'INVALID' });
		expect(
			(await db.db.select().from(authAccount).where(eq(authAccount.userId, owner.id))).length
		).toBe(1);
	});
});
