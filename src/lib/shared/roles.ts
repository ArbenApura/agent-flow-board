// ROLE NAMES SHARED BY THE SERVER AND THE PAGES (THE RULES THEMSELVES LIVE IN src/lib/server/orgs/roles.ts)

// -- TYPES -- //

export type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

/** Why a row of the members list cannot be changed by the person looking, in a short form for a column and a full one for a tooltip. */
export type MemberLock = { short: string; reason: string };

// -- CONSTANTS -- //

export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer', 'guest'];

export const ROLE_LABEL: Record<Role, string> = {
	owner: 'Owner',
	admin: 'Admin',
	member: 'Member',
	viewer: 'Viewer',
	guest: 'Guest'
};

/** What each role means in plain words, for the role menu, the invite dialog and the role guide. */
export const ROLE_INFO: Record<Role, { description: string; scope: string[] }> = {
	owner: {
		description:
			'Everything an admin can do, and may change other owners and delete the organisation.',
		scope: ['All projects', 'Manages people']
	},
	admin: {
		description:
			'Manages members below admin and the organisation settings. Admin in every project.',
		scope: ['All projects', 'Manages people']
	},
	member: {
		description: 'Works in the projects they belong to: plans, items, tasks and notes.',
		scope: ['Their projects']
	},
	viewer: {
		description: 'Reads what they can see and changes nothing.',
		scope: ['Their projects', 'Read only']
	},
	guest: {
		description: 'Sees only the projects you share with them, one by one.',
		scope: ['Shared projects only']
	}
};

/** The roles an admin may give or take away. */
const LOWER: readonly Role[] = ['member', 'viewer', 'guest'];

// -- FUNCTIONS -- //

/** Owners and admins manage members. Nobody else does. Mirrors canManageMembers on the server. */
export const canManageMembers = (role: Role | null | undefined) =>
	role === 'owner' || role === 'admin';

/**
 * Whether `actor` may move someone from `from` to `to` (or invite at `to` when `from` is null). The same rule as the
 * server, so the page offers only what the server would accept. The server still checks it live on every call.
 */
export function canAssignRole(
	actor: Role | null | undefined,
	from: Role | null,
	to: Role
): boolean {
	if (actor === 'owner') return true;
	if (actor === 'admin') return (from === null || LOWER.includes(from)) && LOWER.includes(to);
	return false;
}

/** Whether `actor` may remove a member holding `target`. */
export function canRemoveRole(actor: Role | null | undefined, target: Role): boolean {
	if (actor === 'owner') return true;
	if (actor === 'admin') return LOWER.includes(target);
	return false;
}

/** Why `to` is not offered to `actor`, in one plain sentence. An empty string when it is offered. */
export function whyNotAssignable(actor: Role | null | undefined, to: Role): string {
	if (canAssignRole(actor, null, to)) return '';
	if (to === 'owner') return 'Only an owner can make an owner.';
	if (to === 'admin') return 'Only an owner can make an admin.';
	return 'Your role does not allow that.';
}

/**
 * Why `person` cannot be changed by `actor`, or null when they can (or when the actor changes nobody at all: the list is
 * then read only as a whole and the page says so once, not on every row). `ownerCount` is how many owners the
 * organisation has: with more than one, an owner may step down, as the server allows.
 */
export function memberLock(
	actor: Role | null | undefined,
	viewerId: string,
	person: { userId: string; role: Role },
	ownerCount = 1
): MemberLock | null {
	if (!canManageMembers(actor)) return null;
	if (person.userId === viewerId) {
		if (actor === 'owner' && ownerCount > 1) return null;
		return actor === 'owner'
			? {
					short: 'Only owner',
					reason: 'You are the only owner. Make someone else an owner first.'
				}
			: { short: 'This is you', reason: 'This is you. Ask an owner to change your role.' };
	}
	if (!canRemoveRole(actor, person.role)) {
		return {
			short: 'Owner only',
			reason: `Only an owner can change ${person.role === 'owner' ? 'an owner' : 'an admin'}.`
		};
	}
	return null;
}

/**
 * The role someone has inside one project. A per project override replaces the org role, except that an owner or admin
 * keeps at least admin everywhere, and a guest sees only projects they were given an override for.
 */
export function effectiveProjectRole(orgRole: Role | null, override: Role | null): Role | null {
	if (!orgRole) return null;
	if (orgRole === 'owner' || orgRole === 'admin') return orgRole;
	if (override) return override;
	return orgRole === 'guest' ? null : orgRole;
}
