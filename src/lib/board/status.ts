// HOW AN ITEM STATUS, A PROJECT COLOUR AND A TIME ARE SHOWN, SHARED BY EVERY BOARD PAGE

// -- TYPES -- //
export type Status =
	'PLANNED' | 'IN PROGRESS' | 'TESTING' | 'IN REVIEW' | 'ON HOLD' | 'COMPLETED' | 'REMOVED';
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'running';

// -- CONSTANTS -- //

export const VIEWS = ['board', 'areas', 'list'] as const;
export type View = (typeof VIEWS)[number];

export const STATUSES: Status[] = [
	'PLANNED',
	'IN PROGRESS',
	'TESTING',
	'IN REVIEW',
	'ON HOLD',
	'COMPLETED',
	'REMOVED'
];

/** The columns of the board view. REMOVED items live in the trash and the list view, not on the board. */
export const BOARD_COLUMNS: Status[] = [
	'PLANNED',
	'IN PROGRESS',
	'TESTING',
	'IN REVIEW',
	'ON HOLD',
	'COMPLETED'
];

export const STATUS_TONE: Record<Status, Tone> = {
	PLANNED: 'neutral',
	'IN PROGRESS': 'accent',
	TESTING: 'info',
	'IN REVIEW': 'warning',
	'ON HOLD': 'neutral',
	COMPLETED: 'success',
	REMOVED: 'danger'
};

/** The dot colour of a project's colour tag. Tokens only, so the dot follows the theme. */
export const TAG_DOT: Record<string, string> = {
	blue: 'bg-info',
	green: 'bg-success',
	purple: 'bg-accent',
	red: 'bg-danger',
	amber: 'bg-warning',
	orange: 'bg-warning'
};

// -- FUNCTIONS -- //

export const tagDot = (tag: string | null | undefined) => (tag && TAG_DOT[tag]) || 'bg-muted';

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function ago(value: string | Date, now = Date.now()): string {
	const t = new Date(value).getTime();
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 45) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
	if (s < 14 * 86_400) return `${Math.round(s / 86_400)} d ago`;
	return new Date(t).toISOString().slice(0, 10);
}

/** What each drift warning means, in plain words. The warnings never block anything. */
export const DRIFT_TEXT: Record<string, string> = {
	'planned-with-done-steps': 'Steps are done but the status is still planned.',
	'complete-not-in-review':
		'Every step is done, so the status should be in review. Set it, or add the steps still missing.',
	'in-review-with-open-steps':
		'This item is in review but a step is open. Set it back to in progress if more work is coming.',
	'ready-for-sign-off': 'Every step and manual check is closed. It is ready for sign-off.'
};
