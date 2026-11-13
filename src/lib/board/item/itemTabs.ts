// THE TABS OF AN ITEM, SHARED BY THE ITEM PAGE AND THE TOP BAR OF THE LAYOUT (AFB-20261112-2350)
// One list, one set of labels and one place that reads the counts from the page data, so the card under the top bar and the tabs
// in the top bar can never drift apart.

// -- CONSTANTS -- //

/** The route of an item. The layout shows the tabs in the top bar only here. */
export const ITEM_ROUTE = '/[org]/[project]/[item]';

export const ITEM_TABS = [
	'plan',
	'decisions',
	'docs',
	'mockups',
	'checks',
	'activity',
	'files',
	'discussion'
] as const;

export type ItemTab = (typeof ITEM_TABS)[number];
export type ItemTabCounts = Partial<Record<ItemTab, number>>;
/** What the tabs need to draw: which ones, how many things each holds, and which is open. */
export type ItemTabsView = { tabs: ItemTab[]; counts: ItemTabCounts; active: ItemTab };

export const ITEM_TAB_LABEL: Record<ItemTab, string> = {
	plan: 'Plan',
	decisions: 'Decisions',
	docs: 'Documents',
	mockups: 'Mockups',
	checks: 'Checks',
	activity: 'Activity',
	files: 'Files',
	discussion: 'Discussion'
};

// -- FUNCTIONS -- //

/** The tab named in the address, or the plan when there is none or it is not one of ours. */
export function parseItemTab(value: string | null | undefined): ItemTab {
	return (ITEM_TABS as readonly string[]).includes(value ?? '') ? (value as ItemTab) : 'plan';
}

/** The address of a tab: the plan is the page itself, every other tab is a query on it. */
export const itemTabHref = (pathname: string, tab: ItemTab): string =>
	tab === 'plan' ? pathname : `${pathname}?tab=${tab}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

const length = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/**
 * The tabs for the page on show, or null. It is null on any route that is not an item, and on an item that did not load (the
 * person may not see it, or it does not exist), so a layout never draws tabs for a page that has none. The mockup page returns a
 * `detail` too, which is why the route is checked and not only the data.
 */
export function itemTabsFrom(
	routeId: string | null | undefined,
	data: unknown,
	// The read only search parameters of the page are passed as they are, so only `get` is asked of them
	params: { get(name: string): string | null }
): ItemTabsView | null {
	if (routeId !== ITEM_ROUTE || !isRecord(data) || !isRecord(data.detail)) return null;
	const detail = data.detail;
	const item = isRecord(detail.item) ? detail.item : null;
	if (!item) return null;
	const project = isRecord(detail.project) ? detail.project : null;
	const mockups = isRecord(data.mockups) ? data.mockups : null;
	return {
		// The Checks tab is only for a project that is a web app
		tabs: ITEM_TABS.filter((t) => t !== 'checks' || !!project?.webApp),
		counts: {
			plan: typeof item.totalSteps === 'number' ? item.totalSteps : 0,
			decisions: length(detail.decisions),
			docs: length(detail.sections),
			mockups: length(mockups?.list)
		},
		active: parseItemTab(params.get('tab'))
	};
}
