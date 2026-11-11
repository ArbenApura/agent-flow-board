// M6: the registry, item page, tasks and activity work at desktop and phone widths with their empty, error and
// permission-denied states, undo restores a deleted item from the trash, a change appears on another open page within
// 1 second, and a page that reconnects after a drop shows the missed change.
// M7: the performance budgets hold on the 5,000 item load project (first load JavaScript, page response, registry open
// and scroll). Runs against the build preview.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { signIn } from './helpers';

const ACME = '/api/v1/orgs/acme';
const budgets = JSON.parse(
	readFileSync(resolve(import.meta.dirname, '..', 'perf', 'budgets.json'), 'utf8')
) as {
	firstLoadJsGzipKb: number;
	pageResponseP95Ms: number;
	registry5000OpenMs: number;
	liveChangeMs: number;
};

/** Signs in as a seeded person in their own browser context. */
async function as(
	browser: Browser,
	baseURL: string,
	email: string,
	viewport?: { width: number; height: number }
) {
	const ctx = await browser.newContext({ baseURL, viewport });
	const page = await ctx.newPage();
	await signIn(page, email);
	return { ctx, page };
}

/** An item the check owns, so it never depends on or disturbs the seeded ones. */
async function makeItem(page: Page, title: string, project = 'CKT') {
	const res = await page.request.post(`${ACME}/projects/${project}/items`, {
		data: {
			title,
			phases: [
				{ key: '1', title: 'Build', steps: [{ text: 'First step' }, { text: 'Second step' }] }
			]
		}
	});
	expect(res.status()).toBe(200);
	return (await res.json()) as { ref: string; id: string };
}

test('M6 the registry shows the board, areas and list, filters, and the project cards', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example');
	await page.goto('/acme');
	await expect(page.getByTestId('page-title')).toHaveText('Projects');
	await expect(
		page.getByTestId('project-cards').getByRole('link', { name: /Checkout rebuild/ })
	).toBeVisible();
	await page.getByRole('link', { name: /Checkout rebuild/ }).click();
	await expect(page.getByTestId('page-title')).toHaveText('Checkout rebuild');
	// Board: six columns, the seeded items sit in their status
	await expect(page.getByTestId('board-columns').getByTestId('item-card').first()).toBeVisible();
	await expect(page.getByRole('region', { name: 'in progress' })).toContainText(
		'Saved cards at checkout'
	);
	// Areas and list are views of the same items
	await page.getByRole('radio', { name: 'List' }).click();
	await expect(page).toHaveURL(/view=list/);
	await expect(page.getByTestId('item-row').first()).toBeVisible();
	await page.getByTestId('filter-q').fill('promo');
	await expect(page.getByTestId('item-row')).toHaveCount(1);
	await expect(page.getByTestId('item-row')).toContainText('Promo codes');
	await page.getByTestId('filter-q').fill('no such thing anywhere');
	await expect(page.getByText('No items match')).toBeVisible();
	await page.getByTestId('filter-q').fill('');
	await page.getByRole('radio', { name: 'Areas' }).click();
	await expect(page.getByTestId('area-groups')).toBeVisible();
	await expect(page.getByRole('region', { name: /features core/ })).toBeVisible();
	// A status chip narrows the list
	await page.goto('/acme/CKT?view=list');
	await page.getByTestId('filters-button').click();
	await page.getByRole('checkbox', { name: /^in review/ }).click();
	await expect(page.getByTestId('item-row')).toHaveCount(1);
	await ctx.close();
});

