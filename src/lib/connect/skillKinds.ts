// THE KIND, THE ICON AND THE ONE LINE OF EACH SYSTEM SKILL, FOR THE SKILLS TAB OF CONNECT A TOOL. PURE, SO A TEST CAN HOLD IT TOGETHER WITH THE BUNDLE.
// The bundle ships the skills (system-skills/manifest.json); this file only says how the page groups and words them.

// -- TYPES -- //

export type SkillKind = 'Plan' | 'Check' | 'Design' | 'Setup' | 'Other';
export type SkillIcon =
	| 'route'
	| 'list-checks'
	| 'messages-square'
	| 'scan-search'
	| 'clipboard-list'
	| 'pencil-ruler'
	| 'compass'
	| 'sparkles';
export type SkillInfo = { kind: SkillKind; icon: SkillIcon; summary: string };

// -- CONSTANTS -- //

/** The kinds a person can filter by, in the order of the chips. A skill with no entry here is shown as Other. */
export const SKILL_KINDS: readonly SkillKind[] = ['Plan', 'Check', 'Design', 'Setup'];

/** One entry for every skill of the bundle. A test fails when a shipped skill has none. */
export const SKILL_INFO: Record<string, SkillInfo> = {
	flow: {
		kind: 'Plan',
		icon: 'route',
		summary:
			'Plans, builds and tracks a feature, fix or refactor on the board, phase by phase, with a gate before any code.'
	},
	'flow-task': {
		kind: 'Plan',
		icon: 'list-checks',
		summary:
			'Turns a one-line to-do or a pasted list into tasks on the board. It only records and never starts the work.'
	},
	'flow-interview': {
		kind: 'Plan',
		icon: 'messages-square',
		summary:
			'Asks you plain multiple-choice questions until every gap in a plan is settled, then writes your answers back.'
	},
	'flow-audit': {
		kind: 'Check',
		icon: 'clipboard-list',
		summary:
			'Compares what was built with what the board says, in both directions, and fixes the board so it tells the truth.'
	},
	'flow-mockup': {
		kind: 'Design',
		icon: 'pencil-ruler',
		summary:
			'Draws an interactive mockup in the project’s own markup and styles, and publishes it to the board.'
	},
	'flow-align': {
		kind: 'Setup',
		icon: 'compass',
		summary:
			'Brings your rule files and your agent’s memory in line with the flow rules, backing every file up first.'
	},
	'flow-critic': {
		kind: 'Check',
		icon: 'scan-search',
		summary:
			'Sends independent reviewers over a plan, the code, a mockup or every screen; works out which one you meant and asks once when it cannot tell.'
	},
	'flow-decide': {
		kind: 'Plan',
		icon: 'route',
		summary:
			'Decides small choices itself from the code and the plan, records them and reports, and asks only what is yours.'
	},
	'flow-autopilot': {
		kind: 'Plan',
		icon: 'route',
		summary:
			'Runs an approved plan to the end on its own, decides with flow-decide and stops only for the six real reasons.'
	},
	'flow-commit': {
		kind: 'Plan',
		icon: 'clipboard-list',
		summary:
			'Commits this session’s work with a conventional message that explains the problem, with or without a plan.'
	},
	'flow-qa': {
		kind: 'Check',
		icon: 'scan-search',
		summary:
			'Tests the app like a person in your own browser, maps its features and files one bug per cause on the Testing page.'
	},
	'flow-screens': {
		kind: 'Check',
		icon: 'scan-search',
		summary:
			'Opens your running app, captures the screens a plan changed sharp and whole, and shows them on the plan’s Screens tab.'
	},
	'flow-update-skills': {
		kind: 'Setup',
		icon: 'compass',
		summary:
			'Checks, installs and updates these skills straight over the old files, and removes obsolete ones.'
	}
};

// -- FUNCTIONS -- //

/** The first sentence of a long description, kept short, for a skill the map does not know yet. */
function firstSentence(text: string): string {
	const one = text.replace(/\s+/g, ' ').trim();
	const end = one.search(/[.!?](\s|$)/);
	const sentence = end > 0 ? one.slice(0, end + 1) : one;
	return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}...` : sentence;
}

/** The kind, icon and line of one skill. An unknown skill is shown as Other with its own first sentence. */
export function skillInfo(name: string, description: string): SkillInfo {
	return (
		SKILL_INFO[name] ?? { kind: 'Other', icon: 'sparkles', summary: firstSentence(description) }
	);
}

/** The skills that match what the person typed and the kind they chose. A word is looked for in the name and the line, any case. */
export function filterSkills<T extends { name: string; kind: SkillKind; summary: string }>(
	rows: T[],
	kind: 'All' | SkillKind,
	term: string
): T[] {
	const t = term.trim().toLowerCase();
	return rows.filter(
		(r) =>
			(kind === 'All' || r.kind === kind) &&
			(!t || `${r.name} ${r.summary}`.toLowerCase().includes(t))
	);
}
