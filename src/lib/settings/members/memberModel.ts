// WHAT THE MEMBERS LIST SHOWS ABOUT A PERSON: THE SHAPES THE PAGE LOADS, THE ICON OF A ROLE AND THE ACCESS LINE OF A ROW

// IMPORTED DEP-TYPES
import type { Component } from 'svelte';
// IMPORTED TYPES
import type { Role } from '#lib/shared/roles.js';
// IMPORTED MODULES
import { effectiveProjectRole } from '#lib/shared/roles.js';
// IMPORTED DEP-COMPONENTS
import Crown from '@lucide/svelte/icons/crown';
import Eye from '@lucide/svelte/icons/eye';
import Link from '@lucide/svelte/icons/link';
import Shield from '@lucide/svelte/icons/shield';
import User from '@lucide/svelte/icons/user';

// -- TYPES -- //

export type MemberView = {
	userId: string;
	name: string;
	email: string;
	role: Role;
	imageV?: number | null;
	joinedAt?: string | Date | null;
};
export type InviteView = {
	id: string;
	email: string;
	role: Role;
	createdAt: string | Date;
	invitedBy: string | null;
};
export type ProjectView = { id: string; key: string; name: string; logoV?: number | null };
export type ProjectRoleView = { projectId: string; userId: string; role: Role };
/** What a row of the list can show in the filter chips: everyone, or one role. */
export type RoleFilter = Role | 'all';

// -- CONSTANTS -- //

/** One small picture for each role, the same wherever a role is drawn. */
export const ROLE_ICON: Record<Role, Component<{ size?: number; class?: string }>> = {
	owner: Crown,
	admin: Shield,
	member: User,
	viewer: Eye,
	guest: Link
};

/** The four columns of the people tables, from md up: person, role, access, more. The header line and every row use it, so they line up. */
export const TABLE_GRID =
	'md:grid-cols-[minmax(0,1fr)_9rem_11rem_2.5rem] md:items-center md:gap-x-4';
/** One row of a people table. A flex wrap on a phone, the grid from md up. */
export const TABLE_ROW = `flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-3 last:border-b-0 md:grid md:py-2.5 ${TABLE_GRID}`;

// -- FUNCTIONS -- //

/** The projects a person can open, with the role they work in there. A guest sees only the ones they were given. */
export function projectsOf(
	person: Pick<MemberView, 'userId' | 'role'>,
	projects: ProjectView[],
	overrides: ProjectRoleView[]
): { project: ProjectView; override: Role | null; effective: Role | null }[] {
	return projects.map((project) => {
		const override =
			overrides.find((o) => o.projectId === project.id && o.userId === person.userId)?.role ?? null;
		return { project, override, effective: effectiveProjectRole(person.role, override) };
	});
}

/** The access line of a row: All projects, 4 projects, 1 shared project or No projects. */
export function accessSummary(
	person: Pick<MemberView, 'userId' | 'role'>,
	projects: ProjectView[],
	overrides: ProjectRoleView[]
): string {
	if (person.role === 'owner' || person.role === 'admin') return 'All projects';
	const open = projectsOf(person, projects, overrides).filter((p) => p.effective !== null).length;
	if (person.role === 'guest') {
		if (open === 0) return 'No projects yet';
		return open === 1 ? '1 shared project' : `${open} shared projects`;
	}
	if (open === 0) return 'No projects yet';
	return open === projects.length && open > 1
		? 'All projects'
		: open === 1
			? '1 project'
			: `${open} projects`;
}

/** Splits several addresses typed or pasted into one string. Commas, semicolons and any whitespace separate them. */
export function splitEmails(raw: string): string[] {
	return raw
		.split(/[\s,;]+/)
		.map((e) => e.trim())
		.filter(Boolean);
}

/** The same shape the server accepts for an invitation address. */
export const looksLikeEmail = (value: string) => /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(value);
