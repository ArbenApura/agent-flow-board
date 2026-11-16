// WHAT THE MEMBERS LIST SAYS ABOUT A PERSON'S ACCESS, AND HOW TYPED ADDRESSES ARE SPLIT

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	accessSummary,
	looksLikeEmail,
	projectsOf,
	splitEmails,
	type ProjectRoleView,
	type ProjectView
} from './memberModel';

// -- CONSTANTS -- //

const projects: ProjectView[] = [
	{ id: 'p1', key: 'AFB', name: 'Agent Flow Board' },
	{ id: 'p2', key: 'HP', name: 'HAPR Board' },
	{ id: 'p3', key: 'ML', name: 'Mobile launch' }
];

// -- TESTS -- //

describe('accessSummary', () => {
	it('says All projects for owners and admins whatever overrides exist', () => {
		expect(accessSummary({ userId: 'u', role: 'owner' }, projects, [])).toBe('All projects');
		expect(accessSummary({ userId: 'u', role: 'admin' }, projects, [])).toBe('All projects');
	});

	it('counts the projects a member can open', () => {
		expect(accessSummary({ userId: 'u', role: 'member' }, projects, [])).toBe('All projects');
		expect(accessSummary({ userId: 'u', role: 'viewer' }, [projects[0]], [])).toBe('1 project');
	});

	it('shows a guest only the projects they were given', () => {
		const given: ProjectRoleView[] = [{ projectId: 'p2', userId: 'g', role: 'viewer' }];
		expect(accessSummary({ userId: 'g', role: 'guest' }, projects, [])).toBe('No projects yet');
		expect(accessSummary({ userId: 'g', role: 'guest' }, projects, given)).toBe('1 shared project');
		expect(
			accessSummary({ userId: 'g', role: 'guest' }, projects, [
				...given,
				{ projectId: 'p3', userId: 'g', role: 'member' }
			])
		).toBe('2 shared projects');
	});
});

describe('projectsOf', () => {
	it('gives a member the override of one project and the organisation role elsewhere', () => {
		const rows = projectsOf({ userId: 'm', role: 'member' }, projects, [
			{ projectId: 'p2', userId: 'm', role: 'viewer' },
			{ projectId: 'p1', userId: 'someone-else', role: 'admin' }
		]);
		expect(rows.map((r) => r.effective)).toEqual(['member', 'viewer', 'member']);
		expect(rows.map((r) => r.override)).toEqual([null, 'viewer', null]);
	});
});

describe('typed addresses', () => {
	it('splits on commas, semicolons and any whitespace, and drops empties', () => {
		expect(splitEmails('a@x.io, b@x.io;c@x.io\n d@x.io ,, ')).toEqual([
			'a@x.io',
			'b@x.io',
			'c@x.io',
			'd@x.io'
		]);
	});

	it('accepts a full address and refuses the rest', () => {
		expect(looksLikeEmail('noor@example.com')).toBe(true);
		for (const bad of ['sam@company', 'sam', '@x.io', 'a b@x.io', 'a@x@y.io'])
			expect(looksLikeEmail(bad), bad).toBe(false);
	});
});
