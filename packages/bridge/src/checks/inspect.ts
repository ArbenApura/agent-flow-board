// DOM INSPECTION FOR HOSTED MOCKUPS AND APP TARGETS (STEP B.5, AFB-20261113-1008)
// Opens the target in a Chromium context (strictly zero storageState / zero writes for mockups), triggers the requested screen/state/width,
// waits until layout and fonts settle, and dumps { box, computed style whitelist, text } for every data-ref or paired app selector plus unlisted data-refs.

// -- TYPES -- //
import type { WriteRule } from './devPolicy.js';
import type { ElementPairSpec, InspectDump, InspectElementDump, StateDriver } from './pairing.js';
import type { Fetch } from '../device.js';
// -- MODULES -- //
import { ensureBrowser, loadPlaywright } from './browser.js';
import { acquireBrowser } from './browserpool.js';
import {
	DEV_READINESS_INIT_SCRIPT,
	type DevReadyPageLike,
	waitForDevReady
} from './devReadiness.js';
import { guardContext, guardDevContext, type ContextLike } from './guard.js';
import { parseMockupRef, resolveMockupTarget } from './mockupTarget.js';
import { applyStateDriverToUrl, INSPECT_STYLE_PROPERTIES } from './pairing.js';

// -- TYPES -- //

export type InspectPageLike = {
	evaluate<R, Arg = unknown>(fn: (arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R>;
	goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
	route?(
		url: string,
		handler: (route: {
			fulfill(opts: { status?: number; contentType?: string; body?: string }): Promise<void>;
		}) => Promise<void> | void
	): Promise<void>;
	waitForLoadState?(
		state?: 'load' | 'domcontentloaded' | 'networkidle',
		opts?: { timeout?: number }
	): Promise<void>;
	setViewportSize(size: { width: number; height: number }): Promise<void>;
	screenshot?(options?: Record<string, unknown>): Promise<Buffer>;
};

export type InspectUrlOptions = {
	url: string;
	target: 'mockup' | 'app';
	/** Optional expected origin; refuses off-origin navigation or host-resolver bypass. */
	expectedOrigin?: string;
	screen?: string;
	state?: string;
	width?: number;
	height?: number;
	driver?: StateDriver;
	/** Explicit element pairing specs; when omitted on mockup inspect, every [data-ref] on the page is collected. */
	pairs?: ElementPairSpec[];
	/** Saved browser state for authenticated app targets ONLY. Forbidden when target === 'mockup'. */
	storageState?: unknown;
	isDev?: boolean;
	dedicated?: boolean;
	allowWrites?: boolean;
	writeAllowlist?: WriteRule[];
	extraHosts?: string[];
	needles?: string[];
	headed?: boolean;
	/** Optional already-acquired browser websocket endpoint and capture option. */
	captureScreenshot?: boolean;
};

export type InspectUrlResult = {
	dump: InspectDump;
	screenshot?: Buffer;
	manualRequired: boolean;
};

// -- CONSTANTS -- //

const DEFAULT_SCREEN = '';
const DEFAULT_STATE = 'default';
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const FONT_READY_TIMEOUT_MS = 2_000;
const OP_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, label: string, ms = OP_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
				timer.unref?.();
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// -- FUNCTIONS -- //

/** Waits for document fonts (capped cleanly) and Vite/dev readiness when inspecting a dev server. */
export async function waitForInspectReady(
	page: InspectPageLike,
	opts: { isDev?: boolean; needles?: readonly string[] } = {}
): Promise<void> {
	if (opts.isDev && typeof page.waitForLoadState === 'function') {
		await waitForDevReady(page as unknown as DevReadyPageLike, {
			redactionNeedles: opts.needles ?? []
		});
	}
	await page
		.evaluate(async (timeoutMs) => {
			if (!document.fonts?.ready) return;
			await Promise.race([
				document.fonts.ready.then(() => undefined).catch(() => undefined),
				new Promise<void>((r) => setTimeout(r, timeoutMs))
			]);
		}, FONT_READY_TIMEOUT_MS)
		.catch(() => undefined);
}

/** Extracts { box, styles, text } and unlisted visible [data-ref] names from the current DOM state. */
export async function collectInspectDump(
	page: InspectPageLike,
	opts: {
		target: 'mockup' | 'app';
		screen: string;
		state: string;
		width: number;
		url: string;
		pairs?: ElementPairSpec[];
	}
): Promise<InspectDump> {
	const raw = await page.evaluate(
		(arg) => {
			const { target, pairs, styleProps } = arg;
			const allRefNodes = Array.from(document.querySelectorAll('[data-ref]'));
			const refMap = new Map<string, Element>();
			const visibleRefs: string[] = [];

			for (let i = 0; i < allRefNodes.length; i++) {
				const node = allRefNodes[i];
				const ref = node.getAttribute('data-ref') || '';
				if (!ref) continue;
				if (!refMap.has(ref)) refMap.set(ref, node);
				const cs = getComputedStyle(node);
				const rect = node.getBoundingClientRect();
				const isVis =
					cs.display !== 'none' &&
					cs.visibility !== 'hidden' &&
					Number(cs.opacity) > 0 &&
					rect.width > 0 &&
					rect.height > 0;
				if (isVis && !visibleRefs.includes(ref)) visibleRefs.push(ref);
			}

			const elements: InspectElementDump[] = [];
			const listedRefs = new Set<string>();

			const items: { ref: string; selector: string; el: Element | null }[] = pairs?.length
				? pairs.map((p) => {
						listedRefs.add(p.ref);
						if (target === 'mockup') {
							return {
								ref: p.ref,
								selector: `[data-ref="${p.ref}"]`,
								el: refMap.get(p.ref) ?? null
							};
						}
						let found: Element | null;
						try {
							found = document.querySelector(p.appSelector);
						} catch {
							found = null;
						}
						return { ref: p.ref, selector: p.appSelector, el: found };
					})
				: Array.from(refMap.entries()).map(([ref, el]) => {
						listedRefs.add(ref);
						return { ref, selector: `[data-ref="${ref}"]`, el };
					});

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				const el = item.el;
				if (!el) {
					elements.push({
						ref: item.ref,
						selector: item.selector,
						present: false,
						visible: false,
						box: { x: 0, y: 0, w: 0, h: 0 },
						styles: {},
						text: ''
					});
					continue;
				}
				const cs = getComputedStyle(el);
				const rect = el.getBoundingClientRect();
				const visible =
					cs.display !== 'none' &&
					cs.visibility !== 'hidden' &&
					Number(cs.opacity) > 0 &&
					rect.width > 0 &&
					rect.height > 0;
				const styles: Record<string, string> = {};
				const csRec = cs as unknown as Record<string, string>;
				for (let j = 0; j < styleProps.length; j++) {
					const prop = styleProps[j];
					styles[prop] = String(csRec[prop] ?? '');
				}
				const rawText =
					el instanceof HTMLElement
						? (el.innerText ?? el.textContent ?? '')
						: (el.textContent ?? '');
				elements.push({
					ref: item.ref,
					selector: item.selector,
					present: true,
					visible,
					box: {
						x: Math.round(rect.left * 100) / 100,
						y: Math.round(rect.top * 100) / 100,
						w: Math.round(rect.width * 100) / 100,
						h: Math.round(rect.height * 100) / 100
					},
					styles,
					text: rawText.replace(/\s+/g, ' ').trim().slice(0, 500)
				});
			}

			const unlistedRefs = visibleRefs.filter((r) => !listedRefs.has(r));
			return { elements, unlistedRefs };
		},
		{
			target: opts.target,
			pairs: opts.pairs,
			styleProps: [...INSPECT_STYLE_PROPERTIES]
		}
	);

	return {
		target: opts.target,
		screen: opts.screen,
		state: opts.state,
		width: opts.width,
		url: opts.url,
		elements: raw.elements,
		unlistedRefs: raw.unlistedRefs
	};
}

/**
 * Opens an isolated browser context, drives screen/state/width, waits for settle,
 * and returns a structured InspectDump (plus optional screenshot bytes).
 */
export async function inspectUrl(opts: InspectUrlOptions): Promise<InspectUrlResult> {
	if (opts.target === 'mockup' && opts.storageState != null) {
		throw new Error('Mockup inspection cannot accept saved sign-ins or storageState.');
	}
	const screen = opts.screen ?? DEFAULT_SCREEN;
	const state = opts.state ?? DEFAULT_STATE;
	const width = opts.width ?? DEFAULT_WIDTH;
	const height = opts.height ?? DEFAULT_HEIGHT;
	const driver: StateDriver =
		opts.driver ??
		(opts.state !== undefined ? { state, mode: 'query' } : { state: DEFAULT_STATE, mode: 'query' });

	const driven = applyStateDriverToUrl(
		opts.url,
		screen,
		opts.driver ?? (opts.state ? driver : undefined)
	);
	const parsedUrl = new URL(driven.url);
	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new Error(`Refused non-HTTP inspection URL protocol "${parsedUrl.protocol}".`);
	}
	if (opts.expectedOrigin && parsedUrl.origin !== opts.expectedOrigin) {
		throw new Error(
			`Refused off-origin inspection URL "${parsedUrl.origin}" (expected "${opts.expectedOrigin}").`
		);
	}
	if (driven.manualRequired) {
		return {
			dump: {
				target: opts.target,
				screen,
				state,
				width,
				url: opts.target === 'mockup' ? parsedUrl.origin : driven.url,
				elements: [],
				unlistedRefs: []
			},
			manualRequired: true
		};
	}

	const isMockup = opts.target === 'mockup';
	const extraHosts = isMockup ? [] : (opts.extraHosts ?? []);
	await ensureBrowser(() => undefined);
	const lease = await acquireBrowser({
		hosts: [parsedUrl.hostname, ...extraHosts],
		headed: opts.headed,
		dedicated: Boolean(opts.dedicated) || isMockup || opts.storageState != null
	});
	let browser: Awaited<
		ReturnType<Awaited<ReturnType<typeof loadPlaywright>>['chromium']['connect']>
	> | null = null;
	try {
		const { chromium } = await loadPlaywright();
		browser = await chromium.connect(lease.wsEndpoint());
		const ctxOptions: NonNullable<Parameters<typeof browser.newContext>[0]> = {
			baseURL: parsedUrl.origin,
			viewport: { width, height },
			serviceWorkers: 'block'
		};
		if (!isMockup && opts.storageState != null) {
			ctxOptions.storageState = opts.storageState as NonNullable<
				Parameters<typeof browser.newContext>[0]
			>['storageState'];
		}
		const ctx = await browser.newContext(ctxOptions);
		try {
			if (!isMockup && opts.isDev && typeof ctx.addInitScript === 'function') {
				await ctx.addInitScript(DEV_READINESS_INIT_SCRIPT);
			}
			if (!isMockup && opts.isDev) {
				await guardDevContext(ctx as unknown as ContextLike, {
					origin: parsedUrl.origin,
					writeAllowlist: opts.allowWrites ? (opts.writeAllowlist ?? []) : [],
					extraHosts
				});
			} else {
				await guardContext(ctx as unknown as ContextLike, {
					origin: parsedUrl.origin,
					allowWrites: false,
					extraHosts
				});
			}

			const page = (await ctx.newPage()) as unknown as InspectPageLike;
			if (
				!isMockup &&
				driver.mode === 'route-mock' &&
				driver.routePattern &&
				typeof page.route === 'function'
			) {
				await page.route(driver.routePattern, (route) =>
					route.fulfill({
						status: driver.routeStatus ?? 200,
						contentType: driver.routeContentType ?? 'application/json',
						body: driver.routeBody ?? '{}'
					})
				);
			}
			await page.setViewportSize({ width, height });
			await page.goto(driven.url, { waitUntil: 'load', timeout: OP_TIMEOUT_MS });
			await waitForInspectReady(page, {
				isDev: !isMockup && opts.isDev,
				needles: opts.needles ?? []
			});

			const dump = await withTimeout(
				collectInspectDump(page, {
					target: opts.target,
					screen,
					state,
					width,
					url: isMockup ? parsedUrl.origin : driven.url,
					pairs: opts.pairs
				}),
				'collectInspectDump'
			);
			let screenshot: Buffer | undefined;
			if (opts.captureScreenshot && typeof page.screenshot === 'function') {
				screenshot = await withTimeout(
					page.screenshot({ type: 'jpeg', quality: 70, fullPage: true, timeout: OP_TIMEOUT_MS }),
					'page.screenshot'
				);
			}
			return { dump, screenshot, manualRequired: false };
		} finally {
			await ctx.close().catch(() => undefined);
		}
	} finally {
		await browser?.close().catch(() => undefined);
		await lease.release().catch(() => undefined);
	}
}

/** CLI helper for `agent-flow-board mockup inspect ID[@VERSION] --screen S --state T --width W`. */
export async function inspectMockupCli(opts: {
	server: string;
	org: string;
	token: string;
	mockup: string;
	version?: number;
	screen?: string;
	state?: string;
	width?: number;
	height?: number;
	fetch: Fetch;
	log: (line: string) => void;
}): Promise<InspectDump> {
	const parsed = parseMockupRef(opts.mockup);
	const ref =
		opts.version !== undefined && parsed.version === undefined
			? { ...parsed, version: opts.version }
			: parsed;
	const minted = await resolveMockupTarget({
		server: opts.server,
		org: opts.org,
		ref,
		personalToken: opts.token,
		fetch: opts.fetch,
		log: opts.log
	});
	const result = await inspectUrl({
		url: minted.url,
		expectedOrigin: minted.origin,
		target: 'mockup',
		screen: opts.screen,
		state: opts.state,
		width: opts.width,
		height: opts.height
	});
	return result.dump;
}
