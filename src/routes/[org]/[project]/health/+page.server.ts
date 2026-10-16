// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { projectHealth } from '#lib/server/ops/health.js';
import { listEvents } from '#lib/server/ops/history.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project health panel: what needs attention, none of it blocking. */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { health: null, daily: [] };
	const ctx = await childContext(locals, org.id);
	const [health, events] = await Promise.all([
		projectHealth(ctx, params.project),
		listEvents(ctx, { project: params.project, limit: 200 })
	]);
	// CHANGES PER DAY FOR THE LAST 14 DAYS, OLDEST FIRST
	const day = (d: Date) => d.toISOString().slice(0, 10);
	const counts = new Map<string, number>();
	for (const e of events)
		counts.set(day(new Date(e.createdAt)), (counts.get(day(new Date(e.createdAt))) ?? 0) + 1);
	const daily = Array.from({ length: 14 }, (_, i) => {
		const d = day(new Date(Date.now() - (13 - i) * 86_400_000));
		return { day: d, count: counts.get(d) ?? 0 };
	});
	return { health, daily };
};
