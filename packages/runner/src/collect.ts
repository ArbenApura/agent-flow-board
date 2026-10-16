// OPENS PAGES READ ONLY, READS THEIR REAL SIZES AND TAKES PICTURES: THE CORE OF A UI SHOTS OR MEASURE RUN (SPEC 10.1, ADR-031)
// It knows nothing of the server. A run from the board hands it the rows of an item's table and stores pictures through the
// server; the local `yarn ui-shots` hands it the rows of tests/ui-shots/ui-changes.md and stores pictures in a folder. Either way
// every write the page tries is aborted, calls to other addresses are counted, and a state recipe only opens things.

// -- DEP-MODULES -- //
import type { Browser, Page } from '@playwright/test';
// -- MODULES -- //
import {
	DEFAULT_LOCATORS,
	shotFileName,
	type MeasuredLevels,
	type UiChangeRow
} from '../../../src/lib/shared/uiShots';
import type { Account } from './api';
import { signIn, type StorageState } from './signin';
import type { RunnerConfig } from './config';

// -- TYPES -- //

export type Row = Omit<UiChangeRow, 'accounts'> & { id: string; accounts: string };
export type ShotResult = {
	row?: string;
	page: string;
	state: string;
	theme: string;
	viewport: number;
	side: 'before' | 'after' | 'sibling';
	of?: string;
	values: MeasuredLevels;
	image?: string;
};
export type Collect = {
	browser: Browser;
	config: Pick<RunnerConfig, 'themes' | 'signIn'>;
	afterUrl: string;
	beforeUrl: string | null;
	accounts: Record<string, Account>;
	/** Keeps a picture and returns the id the result points at. */
	store: (file: { filename: string; caption: string; bytes: Buffer }) => Promise<string>;
	/** Lets a local run open a page that is a file and not an address of the app. */
	resolvePage?: (page: string) => string | null;
	log?: (line: string) => void;
};

// -- CONSTANTS -- //

const MAX_HEIGHT = 4000;
const GOTO_TIMEOUT = 30_000;

// -- FUNCTIONS -- //

/** True when an address is on exactly this origin (https://app.com.evil.net is not on https://app.com). */
function sameOrigin(address: string, origin: string): boolean {
	try {
		return new URL(address).origin === origin;
	} catch {
		return false;
	}
}

/** Reads the first visible element of each level the row lists, in the page's own computed style. */
async function measure(page: Page, levels: string[]): Promise<MeasuredLevels> {
	const specs = levels.map((l) => ({
		name: l.split('=')[0],
		selector: l.split('=')[1]?.startsWith('css:')
			? l.split('=')[1].slice(4)
			: DEFAULT_LOCATORS[l.split('=')[0]]
	}));
	return page.evaluate((specs) => {
		const out: Record<string, unknown> = {};
		for (const { name, selector } of specs) {
			const el = selector
				? [...document.querySelectorAll(selector)].find((e) => e.getBoundingClientRect().width > 0)
				: null;
			if (!el) {
				out[name] = null;
				continue;
			}
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			out[name] = {
				fontSize: parseFloat(cs.fontSize),
				fontWeight: Number(cs.fontWeight),
				// The computed style, not the box, so a spinning icon measures its real size
				height: Math.round((parseFloat(cs.height) || r.height) * 10) / 10,
				width: Math.round((parseFloat(cs.width) || r.width) * 10) / 10,
				radius: parseFloat(cs.borderTopLeftRadius) || 0
			};
		}
		return out;
	}, specs) as Promise<MeasuredLevels>;
}

/** One session of pages: signs in once per account and address, and keeps the counts of what it blocked. */
export class Shooter {
	readonly aborted = { writes: 0, outside: 0 };
	private states = new Map<string, StorageState | undefined>();
	private images = new Map<string, string>();

	constructor(private readonly c: Collect) {}

	private async stateFor(account: string, baseUrl: string): Promise<StorageState | undefined> {
		if (account === 'none') return undefined;
		const accounts = this.c.accounts;
		const name = accounts[account]
			? account
			: account === 'default'
				? Object.keys(accounts)[0]
				: undefined;
		if (!name) throw new Error(`The test account "${account}" is not saved for this project.`);
		const key = `${name}|${baseUrl}`;
		if (!this.states.has(key))
			this.states.set(
				key,
				await signIn(this.c.browser, baseUrl, accounts[name], this.c.config.signIn)
			);
		return this.states.get(key);
	}

