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
	const filters = { q, stream, scope, status: wanted };
	if (!summary) return { view, filters, columns: [], areas: [], list: null };
	const ctx = await childContext(locals, org.id);
	const common = { project: params.project, q, stream, scope };

	if (view === 'board') {
		const columns = await Promise.all(
			BOARD_COLUMNS.filter((s) => !wanted.length || wanted.includes(s)).map(async (status) => {
				const page = await listItems(ctx, {
					...common,
					status: [status],
					sort: 'activity',
					limit: COLUMN_LIMIT
				});
				return { status, total: page.total ?? 0, items: page.items.map(slimItem) };
			})
		);
		return { view, filters, columns, areas: [], list: null };
	}
	if (view === 'areas') {
		const areas = await Promise.all(
			summary.areas.map(async (a) => {
				const page = await listItems(ctx, {
					project: params.project,
					q,
					stream: a.stream,
					scope: a.scope,
					status: wanted.length ? wanted : undefined,
					limit: AREA_LIMIT
				});
				return {
					stream: a.stream,
					scope: a.scope,
					total: page.total ?? 0,
					items: page.items.map(slimItem)
				};
			})
		);
		return { view, filters, columns: [], areas: areas.filter((a) => a.total > 0), list: null };
	}
	const page = await listItems(ctx, {
		...common,
		status: wanted.length ? wanted : undefined,
		sort: 'activity',
		limit: LIST_FIRST_PAGE
	});
	return {
		view,
		filters,
		columns: [],
		areas: [],
		list: { total: page.total ?? 0, items: page.items.map(slimItem), nextCursor: page.nextCursor }
	};
};
