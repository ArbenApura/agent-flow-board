// HOW AN ITEM STATUS, A PROJECT COLOUR AND A TIME ARE SHOWN, SHARED BY EVERY BOARD PAGE

// -- TYPES -- //
export type Status = 'PLANNED' | 'IN PROGRESS' | 'IN REVIEW' | 'ON HOLD' | 'COMPLETED' | 'REMOVED';
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'running';

// -- CONSTANTS -- //

export const VIEWS = ['board', 'areas', 'list'] as const;
export type View = (typeof VIEWS)[number];

export const STATUSES: Status[] = [
	'PLANNED',
	'IN PROGRESS',
	'IN REVIEW',
	'ON HOLD',
	'COMPLETED',
	'REMOVED'
];

/** The columns of the board view. REMOVED items live in the trash and the list view, not on the board. */
export const BOARD_COLUMNS: Status[] = [
	'PLANNED',
	'IN PROGRESS',
	'IN REVIEW',
	'ON HOLD',
	'COMPLETED'
];

export const STATUS_TONE: Record<Status, Tone> = {
	PLANNED: 'neutral',
	'IN PROGRESS': 'accent',
	'IN REVIEW': 'warning',
	'ON HOLD': 'neutral',
	COMPLETED: 'success',
	REMOVED: 'danger'
};

/** The dot and the top edge of a status on the board. Fixed status tokens, never the org accent. */
export const STATUS_STYLE: Record<Status, { dot: string; top: string; rail: string }> = {
	PLANNED: { dot: 'bg-muted', top: 'border-t-muted', rail: 'bg-muted' },
	'IN PROGRESS': { dot: 'bg-info', top: 'border-t-info', rail: 'bg-info' },
	'IN REVIEW': { dot: 'bg-warning', top: 'border-t-warning', rail: 'bg-warning' },
	'ON HOLD': { dot: 'bg-hold', top: 'border-t-hold', rail: 'bg-hold' },
	COMPLETED: { dot: 'bg-success', top: 'border-t-success', rail: 'bg-success' },
	REMOVED: { dot: 'bg-danger', top: 'border-t-danger', rail: 'bg-danger' }
};

/** The column widths of the list view, shared by its header and its rows so they line up. Smaller screens drop the wider columns. */
export const LIST_COLS = {
	// Room for a stamped reference such as HAPR-20261017-0950-b (about 20 characters in mono); on a phone it wraps at its dashes
	ref: 'w-40 shrink-0 max-sm:w-28',
	status: 'w-32 shrink-0',
	progress: 'w-44 shrink-0 max-lg:hidden',
	area: 'w-40 shrink-0 max-md:hidden',
	updated: 'w-28 shrink-0 text-right max-sm:hidden'
};

// -- FUNCTIONS -- //

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
