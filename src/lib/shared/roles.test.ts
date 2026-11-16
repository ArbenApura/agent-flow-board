// THE ROLE RULES THE MEMBERS PAGE USES MUST NEVER DISAGREE WITH THE ONES THE SERVER ENFORCES

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	canAssignRole as serverCanAssign,
	canRemove as serverCanRemove,
	effectiveProjectRole as serverEffective
} from '../server/orgs/roles';
import {
	ROLES,
	canAssignRole,
	canManageMembers,
	canRemoveRole,
	effectiveProjectRole,
	memberLock,
	whyNotAssignable,
	type Role
} from './roles';

// -- CONSTANTS -- //

const ACTORS: (Role | null)[] = [...ROLES, null];
const FROM: (Role | null)[] = [...ROLES, null];

// -- TESTS -- //

describe('role rules shared with the page', () => {
	it('canAssignRole answers like the server for every actor, current role and new role', () => {
		for (const actor of ACTORS)
			for (const from of FROM)
				for (const to of ROLES)
					expect(canAssignRole(actor, from, to), `${actor} ${from} -> ${to}`).toBe(
						serverCanAssign(actor, from, to)
					);
	});

	it('canRemoveRole answers like the server', () => {
		for (const actor of ACTORS)
			for (const target of ROLES)
				expect(canRemoveRole(actor, target), `${actor} removes ${target}`).toBe(
					serverCanRemove(actor, target)
				);
	});

	it('effectiveProjectRole answers like the server', () => {
		for (const org of FROM)
			for (const override of FROM)
				expect(effectiveProjectRole(org, override), `${org} ${override}`).toBe(
					serverEffective(org, override)
				);
	});

	it('only owners and admins manage members', () => {
		expect(ROLES.filter((r) => canManageMembers(r))).toEqual(['owner', 'admin']);
		expect(canManageMembers(null)).toBe(false);
	});
});

describe('which roles are offered, and why not', () => {
	it('an admin is offered member, viewer and guest and told why the others are not', () => {
		expect(ROLES.filter((r) => canAssignRole('admin', null, r))).toEqual([
			'member',
			'viewer',
			'guest'
		]);
		expect(whyNotAssignable('admin', 'owner')).toBe('Only an owner can make an owner.');
		expect(whyNotAssignable('admin', 'admin')).toBe('Only an owner can make an admin.');
		expect(whyNotAssignable('admin', 'member')).toBe('');
	});

	it('an owner is offered every role', () => {
		expect(
			ROLES.every((r) => canAssignRole('owner', null, r) && whyNotAssignable('owner', r) === '')
		).toBe(true);
	});
});

describe('which rows of the list are locked', () => {
	const people = ROLES.map((role) => ({ userId: `u-${role}`, role }));
	const lockOf = (actor: Role, viewer: Role, target: Role) =>
		memberLock(
			actor,
			`u-${viewer}`,
			people.find((p) => p.role === target)!
		);

	it('an owner can change everyone except themselves', () => {
		expect(lockOf('owner', 'owner', 'admin')).toBeNull();
		expect(lockOf('owner', 'owner', 'guest')).toBeNull();
		expect(lockOf('owner', 'owner', 'owner')?.short).toBe('Only owner');
	});

	it('an owner who is not the only owner may step down, as the server allows', () => {
		const me = { userId: 'me', role: 'owner' as Role };
		expect(memberLock('owner', 'me', me, 2)).toBeNull();
		expect(memberLock('owner', 'me', me, 1)?.short).toBe('Only owner');
	});

	it('an admin cannot change an owner, another admin or themselves', () => {
		expect(lockOf('admin', 'admin', 'owner')?.reason).toBe('Only an owner can change an owner.');
		expect(lockOf('admin', 'admin', 'admin')?.short).toBe('This is you');
		expect(lockOf('admin', 'admin', 'member')).toBeNull();
	});

	it('someone who manages nobody gets no per row lock, the page says so once', () => {
		expect(lockOf('member', 'member', 'viewer')).toBeNull();
		expect(lockOf('viewer', 'viewer', 'owner')).toBeNull();
	});

	it('a row the page leaves unlocked is one the server would let the person change or remove', () => {
		for (const actor of ['owner', 'admin'] as Role[])
			for (const target of ROLES) {
				const other = { userId: 'someone-else', role: target };
				if (memberLock(actor, 'me', other) === null)
					expect(serverCanRemove(actor, target)).toBe(true);
			}
	});
});
