// THE SLIM ROW A LIST SHOWS, BUILT THE SAME WAY ON THE SERVER (FIRST PAGE) AND IN THE BROWSER (LATER PAGES)

// -- TYPES -- //
import type { Status } from './status';

export type ItemRow = {
	id: string;
	ref: string;
	number: number;
	title: string;
	status: Status;
	percent: number;
	doneSteps: number;
	totalSteps: number;
	openManual: number;
	visibility: string;
	stream: string;
	scope: string;
	flags: number;
	lastActivityAt: string;
};

/** The columns of an item row that a list needs, as the API returns them (dates arrive as text from JSON). */
export type ApiItem = {
	id: string;
	ref: string;
	number: number;
	title: string;
	status: string;
	percent: number;
	doneSteps: number;
	totalSteps: number;
	openManual: number;
	visibility: string;
	stream: string;
	scope: string;
	health?: { flags?: string[]; drift?: string[] } | null;
	lastActivityAt: string | Date;
};

export type Running = {
	itemId: string;
	itemRef: string;
	/** The phase the session is working, or null when it works the whole item. */
	phase: string | null;
	tool: string;
	/** TAB_NAME: REF, the title the session shows. */
	title: string;
	sessionId: string;
	/** Minutes since finished work was last left unrecorded, or null when the session is up to date (progress first). */
	staleMinutes: number | null;
	/** The plan has a mockup that nobody has read to the end in its current version. Missing means it was not looked up. */
	mockupUnread?: boolean;
	/** The item is in review with nothing open and the session has been quiet: shown as In review, idle, not as running. */
	reviewIdle: boolean;
	/** When the session started and when it was last seen, so a stuck claim shows how old it is. */
	startedAt: string | Date;
	lastSeenAt: string | Date;
};

// -- FUNCTIONS -- //

export const slimItem = (i: ApiItem): ItemRow => ({
	id: i.id,
	ref: i.ref,
	number: i.number,
	title: i.title,
	status: i.status as Status,
	percent: i.percent,
	doneSteps: i.doneSteps,
	totalSteps: i.totalSteps,
	openManual: i.openManual,
	visibility: i.visibility,
	stream: i.stream,
	scope: i.scope,
	flags: (i.health?.flags?.length ?? 0) + (i.health?.drift?.length ?? 0),
	lastActivityAt: new Date(i.lastActivityAt).toISOString()
});