test('M6 the item page: a step tick updates at once and moves the status, and the tabs hold the rest', async ({
	browser,
	baseURL
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const made = await makeItem(owner.page, 'Board check item one');
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example');
	await page.goto(`/acme/CKT/${made.ref}`);
	await expect(page.getByTestId('page-title')).toHaveText('Board check item one');
	await expect(page.getByTestId('item-status')).toContainText(/planned/i);
	// The first done step moves it to in progress by itself
	await page.getByRole('checkbox', { name: /1\.1 First step/ }).click();
	await expect(page.getByRole('checkbox', { name: /1\.1 First step/ })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await expect(page.getByTestId('item-status')).toContainText(/in progress/i);
	await expect(page.getByTestId('item-percent')).toContainText('50%');
	// The last one moves it to in review
	await page.getByRole('checkbox', { name: /1\.2 Second step/ }).click();
	await expect(page.getByTestId('item-status')).toContainText(/in review/i);
	await expect(page.getByTestId('item-percent')).toContainText('100%');
	// Reopening a step never moves the status back by itself; the page warns instead
	await page.getByRole('checkbox', { name: /1\.2 Second step/ }).click();
	await expect(page.getByTestId('drift')).toContainText('in review but a step is open');
	await expect(page.getByTestId('item-status')).toContainText(/in review/i);
	await page.getByTestId('change-status').click();
	await page.getByRole('menuitemradio', { name: 'in progress' }).click();
	await expect(page.getByTestId('item-status')).toContainText(/in progress/i);
	await expect(page.getByTestId('drift')).toHaveCount(0);
	// Add a step, waive it with a reason
	await page.getByRole('button', { name: 'Add a step' }).click();
	await page.getByTestId('new-step-text').fill('A third step');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('checkbox', { name: /1\.3 A third step/ })).toBeVisible();
	await page
		.getByRole('listitem')
		.filter({ hasText: 'A third step' })
		.getByRole('button', { name: 'Waive' })
		.click();
	await page.getByTestId('waive-reason').fill('Not needed after all');
	await page.getByTestId('waive-submit').click();
	await expect(page.getByRole('listitem').filter({ hasText: 'A third step' })).toContainText(
		'waived, Not needed after all'
	);
	// Settled without asking, documents, discussion and activity
	await page.getByTestId('tab-decisions').click();
	await page.getByTestId('add-decision').click();
	await page.getByRole('radio', { name: 'Settled without asking' }).click();
	await page.getByLabel('The question that was settled').fill('Which colour');
	await page.getByLabel('The answer', { exact: true }).fill('Graphite');
	await page.getByLabel('Where the answer came from').fill('design/tokens.md');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByTestId('settled-list')).toContainText('Which colour');
	await expect(page.getByTestId('settled-list')).toContainText('Graphite');
	await page.getByTestId('tab-docs').click();
	await page.getByTestId('add-section').click();
	await page.getByLabel('Section title').fill('Spec');
	await page
		.getByTestId('section-body')
		.fill('# Heading\n\nSome **bold** words and <script>alert(1)</script>.');
	await page.getByTestId('section-save').click();
	const doc = page.getByTestId('docs-tab');
	await expect(doc.locator('strong')).toHaveText('bold');
	await expect(doc.locator('script')).toHaveCount(0);
	await page.getByTestId('tab-discussion').click();
	await page.getByTestId('comment-text').fill('Looks right to me');
	await page.getByTestId('comment-submit').click();
	await expect(page.getByTestId('comment')).toContainText('Looks right to me');
	await expect(page.getByTestId('comment')).toContainText('Maria Member');
	await page.getByTestId('tab-activity').click();
	await expect(page.getByTestId('event').first()).toBeVisible();
	await expect(page.getByTestId('event-list')).toContainText('created the item');
	await ctx.close();
	await owner.ctx.close();
});

test('M6 undo restores a deleted item from the trash and from the activity log', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example');
	const made = await makeItem(page, 'Board check item to delete');
	await page.goto(`/acme/CKT/${made.ref}`);
	await page.getByRole('button', { name: 'Item actions' }).click();
	await page.getByRole('menuitem', { name: 'Move to trash' }).click();
	await page.getByRole('button', { name: 'Move to trash' }).click();
	await expect(page).toHaveURL(/\/acme\/CKT$/);
	// It is in the trash, with days left, and restoring brings it back
	await page.goto('/acme/CKT/trash');
	const row = page.getByTestId('trash-items').getByRole('listitem').filter({ hasText: made.ref });
	await expect(row).toContainText('30 days left');
	await row.getByTestId('restore').click();
	await expect(page.getByTestId('trash-items')).toHaveCount(0);
	await page.goto(`/acme/CKT/${made.ref}`);
	await expect(page.getByTestId('page-title')).toHaveText('Board check item to delete');
	// Delete again and undo from the activity log instead
	await page.request.delete(`${ACME}/items/${made.ref}`);
	await page.goto('/acme/CKT/activity');
	await page
		.locator('[data-testid="event"][data-verb="item.delete"]')
		.first()
		.getByTestId('undo')
		.click();
	await expect(page.getByText('Undone.', { exact: true })).toBeVisible();
	expect((await page.request.get(`${ACME}/items/${made.ref}`)).status()).toBe(200);
	await ctx.close();
});

