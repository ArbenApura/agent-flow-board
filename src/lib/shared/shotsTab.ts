// WHAT THE UI SHOTS TAB SAYS AND OFFERS. One pure function decides every state, so each one is one plain sentence and at most one action, and so the states can be tested without a browser.

// -- TYPES -- //

export type ShotsRunLite = {
	id: string;
	state: string;
	/** Screens that were shot (after pictures). Zero for a run that took no pictures. */
	screens: number;
	notes: string[];
	reason: string | null;
	createdAt: string | Date;
};

export type ShotsTabKey =
	| 'none'
	| 'waiting'
	| 'running'
	| 'offline'
	| 'failed'
	| 'unchanged'
	| 'up-to-date'
	| 'done'
	| 'private';

export type ShotsTabState = {
	key: ShotsTabKey;
	/** The one sentence the tab opens with. */
	sentence: string;
	/** Capture screens: shown for a person who may write, disabled with its reason beside it, never a tooltip. */
	button: { show: boolean; disabled: boolean; reason: string | null };
	/** The capture the cards show, and the ones before it (at most two). */
	shown: ShotsRunLite | null;
	earlier: ShotsRunLite[];
	/** A run that has been going for a long time: the sentence says so. */
	slow: boolean;
};

// -- CONSTANTS -- //

/** A capture that has run this long is "taking longer than usual". The board stops it by itself after 40 minutes. */
export const SLOW_MINUTES = 10;
export const TOOL_OFFLINE_SENTENCE =
	'Your agent has not connected the capture tool yet. It does this by itself the next time it captures.';
const BUSY_SENTENCE = 'A capture is already on its way.';
const MAX_EARLIER = 2;

// -- FUNCTIONS -- //

const time = (v: string | Date) => new Date(v).getTime();

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. The same words as the rest of the board. */
export function since(value: string | Date, now: number): string {
	const t = time(value);
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 45) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
	if (s < 14 * 86_400) return `${Math.round(s / 86_400)} d ago`;
	return new Date(t).toISOString().slice(0, 10);
}

