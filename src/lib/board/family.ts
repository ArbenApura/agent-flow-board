// HELPERS FOR MASTER AND CHILD PLANS, SHARED BY THE BOARD CARD, THE LIST AND THE CHILDREN TAB

// IMPORTED TYPES
import type { KidRow } from './rows';

// -- FUNCTIONS -- //

/** How many child plans are done, running and still planned. Running means in progress. */
export const childCounts = (kids: Pick<KidRow, 'status'>[]) => {
	const done = kids.filter((k) => k.status === 'COMPLETED').length;
	const running = kids.filter((k) => k.status === 'IN PROGRESS').length;
	return { n: kids.length, done, running, planned: kids.length - done - running };
};

/** The line under a master card and in the roadmap: `10 child plans · 3 done · 1 running`, or `all done` when every one is. */
export const childSummary = (kids: Pick<KidRow, 'status'>[]) => {
	const c = childCounts(kids);
	const head = `${c.n} child ${c.n === 1 ? 'plan' : 'plans'}`;
	if (c.n > 0 && c.done === c.n) return `${head} · all done`;
	return `${head} · ${c.done} done${c.running ? ` · ${c.running} running` : ''}`;
};

/** The line on a child card: `Child 8 of 10 · Centers UI-UX overhaul`. */
export const parentLine = (p: { childNo: number; childTotal: number; title: string }) =>
	`Child ${p.childNo} of ${p.childTotal} · ${p.title}`;

/** A child's page address from its master's, which sits in the same project: the last segment is the reference. */
export const siblingHref = (href: string, ref: string) =>
	href.slice(0, href.lastIndexOf('/') + 1) + ref;