test('M6 tasks: add one, change its status, and the empty state shows first', async ({
	browser,
	baseURL
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const key = `T${Date.now().toString(36).toUpperCase().slice(-6)}`;
	expect(
		(
			await owner.page.request.post(`${ACME}/projects`, { data: { key, name: `Empty ${key}` } })
		).status()
	).toBe(200);
	// An empty project shows what to do first, on the registry and on tasks
	await owner.page.goto(`/acme/${key}`);
	await expect(owner.page.getByText('No items in this project yet')).toBeVisible();
	await owner.page.goto(`/acme/${key}/tasks`);
	await expect(owner.page.getByText('No tasks yet')).toBeVisible();
	// New task hands over to the agent, so the task is made through the API as the agent's tool does
	expect(
		(
			await owner.page.request.post(`${ACME}/projects/${key}/tasks`, {
				data: { title: 'Write the launch note' }
			})
		).status()
	).toBe(200);
	await owner.page.reload();
	await expect(owner.page.getByTestId('task')).toContainText('Write the launch note');
	await expect(owner.page.getByTestId('task')).toContainText('T-1');
	await owner.page.getByRole('button', { name: /Status of T-1/ }).click();
	await owner.page.getByRole('option', { name: 'done' }).click();
	await expect(owner.page.getByTestId('task').locator('span.line-through')).toBeVisible();
	await owner.ctx.close();
});

test('M6 permission denied is a panel that names the role, and a viewer sees no write controls', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'viewer@acme.example');
	await page.goto('/acme/CKT/trash');
	await expect(page.getByRole('alert')).toContainText('You cannot open the trash');
	await expect(page.getByRole('alert')).toContainText('Member');
	await expect(page.getByRole('alert')).toContainText('Viewer');
	await page.goto('/acme/CKT');
	await expect(page.getByTestId('new-item')).toHaveCount(0);
	await page.goto('/acme/CKT/CKT-1');
	await expect(page.getByTestId('page-title')).toBeVisible();
	await expect(page.getByTestId('change-status')).toHaveCount(0);
	await expect(page.getByRole('checkbox', { name: /1\.1/ })).toBeDisabled();
	// A viewer can still comment
	await page.getByTestId('tab-discussion').click();
	await expect(page.getByTestId('comment-text')).toBeVisible();
	await ctx.close();
});

test('M6 an error loading the next page of the list is shown with its message, not a blank list', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example');
	await page.route(/\/api\/v1\/orgs\/acme\/projects\/LOAD\/items\?.*cursor/, (r) => r.abort());
	await page.goto('/acme/LOAD?view=list');
	await expect(page.getByTestId('item-row').first()).toBeVisible();
	await page.getByRole('list', { name: /items/ }).evaluate((el) => (el.scrollTop = 4000));
	await expect(page.getByRole('alert')).toContainText(/did not load|could not/i);
	await ctx.close();
});

test('M6 the pages work on a phone: no sideways scroll, a menu drawer, big tap targets', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example', {
		width: 390,
		height: 800
	});
	for (const path of [
		'/acme',
		'/acme/CKT',
		'/acme/CKT?view=list',
		'/acme/CKT/CKT-1',
		'/acme/CKT/tasks',
		'/acme/CKT/activity'
	]) {
		await page.goto(path);
		await expect(page.getByTestId('page-title')).toBeVisible();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
		expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
	}
	await page.goto('/acme/CKT');
	await page.getByTestId('menu-button').click();
	const drawer = page.getByRole('dialog', { name: 'Menu' });
	await expect(drawer.getByRole('link', { name: /Checkout rebuild/ })).toBeVisible();
	await drawer.getByRole('link', { name: 'Tasks' }).click();
	await expect(page).toHaveURL(/\/acme\/CKT\/tasks/);
	// Every step checkbox keeps a 44 px tap area
	await page.goto('/acme/CKT/CKT-1');
	const box = await page.getByRole('checkbox', { name: /1\.1/ }).evaluate((el) => {
		const r = el.getBoundingClientRect();
		const after = getComputedStyle(el, '::before');
		return {
			w: r.width + 2 * Math.abs(parseFloat(after.left)),
			h: r.height + 2 * Math.abs(parseFloat(after.top))
		};
	});
	expect(box.w).toBeGreaterThanOrEqual(44);
	expect(box.h).toBeGreaterThanOrEqual(44);
	await ctx.close();
});

