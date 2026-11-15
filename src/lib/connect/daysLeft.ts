// HOW LONG A CONNECTION OR A SIGN IN HAS LEFT, FOR THE DAYS LEFT BAR OF THE CONNECT PAGE. PURE, SO THE WORDS AND THE TONE ARE TESTED.

// -- TYPES -- //

export type DaysLeft = {
	/** Whole days left, never negative. */
	days: number;
	/** How much of its life is left, 0 to 100, for the width of the bar. */
	percent: number;
	/** Warning when under a week is left, danger when it has ended, success otherwise. */
	tone: 'success' | 'warning' | 'danger';
	/** The plain words: 28 days left, 1 day left, Ends today, Ended. */
	label: string;
};

// -- CONSTANTS -- //

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** The life assumed when the start is not known: the longest a token lasts. */
const DEFAULT_LIFE_MS = 90 * DAY_MS;

// -- FUNCTIONS -- //

const time = (v: Date | string): number => new Date(v).getTime();

/**
 * What is left of a life that ends at `expiresAt`. `startedAt` is when it began, so the bar shows the share that is left; without it
 * the share is taken against the longest life a token can have. `null` for a thing that never ends.
 */
export function daysLeft(
	expiresAt: Date | string | null,
	startedAt: Date | string | null = null,
	now: Date = new Date()
): DaysLeft | null {
	if (!expiresAt) return null;
	const end = time(expiresAt);
	const left = end - now.getTime();
	if (left <= 0) return { days: 0, percent: 0, tone: 'danger', label: 'Ended' };
	const life = startedAt && time(startedAt) < end ? end - time(startedAt) : DEFAULT_LIFE_MS;
	const days = Math.floor(left / DAY_MS);
	return {
		days,
		percent: Math.max(2, Math.min(100, Math.round((left / life) * 100))),
		tone: left < WEEK_MS ? 'warning' : 'success',
		label: days >= 2 ? `${days} days left` : days === 1 ? '1 day left' : 'Ends today'
	};
}