	/** Opens one page in one theme and width, applies the state recipe, and returns its measure and its picture. */
	async shoot(o: {
		baseUrl: string;
		page: string;
		recipe: string;
		theme: string;
		viewport: number;
		account: string;
		levels: string[];
		caption: string;
		side: string;
		picture?: boolean;
	}) {
		const { config, browser, store } = this.c;
		const ctx = await browser.newContext({
			baseURL: o.baseUrl,
			viewport: { width: o.viewport, height: 900 },
			storageState: await this.stateFor(o.account, o.baseUrl)
		});
		try {
			const origin = new URL(o.baseUrl).origin;
			// Every write is aborted so a shots run cannot submit anything, and other addresses are counted
			await ctx.route('**/*', (route) => {
				const req = route.request();
				if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
					this.aborted.writes++;
					// A form that submits a page would leave this page for an error page, so it is answered with nothing
					// instead and the page stays put. Either way the write never reaches the server.
					return req.resourceType() === 'document'
						? route.fulfill({ status: 204, body: '' })
						: route.abort();
				}
				const u = req.url();
				if (!u.startsWith('data:') && !u.startsWith('blob:') && !sameOrigin(u, origin))
					this.aborted.outside++;
				return route.continue();
			});
			const page = await ctx.newPage();
			await page.emulateMedia({ colorScheme: o.theme === 'dark' ? 'dark' : 'light' });
			await page.addInitScript(
				({ theme, keys, attrs }) => {
					try {
						for (const k of keys) localStorage.setItem(k, theme);
					} catch {
						/* No storage */
					}
					for (const a of attrs) document.documentElement.setAttribute(a, theme);
				},
				{ theme: o.theme, keys: config.themes.storageKeys, attrs: config.themes.attributes }
			);
			await page.goto(this.c.resolvePage?.(o.page) ?? o.page, {
				waitUntil: 'load',
				timeout: GOTO_TIMEOUT
			});
			await page.evaluate(
				({ theme, attrs }) => {
					for (const a of attrs) document.documentElement.setAttribute(a, theme);
				},
				{ theme: o.theme, attrs: config.themes.attributes }
			);
			for (const step of o.recipe ? o.recipe.split(' > ') : []) {
				const i = step.indexOf(':');
				const kind = step.slice(0, i);
				const target = step.slice(i + 1);
				if (kind === 'click')
					await page.locator(target).first().click({ timeout: 5000, noWaitAfter: true });
				else if (kind === 'wait') await page.locator(target).first().waitFor({ timeout: 5000 });
				else if (kind === 'scroll') await page.locator(target).first().scrollIntoViewIfNeeded();
			}
			const values = await measure(page, o.levels);
			const cacheKey = [o.baseUrl, o.page, o.recipe, o.theme, o.viewport, o.account].join('|');
			let image = this.images.get(cacheKey);
			if (!image && o.picture !== false) {
				const height = await page.evaluate(() => document.documentElement.scrollHeight);
				const bytes = await page.screenshot({
					type: 'jpeg',
					quality: 60,
					fullPage: true,
					...(height > MAX_HEIGHT
						? { clip: { x: 0, y: 0, width: o.viewport, height: MAX_HEIGHT } }
						: {})
				});
				image = await store({
					filename: shotFileName({
						page: o.page,
						state: o.recipe,
						theme: o.theme,
						viewport: o.viewport,
						side: o.side
					}),
					caption: o.caption,
					bytes
				});
				this.images.set(cacheKey, image);
			}
			return { values, image };
		} finally {
			await ctx.close();
		}
	}

	/** Every row of an item's table: after, before (when there is a deployed site) and each sibling. */
	async rows(rows: Row[]): Promise<ShotResult[]> {
		const results: ShotResult[] = [];
		for (const row of rows) {
			for (const theme of row.themes)
				for (const viewport of row.viewports) {
					const common = {
						recipe: row.stateRecipe,
						theme,
						viewport,
						account: row.accounts,
						levels: row.levels
					};
					const after = await this.shoot({
						...common,
						baseUrl: this.c.afterUrl,
						page: row.page,
						caption: `After: ${row.page}, ${theme}, ${viewport}`,
						side: 'after'
					});
					results.push({
						row: row.id,
						page: row.page,
						state: row.stateRecipe,
						theme,
						viewport,
						side: 'after',
						values: after.values,
						image: after.image
					});
					if (this.c.beforeUrl) {
						try {
							const before = await this.shoot({
								...common,
								baseUrl: this.c.beforeUrl,
								page: row.page,
								caption: `Before: ${row.page}, ${theme}, ${viewport}`,
								side: 'before'
							});
							results.push({
								row: row.id,
								page: row.page,
								state: row.stateRecipe,
								theme,
								viewport,
								side: 'before',
								values: before.values,
								image: before.image
							});
						} catch (e) {
							// A page that is new has no before: say so and go on
							this.c.log?.(`  No before for ${row.page}: ${(e as Error).message.split('\n')[0]}`);
						}
					}
					for (const sibling of row.siblings) {
						const sib = await this.shoot({
							...common,
							recipe: '',
							baseUrl: this.c.afterUrl,
							page: sibling,
							caption: `Sibling: ${sibling}, ${theme}, ${viewport}`,
							side: 'sibling'
						});
						results.push({
							row: row.id,
							page: sibling,
							state: '',
							theme,
							viewport,
							side: 'sibling',
							of: row.page,
							values: sib.values,
							image: sib.image
						});
					}
				}
		}
		return results;
	}

	/** The reference pages of a measure job: every level's default locator, no pictures. */
	async reference(o: { pages: string[]; themes: string[]; levels: string[]; account: string }) {
		const results: ShotResult[] = [];
		for (const theme of o.themes)
			for (const viewport of [1440, 390])
				for (const page of o.pages) {
					const { values } = await this.shoot({
						baseUrl: this.c.afterUrl,
						page,
						recipe: '',
						theme,
						viewport,
						account: o.account,
						levels: o.levels,
						caption: 'Reference',
						side: 'reference',
						picture: false
					});
					results.push({ page, state: '', theme, viewport, side: 'after', values });
				}
		return results;
	}
}