test('M6 a change shows on another open page within 1 second, and a page that was cut off shows what it missed', async ({
	browser,
	baseURL
}) => {
	const a = await as(browser, baseURL!, 'owner@acme.example');
	const made = await makeItem(a.page, 'Board check live item');
	// Page B watches the registry list of the same project
	const b = await as(browser, baseURL!, 'member@acme.example');
	await b.page.goto('/acme/CKT?view=list&q=Board%20check%20live');
	await expect(b.page.getByTestId('item-row')).toContainText('planned');
	// The stream is open before the change is made
	await b.page.waitForTimeout(500);
	const started = Date.now();
	await a.page.request.post(`${ACME}/items/${made.ref}/status`, {
		data: { status: 'ON HOLD', note: 'Waiting on a decision' }
	});
	await expect(b.page.getByTestId('item-row')).toContainText('on hold', {
		timeout: budgets.liveChangeMs
	});
	expect(Date.now() - started).toBeLessThan(budgets.liveChangeMs + 500);

	// Page C loads while its stream is cut, so it shows the banner; the change made meanwhile appears once it reconnects
	const c = await as(browser, baseURL!, 'member@acme.example');
	await c.page.route('**/acme/CKT/stream', (r) => r.abort());
	await c.page.goto('/acme/CKT?view=list&q=Board%20check%20live');
	await expect(c.page.getByTestId('item-row')).toContainText('on hold');
	await expect(c.page.getByText(/Live updates paused/)).toBeVisible();
	await a.page.request.post(`${ACME}/items/${made.ref}/status`, {
		data: { status: 'IN PROGRESS', note: 'Back to work' }
	});
	await c.page.unroute('**/acme/CKT/stream');
	await expect(c.page.getByTestId('item-row')).toContainText('in progress', { timeout: 10_000 });
	await expect(c.page.getByText(/Live updates paused/)).toHaveCount(0);
	await a.ctx.close();
	await b.ctx.close();
	await c.ctx.close();
});

test('M6 a running agent session shows as a Running badge that follows the claim, live', async ({
	browser,
	baseURL,
	request
}) => {
	const a = await as(browser, baseURL!, 'owner@acme.example');
	const made = await makeItem(a.page, 'Board check running item');
	const minted = await (
		await a.page.request.post(`${ACME}/tokens`, {
			data: { name: 'claude-code', permissions: ['read', 'write'] }
		})
	).json();
	const watcher = await as(browser, baseURL!, 'member@acme.example');
	await watcher.page.goto(`/acme/CKT/${made.ref}`);
	await expect(watcher.page.getByText(/Running/)).toHaveCount(0);
	await watcher.page.waitForTimeout(500);
	const call = async (name: string, args: Record<string, unknown>) => {
		const res = await request.post('/mcp', {
			data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
			headers: {
				authorization: `Bearer ${minted.token}`,
				accept: 'application/json, text/event-stream'
			}
		});
		const r = await res.json();
		return r.result.structuredContent ?? JSON.parse(r.result.content[0].text);
	};
	const s = await call('session_start', { tool: 'Claude Code' });
	await call('work_start', { sessionId: s.sessionId, item: made.ref, phase: '1' });
	await expect(watcher.page.getByText(/Phase 1, Claude Code/).first()).toBeVisible({
		timeout: 2000
	});
	await watcher.page.goto('/acme/CKT');
	await expect(watcher.page.getByTestId('running-now')).toContainText(made.ref);
	await call('work_stop', { sessionId: s.sessionId });
	// Other sessions of other checks may still be running, so only this item's badge must be gone
	await expect(watcher.page.getByTestId('running-now').filter({ hasText: made.ref })).toHaveCount(
		0,
		{ timeout: 2000 }
	);
	await a.ctx.close();
	await watcher.ctx.close();
});

