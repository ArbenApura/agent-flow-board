// THE SLIM ROW A LIST SHOWS, BUILT THE SAME WAY ON THE SERVER (FIRST PAGE) AND IN THE BROWSER (LATER PAGES)

// IMPORTED TYPES
import type { Status } from './status';

export type WaitingBlocker = {
	kind: 'sign-in' | 'approval' | 'decision';
	detail: string;
	target?: string;
	setAt: string;
};

/** A child plan of a master, as the master card and the Children tab show it. */
export type KidRow = {
	id: string;
	ref: string;
	title: string;
	status: string;
	percent: number;
	doneSteps: number;
	totalSteps: number;
	childNo: number;
};

/** The master of a child plan, with this plan's number and how many children the master has. */
export type ParentRow = { ref: string; title: string; childNo: number; childTotal: number };

/** What loadFamily answers for a page of items. */
export type ApiFamily = {
	kids: Record<string, KidRow[]>;
	parents: Record<string, ParentRow>;
};

export type ItemRow = {
	id: string;
	ref: string;
	number: number;
	title: string;
	status: Status;
	percent: number;
	doneSteps: number;
	totalSteps: number;
	visibility: string;
	stream: string;
	scope: string;
	flags: number;
	/** The person who made the plan, or null for an imported one. Names come from the project summary. */
	createdBy: string | null;
	lastActivityAt: string;
	/** The master of this plan when it is a child the person can see the master of. */
	parent?: ParentRow | null;
	/** The child plans of this plan when it is a master, in order. */
	kids?: KidRow[];
};

/** The columns of an item row that a list needs, as the API returns them (dates arrive as text from JSON). */
export type ApiItem = {
	id: string;
	ref: string;
	number: number;
	title: string;
	status: string;
	percent: number;
	legacyPercent?: number | null;
	doneSteps: number;
	totalSteps: number;
	visibility: string;
	stream: string;
	scope: string;
	health?: {
		flags?: string[];
		drift?: string[];
	} | null;
	createdBy?: string | null;
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
	/** Waiting-for-a-person blocker on this session, when set (D.5). */
	waiting?: WaitingBlocker | null;
	/** When the session started and when it was last seen, so a stuck claim shows how old it is. */
	startedAt: string | Date;
	lastSeenAt: string | Date;
};

// -- FUNCTIONS -- //

export const slimItem = (i: ApiItem, family?: ApiFamily): ItemRow => ({
	parent: family?.parents[i.id] ?? null,
	kids: family?.kids[i.id] ?? [],
	id: i.id,
	ref: i.ref,
	number: i.number,
	title: i.title,
	status: i.status as Status,
	percent: i.percent,
	doneSteps: i.doneSteps,
	totalSteps: i.totalSteps,
	visibility: i.visibility,
	stream: i.stream,
	scope: i.scope,
	flags: (i.health?.flags?.length ?? 0) + (i.health?.drift?.length ?? 0),
	createdBy: i.createdBy ?? null,
	lastActivityAt: new Date(i.lastActivityAt).toISOString()
});
