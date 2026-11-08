// THE VALUES THIS MOD KEEPS IN $.state: THE LAST ANSWER OF THE BOARD AND WHAT THE TIMER NEEDS TO KNOW ABOUT IT

/** The item part of the board's answer, as the status line needs it. */
export type Item = {
	ref: string;
	title: string;
	tabName: string | null;
	status: string;
	percent: number;
	phase: { key: string; title: string; position: number; of: number } | null;
	steps: { done: number; open: number; waived: number; total: number };
	manualChecksOpen: number;
	resumeHere: string;
	blockers: string;
	url: string | null;
};

/**
 * What the band says. `ok` and `none` are answers from the board; `token`, `notfound` and `down` are failures that are shown
 * as such; `setup` means a setting is missing; `loading` is the first moment before any answer.
 */
export type View = {
	kind: 'loading' | 'setup' | 'ok' | 'none' | 'notfound' | 'token' | 'down';
	/** The last good item. It is kept through `down` (shown marked as old) and dropped for every other failure. */
	item: Item | null;
	/** The etag of the last good answer, sent back so the board can answer unchanged. */
	etag: string | null;
	/** When the last good answer, or the last unchanged answer, came (milliseconds). */
	goodAt: number;
	/** Not before this time (milliseconds) does the timer ask again, so a failing board is not hammered. */
	nextAt: number;
	/** Failures in a row, for the back off. */
	failures: number;
	/** Whether the details (resume here and blockers) are open. */
	isExpanded: boolean;
};

declare module 'claude-code' {
	interface PluginState {
		'afb-flow-status': { view: Shaped<View> };
	}
}