test('M6 search finds items and documents, and never shows a private item to someone who may not see it', async ({
	browser,
	baseURL
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const word = `zebra${Date.now().toString(36)}`;
	const secret = await owner.page.request.post(`${ACME}/projects/CKT/items`, {
		data: { title: `Private ${word} plan`, visibility: 'private', phases: [] }
	});
	expect(secret.status()).toBe(200);
	await owner.page.goto(`/acme/search?q=${word}`);
	await expect(owner.page.getByTestId('search-hit')).toContainText(`Private ${word} plan`);
	const member = await as(browser, baseURL!, 'member@acme.example');
	await member.page.goto('/acme/search');
	await member.page.getByTestId('search-q').fill(word);
	await member.page.getByTestId('search-submit').click();
	await expect(member.page.getByText('Nothing found')).toBeVisible();
	await member.page.goto('/acme/search?q=promo');
	await expect(member.page.getByTestId('search-hit').first()).toContainText('Promo codes');
	await owner.ctx.close();
	await member.ctx.close();
});

// -- M7 -- //

test('M7 the 5,000 item registry opens inside the budget and scrolls to the end with a small DOM', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example');
	// A first visit warms the server, the measured one is what a returning person sees
	await page.goto('/acme/LOAD?view=list');
	await expect(page.getByTestId('item-row').first()).toBeVisible();
	const started = Date.now();
	await page.goto('/acme/LOAD?view=list');
	await expect(page.getByTestId('list-count')).toContainText('5,000 items');
	await expect(page.getByTestId('item-row').first()).toBeVisible();
	expect(Date.now() - started, 'registry open time').toBeLessThan(budgets.registry5000OpenMs);
	const list = page.getByRole('list', { name: '5,000 items' });
	expect(await page.getByTestId('item-row').count()).toBeLessThan(60);
	// Dragging to the very end loads the pages in between and shows the oldest item
	await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
	await expect(
		page.getByTestId('item-row').filter({ hasText: 'Load item number 1' }).first()
	).toBeVisible({
		timeout: 15_000
	});
	expect(await page.getByTestId('item-row').count()).toBeLessThan(60);
	await ctx.close();
});

test('M7 first load JavaScript and the server response of the board pages stay inside the budgets', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example');
	// The pages of a project, the ones added since (checks, UI shots, settings) and the pages of the 5,000 item project
	const PAGES = [
		'/acme',
		'/acme/CKT',
		'/acme/CKT?view=list',
		'/acme/CKT/CKT-1',
		'/acme/CKT/CKT-1?tab=checks',
		'/acme/CKT/CKT-1?tab=ui',
		'/acme/CKT/tasks',
		'/acme/CKT/activity',
		'/acme/CKT/ui',
		'/acme/CKT/settings',
		'/acme/settings',
		'/acme/LOAD',
		'/acme/LOAD?view=areas',
		'/acme/LOAD/tasks',
		'/acme/LOAD/activity',
		'/acme/LOAD/ui'
	];
	for (const path of PAGES) {
		const times: number[] = [];
		let html = '';
		await page.request.get(path);
		for (let i = 0; i < 15; i++) {
			const res = await page.request.get(path);
			html = await res.text();
			const timing = res.headers()['server-timing'] ?? '';
			times.push(Number(/total;dur=([\d.]+)/.exec(timing)?.[1] ?? Number.NaN));
		}
		times.sort((x, y) => x - y);
		const p95 = times[Math.ceil(times.length * 0.95) - 1];
		expect(p95, `${path} server response p95`).toBeLessThan(budgets.pageResponseP95Ms);
		// The scripts the page asks for on first load
		const urls = new Set<string>();
		for (const m of html.matchAll(/(?:href|src)="([^"]+\.js)"/g)) urls.add(m[1]);
		for (const m of html.matchAll(/import\(\s*"([^"]+\.js)"/g)) urls.add(m[1]);
		let bytes = 0;
		for (const u of urls) {
			const res = await page.request.get(new URL(u, baseURL! + path).toString());
			bytes += gzipSync(Buffer.from(await res.body())).length;
		}
		expect(bytes / 1024, `${path} first load JS (gzip KB)`).toBeLessThan(budgets.firstLoadJsGzipKb);
	}
	await ctx.close();
});

test('M7 a REST read carries an ETag and a repeat with If-None-Match answers 304 with no body', async ({
	browser,
	baseURL
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'member@acme.example');
	const first = await page.request.get(`${ACME}/projects/CKT/items?limit=5`);
	expect(first.status()).toBe(200);
	const etag = first.headers()['etag'];
	expect(etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
	expect(first.headers()['cache-control']).toBe('private, no-cache');
	const again = await page.request.get(`${ACME}/projects/CKT/items?limit=5`, {
		headers: { 'if-none-match': etag }
	});
	expect(again.status()).toBe(304);
	expect((await again.body()).length).toBe(0);
	// A different answer has a different tag
	const other = await page.request.get(`${ACME}/projects/CKT/items?limit=1`);
	expect(other.headers()['etag']).not.toBe(etag);
	await ctx.close();
});
