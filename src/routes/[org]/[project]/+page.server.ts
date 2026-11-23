// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
import type { Status } from '#lib/board/status.js';
// IMPORTED MODULES
import { slimItem } from '#lib/board/rows.js';
import { BOARD_COLUMNS, STATUSES, VIEWS, type View } from '#lib/board/status.js';
import { listItems } from '#lib/server/ops/items.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- CONSTANTS -- //

const COLUMN_LIMIT = 12;
const AREA_LIMIT = 5;
const LIST_FIRST_PAGE = 100;
/** The Completed column shows plans changed in this many days, then a Show older button. */
const COMPLETED_DAYS = 14;

// -- FUNCTIONS -- //

/** The registry in one of its three views. Only the first screenful of each is sent; the list loads the rest as it scrolls. */
export const load: PageServerLoad = async ({ params, parent, locals, url, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	const view: View = (VIEWS as readonly string[]).includes(url.searchParams.get('view') ?? '')
		? (url.searchParams.get('view') as View)
		: 'board';
	const q = url.searchParams.get('q')?.trim() || undefined;
	const stream = url.searchParams.get('stream') || undefined;
	const scope = url.searchParams.get('scope') || undefined;
	const wanted = (url.searchParams.get('status') ?? '')
		.split(',')
		.filter((s): s is Status => (STATUSES as string[]).includes(s));
	// Who made the plan (me, others or user ids), who it is assigned to, and whose review it waits for
	const by = url.searchParams.get('by')?.trim().slice(0, 1000) || undefined;
	const assignee = url.searchParams.get('assignee')?.trim().slice(0, 100) || undefined;
	const reviewer = url.searchParams.get('reviewer')?.trim().slice(0, 100) || undefined;
	// Child plans are folded into their master on the board and in Areas, and listed one by one in the List. The address can say either
	const asked = url.searchParams.get('children');
	const children: 'show' | 'hide' =
		asked === 'show' || asked === 'hide' ? asked : view === 'list' ? 'show' : 'hide';
	const older = url.searchParams.get('older') === '1';
	const filters = { q, stream, scope, by, assignee, reviewer, status: wanted, children, older };
	if (!summary) return { view, filters, columns: [], areas: [], list: null, foldedChildren: 0 };
	const ctx = await childContext(locals, org.id);
	const common = { project: params.project, q, stream, scope, by, assignee, reviewer };

	if (view === 'board') {
		const statuses = BOARD_COLUMNS.filter((s) => !wanted.length || wanted.includes(s));
		// A search or a filter finds a plan whatever its age, so only the plain board keeps Completed to the last days
		const plain = !q && !stream && !scope && !by && !assignee && !reviewer;
		const cutoff =
			plain && !older ? new Date(Date.now() - COMPLETED_DAYS * 24 * 60 * 60 * 1000) : undefined;
		const columns = await Promise.all(
			statuses.map(async (status) => {
				const base = {
					...common,
					status: [status],
					sort: 'activity' as const,
					limit: COLUMN_LIMIT,
					children,
					family: true
				};
				const recentOnly = status === 'COMPLETED' && cutoff;
				const page = await listItems(ctx, recentOnly ? { ...base, changedSince: cutoff } : base);
				let total = page.total ?? 0;
				let olderCount = 0;
				if (recentOnly) {
					// The column heading counts every completed plan, and the button says how many are older than the cutoff
					const all = await listItems(ctx, { ...base, limit: 1, family: false });
					total = all.total ?? total;
					olderCount = Math.max(0, total - (page.total ?? 0));
				}
				return {
					status,
					total,
					older: olderCount,
					items: page.items.map((i) => slimItem(i, page.family))
				};
			})
		);
		// How many child plans the folding hides, for the line above the board
		let foldedChildren = 0;
		if (children === 'hide') {
			const everything = await listItems(ctx, {
				...common,
				status: statuses,
				children: 'show',
				limit: 1
			});
			foldedChildren = Math.max(
				0,
				(everything.total ?? 0) - columns.reduce((sum, c) => sum + c.total, 0)
			);
		}
		return { view, filters, columns, areas: [], list: null, foldedChildren };
	}
	if (view === 'areas') {
		const areas = await Promise.all(
			summary.areas.map(async (a) => {
				const page = await listItems(ctx, {
					project: params.project,
					q,
					stream: a.stream,
					scope: a.scope,
					by,
					assignee,
					reviewer,
					status: wanted.length ? wanted : undefined,
					limit: AREA_LIMIT,
					children,
					family: true
				});
				return {
					stream: a.stream,
					scope: a.scope,
					total: page.total ?? 0,
					items: page.items.map((i) => slimItem(i, page.family))
				};
			})
		);
		return {
			view,
			filters,
			columns: [],
			areas: areas.filter((a) => a.total > 0),
			list: null,
			foldedChildren: 0
		};
	}
	const page = await listItems(ctx, {
		...common,
		status: wanted.length ? wanted : undefined,
		sort: 'activity',
		limit: LIST_FIRST_PAGE,
		children,
		family: true
	});
	return {
		view,
		filters,
		columns: [],
		areas: [],
		list: {
			total: page.total ?? 0,
			items: page.items.map((i) => slimItem(i, page.family)),
			nextCursor: page.nextCursor
		},
		foldedChildren: 0
	};
};
