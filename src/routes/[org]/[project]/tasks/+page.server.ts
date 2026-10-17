// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { bodyPreview } from '#lib/board/tasks.js';
import { renderMarkdownCached } from '#lib/markdown.js';
import { refsFor } from '#lib/server/ops/board.js';
import { listTasks } from '#lib/server/ops/docs.js';
import { listMembers } from '#lib/server/orgs/orgs.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * The tasks of the project, the references of the items they link and the names of the people. A row carries a short plain
 * preview of its body, never the whole text. The task named by the `task` search param also carries its full body and the
 * sanitised HTML, so one long description is not sent to everyone on every refresh.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { tasks: [], refs: {}, people: {}, openTask: null };
	const ctx = await childContext(locals, org.id);
	const [tasks, members] = await Promise.all([
		listTasks(ctx, params.project),
		listMembers(ctx.handle, org.id)
	]);
	const refs = await refsFor(
		ctx,
		params.project,
		tasks.flatMap((t) => t.linkedItemIds)
	);
	const openId = url.searchParams.get('task');
	const open = openId ? tasks.find((t) => t.id === openId) : undefined;
	return {
		tasks: tasks.map((t) => ({ ...t, body: bodyPreview(t.body) })),
		refs,
		people: Object.fromEntries(members.map((m) => [m.userId, m.name])),
		// Imported and guest-written text is untrusted: no images, links marked nofollow, everything sanitised
		openTask: open
			? { id: open.id, body: open.body, html: renderMarkdownCached(open.body, { untrusted: true }) }
			: null
	};
};
