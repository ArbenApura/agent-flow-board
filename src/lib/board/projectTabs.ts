// THE PAGES OF A PROJECT, IN THE ORDER THE SIDEBAR, THE PHONE MENU AND THE COMMAND PALETTE SHOW THEM
// One list, read by all three, so they always agree. Five main pages, then Trash and Project settings (DESIGN.md, App shell).

// -- TYPES -- //

export type ProjectTab = { href: string; label: string; exact?: boolean };

// -- CONSTANTS -- //

/** Every label a project page can have. The sidebar keeps one icon for each of these. */
export const PROJECT_TAB_LABELS = [
	'Registry',
	'Tasks',
	'Notes',
	'Activity',
	'Mockups',
	'Trash',
	'Project settings'
] as const;

// -- FUNCTIONS -- //

/**
 * The main pages and the secondary ones of one project. Notes are not shared with guests (AFB-20261111-0035), so a guest
 * on the project gets no Notes link; the role is unknown for a moment while a project loads, and the link shows then.
 */
export function projectTabs(
	base: string,
	key: string,
	role?: string | null
): { primary: ProjectTab[]; secondary: ProjectTab[] } {
	const at = (path: string) => `${base}/${key}${path}`;
	const primary: ProjectTab[] = [
		{ href: at(''), label: 'Registry', exact: true },
		{ href: at('/tasks'), label: 'Tasks' },
		{ href: at('/notes'), label: 'Notes' },
		{ href: at('/activity'), label: 'Activity' },
		{ href: at('/mockups'), label: 'Mockups' }
	];
	return {
		primary: role === 'guest' ? primary.filter((t) => t.label !== 'Notes') : primary,
		secondary: [
			{ href: at('/trash'), label: 'Trash' },
			{ href: at('/settings'), label: 'Project settings' }
		]
	};
}
