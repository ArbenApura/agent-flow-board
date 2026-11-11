// -- DEP-MODULES -- //
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { PROJECT_TAB_LABELS, projectTabs } from './projectTabs';

describe('the pages of a project', () => {
	it('lists five main pages in order, Notes after Tasks, then Trash and Project settings', () => {
		const { primary, secondary } = projectTabs('/acme', 'AFB', 'member');
		expect(primary.map((t) => t.label)).toEqual([
			'Registry',
			'Tasks',
			'Notes',
			'Activity',
			'Mockups'
		]);
		expect(primary.map((t) => t.href)).toEqual([
			'/acme/AFB',
			'/acme/AFB/tasks',
			'/acme/AFB/notes',
			'/acme/AFB/activity',
			'/acme/AFB/mockups'
		]);
		expect(primary[0].exact).toBe(true);
		expect(secondary.map((t) => t.label)).toEqual(['Trash', 'Project settings']);
	});

	it('gives a guest no Notes link, and everyone else one', () => {
		expect(projectTabs('/acme', 'AFB', 'guest').primary.map((t) => t.label)).toEqual([
			'Registry',
			'Tasks',
			'Activity',
			'Mockups'
		]);
		for (const role of ['owner', 'admin', 'member', 'viewer', undefined, null])
			expect(
				projectTabs('/acme', 'AFB', role).primary.some((t) => t.label === 'Notes'),
				String(role)
			).toBe(true);
	});

	it('every page has a label the sidebar knows, and the sidebar has an icon for every label', () => {
		const { primary, secondary } = projectTabs('/acme', 'AFB');
		const labels = [...primary, ...secondary].map((t) => t.label);
		expect(labels).toEqual([...PROJECT_TAB_LABELS]);
		// The icon map lives inside the sidebar component, so it is read as text: a label with no key there breaks the sidebar
		const sidebar = readFileSync(new URL('./AppSidebar.svelte', import.meta.url), 'utf8');
		const map = /const TAB_ICON[^=]*=\s*\{([\s\S]*?)\};/.exec(sidebar)?.[1] ?? '';
		for (const label of PROJECT_TAB_LABELS) {
			const key = /^[A-Za-z]+$/.test(label) ? label : `'${label}'`;
			expect(
				new RegExp(`(^|[\\s,{])${key}\\s*[:,]|(^|[\\s,{])${key}\\s*$`, 'm').test(map),
				label
			).toBe(true);
		}
	});
});
