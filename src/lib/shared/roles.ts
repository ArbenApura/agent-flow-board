// ROLE NAMES SHARED BY THE SERVER AND THE PAGES (THE RULES THEMSELVES LIVE IN src/lib/server/orgs/roles.ts)

// -- TYPES -- //

export type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'guest';

// -- CONSTANTS -- //

export const ROLE_LABEL: Record<Role, string> = {
	owner: 'Owner',
	admin: 'Admin',
	member: 'Member',
	viewer: 'Viewer',
	guest: 'Guest'
};
