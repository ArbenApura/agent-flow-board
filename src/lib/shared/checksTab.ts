// WHAT THE CHECKS TAB SAYS ABOUT A CHECK: ITS STATUS IN ONE WORD, AND WHAT WENT WRONG IN ONE SENTENCE. Pure, so each answer is tested without a browser.

// -- TYPES -- //

export type CheckRunLite = {
	result: string;
	reason: string | null;
	durationMs: number | null;
	stepKey: string | null;
};

export type CheckStatus = {
	label: string;
	tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'running';
};

// -- CONSTANTS -- //

const RESULT: Record<string, CheckStatus> = {
	pass: { label: 'Passed', tone: 'success' },
	fail: { label: 'Failed', tone: 'danger' },
	error: { label: 'Failed', tone: 'danger' },
	timeout: { label: 'Could not run', tone: 'warning' },
	unavailable: { label: 'Could not run', tone: 'warning' },
	queued: { label: 'Waiting for the runner', tone: 'info' },
	running: { label: 'Running', tone: 'running' }
};

// -- FUNCTIONS -- //

/** The word a run carries: Passed, Failed, Running, Waiting for the runner, or Could not run. */
export const resultStatus = (result: string): CheckStatus =>
	RESULT[result] ?? { label: result, tone: 'neutral' };

/**
 * The status of a check: its newest run when it has one, else what its manual check says (Open, or Closed once a pass closed it).
 * `runs` are newest first.
 */
export function checkStatus(manualState: string, runs: CheckRunLite[]): CheckStatus {
	if (runs[0]) return resultStatus(runs[0].result);
	return manualState === 'open'
		? { label: 'Open', tone: 'neutral' }
		: { label: 'Closed', tone: 'success' };
}

/** The first line of a reason, cut to one readable sentence. */
function firstLine(text: string | null): string {
	const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
	const t = line.trim().replace(/\s+/g, ' ');
	return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/**
 * One sentence about a run that did not pass, with the one thing to do, or null for a run that passed or is still going.
 * A check that failed is for the agent to fix; a run that could not start is asked again once the runner is connected.
 */
export function failureSentence(run: CheckRunLite): string | null {
	if (run.result === 'fail' || run.result === 'error') {
		const why = firstLine(run.reason);
		const stop = why && !/[.!?]$/.test(why) ? '.' : '';
		return `${why ? `${why}${stop} ` : ''}Ask your agent to look into it.`;
	}
	if (run.result === 'timeout' || run.result === 'unavailable')
		return 'The runner did not take this run. Press Run check again once it is connected.';
	return null;
}

/** "2.4 s" for a run that took a while, empty for one with no time. */
export const seconds = (ms: number | null): string =>
	ms == null ? '' : `${(ms / 1000).toFixed(1)} s`;

/** "Closed step 1.2" when a passing run closed a plan step, else empty. */
export const closedStep = (run: CheckRunLite): string =>
	run.result === 'pass' && run.stepKey ? `Closed step ${run.stepKey}` : '';
