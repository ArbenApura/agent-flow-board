// DOM INSPECTION FOR HOSTED MOCKUPS AND APP TARGETS (STEP B.5, AFB-20261113-1008)
// Opens the target in a Chromium context (strictly zero storageState / zero writes for mockups), triggers the requested screen/state/width,
// waits until layout and fonts settle, and dumps { box, computed style whitelist, text } for every data-ref or paired app selector plus unlisted data-refs.
// -- MODULES -- //
import { ensureBrowser, loadPlaywright } from './browser.js';
import { acquireBrowser } from './browserpool.js';
import { DEV_READINESS_INIT_SCRIPT, waitForDevReady } from './devReadiness.js';
import { guardContext, guardDevContext } from './guard.js';
import { parseMockupRef, resolveMockupTarget } from './mockupTarget.js';
import { applyStateDriverToUrl, INSPECT_STYLE_PROPERTIES } from './pairing.js';
// -- CONSTANTS -- //
const DEFAULT_SCREEN = '';
const DEFAULT_STATE = 'default';
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const FONT_READY_TIMEOUT_MS = 2_000;
const OP_TIMEOUT_MS = 30_000;
async function withTimeout(promise, label, ms = OP_TIMEOUT_MS) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
                timer.unref?.();
            })
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
// -- FUNCTIONS -- //
/** Waits for document fonts (capped cleanly) and Vite/dev readiness when inspecting a dev server. */
export async function waitForInspectReady(page, opts = {}) {
    if (opts.isDev && typeof page.waitForLoadState === 'function') {
        await waitForDevReady(page, {
            redactionNeedles: opts.needles ?? []
        });
    }
    await page
        .evaluate(async (timeoutMs) => {
        if (!document.fonts?.ready)
            return;
        await Promise.race([
            document.fonts.ready.then(() => undefined).catch(() => undefined),
            new Promise((r) => setTimeout(r, timeoutMs))
        ]);
    }, FONT_READY_TIMEOUT_MS)
        .catch(() => undefined);
}
/** Extracts { box, styles, text } and unlisted visible [data-ref] names from the current DOM state. */
export async function collectInspectDump(page, opts) {
    const raw = await page.evaluate((arg) => {
        const { target, pairs, styleProps } = arg;
        const allRefNodes = Array.from(document.querySelectorAll('[data-ref]'));
        const refMap = new Map();
        const visibleRefs = [];
        for (let i = 0; i < allRefNodes.length; i++) {
            const node = allRefNodes[i];
            const ref = node.getAttribute('data-ref') || '';
            if (!ref)
                continue;
            if (!refMap.has(ref))
                refMap.set(ref, node);
            const cs = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            const isVis = cs.display !== 'none' &&
                cs.visibility !== 'hidden' &&
                Number(cs.opacity) > 0 &&
                rect.width > 0 &&
                rect.height > 0;
            if (isVis && !visibleRefs.includes(ref))
                visibleRefs.push(ref);
        }
        const elements = [];
        const listedRefs = new Set();
        const items = pairs?.length
            ? pairs.map((p) => {
                listedRefs.add(p.ref);
                if (target === 'mockup') {
                    return {
                        ref: p.ref,
                        selector: `[data-ref="${p.ref}"]`,
                        el: refMap.get(p.ref) ?? null
                    };
                }
                let found;
                try {
                    found = document.querySelector(p.appSelector);
                }
                catch {
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
            const visible = cs.display !== 'none' &&
                cs.visibility !== 'hidden' &&
                Number(cs.opacity) > 0 &&
                rect.width > 0 &&
                rect.height > 0;
            const styles = {};
            const csRec = cs;
            for (let j = 0; j < styleProps.length; j++) {
                const prop = styleProps[j];
                styles[prop] = String(csRec[prop] ?? '');
            }
            const rawText = el instanceof HTMLElement
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
    }, {
        target: opts.target,
        pairs: opts.pairs,
        styleProps: [...INSPECT_STYLE_PROPERTIES]
    });
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
export async function inspectUrl(opts) {
    if (opts.target === 'mockup' && opts.storageState != null) {
        throw new Error('Mockup inspection cannot accept saved sign-ins or storageState.');
    }
    const screen = opts.screen ?? DEFAULT_SCREEN;
    const state = opts.state ?? DEFAULT_STATE;
    const width = opts.width ?? DEFAULT_WIDTH;
    const height = opts.height ?? DEFAULT_HEIGHT;
    const driver = opts.driver ??
        (opts.state !== undefined ? { state, mode: 'query' } : { state: DEFAULT_STATE, mode: 'query' });
    const driven = applyStateDriverToUrl(opts.url, screen, opts.driver ?? (opts.state ? driver : undefined));
    const parsedUrl = new URL(driven.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Refused non-HTTP inspection URL protocol "${parsedUrl.protocol}".`);
    }
    if (opts.expectedOrigin && parsedUrl.origin !== opts.expectedOrigin) {
        throw new Error(`Refused off-origin inspection URL "${parsedUrl.origin}" (expected "${opts.expectedOrigin}").`);
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
    let browser = null;
    try {
        const { chromium } = await loadPlaywright();
        browser = await chromium.connect(lease.wsEndpoint());
        const ctxOptions = {
            baseURL: parsedUrl.origin,
            viewport: { width, height },
            serviceWorkers: 'block',
            // Emulates the person's "reduce motion" setting, so the reduced-motion rule of both sides is what gets measured
            ...(opts.reducedMotion ? { reducedMotion: 'reduce' } : {})
        };
        if (!isMockup && opts.storageState != null) {
            ctxOptions.storageState = opts.storageState;
        }
        const ctx = await browser.newContext(ctxOptions);
        try {
            if (!isMockup && opts.isDev && typeof ctx.addInitScript === 'function') {
                await ctx.addInitScript(DEV_READINESS_INIT_SCRIPT);
            }
            if (!isMockup && opts.isDev) {
                await guardDevContext(ctx, {
                    origin: parsedUrl.origin,
                    writeAllowlist: opts.allowWrites ? (opts.writeAllowlist ?? []) : [],
                    extraHosts
                });
            }
            else {
                await guardContext(ctx, {
                    origin: parsedUrl.origin,
                    allowWrites: false,
                    extraHosts
                });
            }
            const page = (await ctx.newPage());
            if (!isMockup &&
                driver.mode === 'route-mock' &&
                driver.routePattern &&
                typeof page.route === 'function') {
                await page.route(driver.routePattern, (route) => route.fulfill({
                    status: driver.routeStatus ?? 200,
                    contentType: driver.routeContentType ?? 'application/json',
                    body: driver.routeBody ?? '{}'
                }));
            }
            await page.setViewportSize({ width, height });
            await page.goto(driven.url, { waitUntil: 'load', timeout: OP_TIMEOUT_MS });
            await waitForInspectReady(page, {
                isDev: !isMockup && opts.isDev,
                needles: opts.needles ?? []
            });
            const dump = await withTimeout(collectInspectDump(page, {
                target: opts.target,
                screen,
                state,
                width,
                url: isMockup ? parsedUrl.origin : driven.url,
                pairs: opts.pairs
            }), 'collectInspectDump');
            let screenshot;
            if (opts.captureScreenshot && typeof page.screenshot === 'function') {
                screenshot = await withTimeout(page.screenshot({ type: 'jpeg', quality: 70, fullPage: true, timeout: OP_TIMEOUT_MS }), 'page.screenshot');
            }
            return { dump, screenshot, manualRequired: false };
        }
        finally {
            await ctx.close().catch(() => undefined);
        }
    }
    finally {
        await browser?.close().catch(() => undefined);
        await lease.release().catch(() => undefined);
    }
}
/** CLI helper for `agent-flow-board mockup inspect ID[@VERSION] --screen S --state T --width W`. */
export async function inspectMockupCli(opts) {
    const parsed = parseMockupRef(opts.mockup);
    const ref = opts.version !== undefined && parsed.version === undefined
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
