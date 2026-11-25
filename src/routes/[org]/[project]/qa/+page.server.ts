// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { qaTabOf } from '#lib/board/qa/status.js';
import { OpError } from '#lib/server/ops/context.js';
import { getMap, getSettings } from '#lib/server/ops/qa.js';
import { listBugs, listRuns } from '#lib/server/ops/qaRuns.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * The QA map of the project with each feature's status, and the runs or the bugs only when their tab is open. Testing is not
 * shared with guests, like Notes (AFB-20261125-0442). Refetched when the live stream reports a change.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	const tab = qaTabOf(url.searchParams.get('tab'));
	const none = {
		tab,
		features: [],
		runs: null,
		bugs: null,
		targets: [],
		localPreview: '',
		canEdit: false,
		canWrite: false
	};
	if (!summary) return { ...none, denied: null };
	if (summary.role === 'guest') return { ...none, denied: { needed: 'Viewer', role: 'Guest' } };
	const ctx = await childContext(locals, org.id);
	try {
		const [map, settings, runs, bugs] = await Promise.all([
			getMap(ctx, { project: params.project }),
			getSettings(ctx, { project: params.project }),
			tab === 'runs' ? listRuns(ctx, { project: params.project }) : Promise.resolve(null),
			tab === 'bugs' ? listBugs(ctx, { project: params.project }) : Promise.resolve(null)
		]);
		return {
			tab,
			features: map.features.map((f) => ({
				id: f.id,
				key: f.key,
				area: f.area,
				name: f.name,
				sizes: f.sizes,
				status: f.status,
				flaky: f.flaky,
				openBugs: f.bugs.length,
				lastTestedAt: f.lastTestedAt,
				lastCommit: f.lastCommit
			})),
			runs,
			bugs,
			targets: settings.targets,
			localPreview: settings.localPreview,
			canEdit: settings.canEdit,
			canWrite: summary.caps.includes('write'),
			denied: null
		};
	} catch (e) {
		if (e instanceof OpError) return { ...none, ...pageError(e) };
		throw e;
	}
};
