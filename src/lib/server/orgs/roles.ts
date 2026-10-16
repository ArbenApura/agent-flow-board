// ROLES AND WHAT EACH MAY DO (SPEC 6). PURE FUNCTIONS, SO THE RULES ARE TESTED WITHOUT A DATABASE.

// -- TYPES -- //

export type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

// -- CONSTANTS -- //

export const ROLE_RANK: Record<Role, number> = {
	owner: 5,
	admin: 4,
	member: 3,
	viewer: 2,
	guest: 1
};
export const ROLE_LABEL: Record<Role, string> = {
	owner: 'Owner',
	admin: 'Admin',
	member: 'Member',
	viewer: 'Viewer',
	guest: 'Guest'
};
const LOWER: Role[] = ['member', 'viewer', 'guest'];

// -- FUNCTIONS -- //

export const atLeast = (role: Role | null | undefined, min: Role) =>
	!!role && ROLE_RANK[role] >= ROLE_RANK[min];

/** Owners and admins manage members. Nobody else does. */
export const canManageMembers = (role: Role | null | undefined) => atLeast(role, 'admin');

/**
 * Whether `actor` may move someone from `from` to `to` (or invite at `to` when `from` is null).
 * An owner may do anything. An admin works only on the roles below admin, so admins cannot make or unmake owners or admins.
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
export function canRemove(actor: Role | null | undefined, target: Role): boolean {
	if (actor === 'owner') return true;
	if (actor === 'admin') return LOWER.includes(target);
	return false;
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
