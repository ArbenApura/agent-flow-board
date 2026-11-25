// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { OpError } from '#lib/server/ops/context.js';
import { refsFor } from '#lib/server/ops/board.js';
import { getProject } from '#lib/server/ops/projects.js';
import { listEvents, listTrash } from '#lib/server/ops/history.js';
import { listPitfalls } from '#lib/server/ops/pitfalls.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- TYPES -- //

type TrashList = Awaited<ReturnType<typeof listTrash>>;

// -- FUNCTIONS -- //

/**
 * The project's settings. Everyone who can read the project may look, admins and owners change. The Activity and Trash
 * sections read their lists only while their own tab is open, so the other tabs never wait for them.
 */
export const load: PageServerLoad = async ({ params, parent, locals, url, depends }) => {
	depends('afb:settings');
	depends('afb:project');
	const { org, summary } = await parent();
	const tab = url.searchParams.get('tab');
	const sessionId = url.searchParams.get('session') || null;
	if (!summary)
		return {
			project: null,
			usage: [],
			canManage: false,
			canWrite: false,
			activity: null,
			activityFailed: false,
			pitfalls: null,
			pitfallsFailed: false,
			trash: null,
			sessionId
		};
	const ctx = await childContext(locals, org.id);
	const canManage = summary.caps.includes('manage');
	const project = await getProject(ctx, params.project);

	let activity: {
		events: Awaited<ReturnType<typeof listEvents>>;
		refs: Awaited<ReturnType<typeof refsFor>>;
	} | null = null;
	let trash: { list: TrashList | null; denied: { needed: string; role: string } | null } | null =
		null;

	let activityFailed = false;

	if (tab === 'activity') {
		// A read that fails shows the Try again card instead of the whole page failing
		try {
			const events = await listEvents(ctx, {
				project: params.project,
				sessionId: sessionId ?? undefined,
				limit: 100
			});
			const refs = await refsFor(
				ctx,
				params.project,
				events.flatMap((e) => (e.itemId ? [e.itemId] : []))
			);
			activity = { events, refs };
		} catch (e) {
			if (e instanceof OpError) throw e;
			activityFailed = true;
		}
	}
	// The known pitfalls are read only while their tab is open, like Activity and Trash (AFB-20261125-1527)
	let pitfalls: Awaited<ReturnType<typeof listPitfalls>> | null = null;
	let pitfallsFailed = false;
	if (tab === 'pitfalls') {
		try {
			pitfalls = await listPitfalls(ctx, params.project);
		} catch (e) {
			if (e instanceof OpError) throw e;
			pitfallsFailed = true;
		}
	}
	if (tab === 'trash') {
		try {
			trash = { list: await listTrash(ctx, params.project), denied: null };
		} catch (e) {
			if (e instanceof OpError) trash = { list: null, ...pageError(e) };
			else throw e;
		}
	}

	return {
		project: {
			id: project.id,
			logoV: project.logoV,
			key: project.key,
			name: project.name,
			streams: project.streams,
			themes: project.themes
		},
		// How many items sit under each stream and scope, as this person may see them (private and trashed items are not counted)
		usage: summary.areas.map((a) => ({ stream: a.stream, scope: a.scope, n: a.n })),
		canManage,
		// A member may add a pitfall; managing the rest of the page stays with admins and owners
		canWrite: summary.caps.includes('write'),
		activity,
		activityFailed,
		pitfalls,
		pitfallsFailed,
		trash,
		sessionId
	};
};
