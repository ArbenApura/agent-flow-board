// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { refsFor } from '#lib/server/ops/board.js';
import { listEvents } from '#lib/server/ops/history.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The project's activity log, newest first, optionally for one agent session. */
export const load: PageServerLoad = async ({ params, parent, locals, url, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	const sessionId = url.searchParams.get('session') || undefined;
	if (!summary) return { events: [], refs: {}, sessionId };
	const ctx = await childContext(locals, org.id);
	const events = await listEvents(ctx, { project: params.project, sessionId, limit: 100 });
	const refs = await refsFor(
		ctx,
		params.project,
		events.flatMap((e) => (e.itemId ? [e.itemId] : []))
	);
	return { events, refs, sessionId };
};