/** The first line of a reason, cut to a sentence a person can read at a glance. */
function firstSentence(text: string | null): string {
	const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
	const t = line.trim().replace(/\s+/g, ' ');
	return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

const screensText = (n: number) => `${n} screen${n === 1 ? '' : 's'}`;

export function shotsTabState(input: {
	/** Newest first, as the board sends them. */
	runs: ShotsRunLite[];
	canWrite: boolean;
	toolOnline: boolean;
	canSeePictures: boolean;
	now: number;
}): ShotsTabState {
	const { runs, canWrite, toolOnline, canSeePictures, now } = input;
	const captures = runs.filter((r) => r.state === 'done' && r.screens > 0);
	const latest = runs[0] ?? null;
	const shown = canSeePictures ? (captures[0] ?? null) : null;
	const earlier = canSeePictures ? captures.slice(1, 1 + MAX_EARLIER) : [];
	const open = latest && (latest.state === 'queued' || latest.state === 'running') ? latest : null;
	const slow = Boolean(open && now - time(open.createdAt) > SLOW_MINUTES * 60_000);

	const button = (key: ShotsTabKey): ShotsTabState['button'] => {
		if (!canWrite || key === 'private') return { show: false, disabled: true, reason: null };
		if (open) return { show: true, disabled: true, reason: BUSY_SENTENCE };
		if (!toolOnline) return { show: true, disabled: true, reason: TOOL_OFFLINE_SENTENCE };
		return { show: true, disabled: false, reason: null };
	};
	// `again` adds "Press Capture screens to try again" only when the button can be pressed
	const result = (key: ShotsTabKey, sentence: string, again = false): ShotsTabState => {
		const btn = button(key);
		return {
			key,
			sentence:
				again && !btn.disabled ? `${sentence} Press Capture screens to try again.` : sentence,
			button: btn,
			shown,
			earlier,
			slow
		};
	};

	if (!canSeePictures)
		return result(
			'private',
			captures[0]
				? `${screensText(captures[0].screens)} captured ${since(captures[0].createdAt, now)}. Pictures are for members of this project.`
				: 'Pictures are for members of this project.'
		);
	if (!latest)
		return result(
			'none',
			canWrite
				? 'Nothing captured yet. Your agent captures screens after it changes one, or press Capture screens.'
				: 'Nothing captured yet.'
		);
	if (latest.state === 'queued')
		return result(
			'waiting',
			`Waiting for the capture tool. Asked ${since(latest.createdAt, now)}.${slow ? ' It is taking longer than usual.' : ''}`
		);
	if (latest.state === 'running')
		return result(
			'running',
			`Taking pictures. Started ${since(latest.createdAt, now)}.${slow ? ' It is taking longer than usual and stops by itself after 40 minutes.' : ''}`
		);
	if (latest.state === 'unavailable' || latest.state === 'timeout')
		return result(
			'offline',
			latest.state === 'timeout' || toolOnline
				? 'The last capture was not taken in time.'
				: TOOL_OFFLINE_SENTENCE,
			latest.state === 'timeout' || toolOnline
		);
	if (latest.state === 'failed') {
		const why = firstSentence(latest.reason);
		return result(
			'failed',
			`The last capture did not finish${why ? `: ${why}` : '.'}${why && !/[.!?]$/.test(why) ? '.' : ''}`,
			true
		);
	}
	// The newest run is done
	if (latest.screens > 0)
		return result(
			'done',
			`${screensText(latest.screens)} captured ${since(latest.createdAt, now)}.`
		);
	if (latest.notes.some((n) => /nothing changed since the last capture/i.test(n)))
		return result(
			'up-to-date',
			captures[0]
				? `Up to date. Nothing changed since the capture ${since(captures[0].createdAt, now)}.`
				: 'Up to date.'
		);
	return result('unchanged', 'No screen changed in this item.');
}

// -- THE SCREENS OF A CAPTURE -- //

export type ShotResultLite = {
	page: string;
	state: string;
	theme: string;
	viewport: number;
	side: string;
	image?: string | null;
};

export type Screen = {
	key: string;
	page: string;
	state: string;
	/** The picture of the old version, or null when the screen is new or the old version did not build. */
	before: string | null;
	after: string | null;
};

const THEME_ORDER = ['light', 'dark'];
const VIEWPORT_ORDER = [1440, 390];
const rank = <T>(order: T[], v: T) => (order.includes(v) ? order.indexOf(v) : order.length);

/** The colours and widths a capture has pictures for, in the order a person expects (light before dark, desktop before phone). */
export function viewOptions(results: ShotResultLite[]): { themes: string[]; viewports: number[] } {
	const after = results.filter((r) => r.side === 'after');
	const themes = [...new Set(after.map((r) => r.theme))].sort(
		(a, b) => rank(THEME_ORDER, a) - rank(THEME_ORDER, b) || a.localeCompare(b)
	);
	const viewports = [...new Set(after.map((r) => r.viewport))].sort(
		(a, b) => rank(VIEWPORT_ORDER, a) - rank(VIEWPORT_ORDER, b) || b - a
	);
	return { themes, viewports };
}

export const viewportLabel = (v: number) =>
	v === 1440 ? 'Desktop' : v === 390 ? 'Phone' : `${v} wide`;

/** The screens of a capture at one colour and width: each with its old and new picture. Sibling pictures are never listed. */
export function screensOf(
	results: ShotResultLite[],
	view: { theme: string; viewport: number }
): Screen[] {
	const here = results.filter((r) => r.theme === view.theme && r.viewport === view.viewport);
	// One screen per page and state, so a repeated row can never give two cards the same key
	const seen = new Set<string>();
	return here
		.filter((r) => r.side === 'after')
		.filter((r) => {
			const key = `${r.page}|${r.state}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((a) => ({
			key: `${a.page}|${a.state}`,
			page: a.page,
			state: a.state,
			after: a.image ?? null,
			before:
				here.find((b) => b.side === 'before' && b.page === a.page && b.state === a.state)?.image ??
				null
		}));
}

/** True when the old and the new picture are the very same picture, so the screen looks the same and needs no card. */
export function sameLook(screen: Screen, sums: Record<string, string>): boolean {
	return Boolean(
		screen.before &&
		screen.after &&
		sums[screen.before] &&
		sums[screen.before] === sums[screen.after]
	);
}
