// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { qaBugIsOpen, qaTabOf } from '#lib/board/qa/status.js';
import { OpError } from '#lib/server/ops/context.js';
import { getMap, liveCaseKeys } from '#lib/server/ops/qa.js';
import { listBugs, listRuns } from '#lib/server/ops/qaRuns.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- CONSTANTS -- //

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// -- FUNCTIONS -- //

/**
 * The QA map of the project with each feature's status, its journey and case totals and its results, the newest run and a bug
 * summary for the overview, and the full runs or bugs list only when their tab is open. Testing is not shared with guests,
 * like Notes (AFB-20261125-0442). Refetched when the live stream reports a change.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	const tab = qaTabOf(url.searchParams.get('tab'));
	const none = {
		tab,
		features: [],
		runs: null,
		runCount: 0,
		bugs: null,
		lastRun: null,
		bugSummary: { open: 0, major: 0, fixedThisWeek: 0 },
		canWrite: false
	};
	if (!summary) return { ...none, denied: null };
	if (summary.role === 'guest') return { ...none, denied: { needed: 'Viewer', role: 'Guest' } };
	const ctx = await childContext(locals, org.id);
	try {
		const [map, runs, bugs] = await Promise.all([
			getMap(ctx, { project: params.project }),
			listRuns(ctx, { project: params.project, limit: 100 }),
			listBugs(ctx, { project: params.project })
		]);
		const now = Date.now();
		const open = bugs.filter((b) => qaBugIsOpen(b.status));
		return {
			tab,
			features: map.features.map((f) => {
				const journeys = f.map.journeys.filter((j) => !j.removedAt);
				// The same live case keys the status is derived from, so a duplicate key never counts twice
				const cases = liveCaseKeys(f.map).size;
				return {
					id: f.id,
					key: f.key,
					area: f.area,
					name: f.name,
					sizes: [...new Set(f.sizes)],
					status: f.status,
					flaky: f.flaky,
					openBugs: f.bugs.length,
					lastTestedAt: f.lastTestedAt,
					lastCommit: f.lastCommit,
					journeys: journeys.length,
					cases,
					works: f.casesWorking
				};
			}),
			runs: tab === 'runs' ? runs : null,
			runCount: runs.length,
			bugs: tab === 'bugs' ? bugs : null,
			lastRun: runs[0]
				? {
						runNo: runs[0].runNo,
						goNoGo: runs[0].report?.goNoGo ?? null,
						commit: runs[0].commit,
						createdAt: runs[0].createdAt
					}
				: null,
			// What the overview shows: the bugs still open, the major ones among them, and what was fixed in the last 7 days
			bugSummary: {
				open: open.length,
				major: open.filter((b) => b.severity === 'blocker' || b.severity === 'major').length,
				fixedThisWeek: bugs.filter(
					(b) => b.status === 'DONE' && now - new Date(b.updatedAt).getTime() <= WEEK_MS
				).length
			},
			canWrite: summary.caps.includes('write'),
			denied: null
		};
	} catch (e) {
		if (e instanceof OpError) return { ...none, ...pageError(e) };
		throw e;
	}
};
