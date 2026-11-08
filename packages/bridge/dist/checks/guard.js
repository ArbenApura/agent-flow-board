// GUARDS: WHAT A PAGE MAY REACH, WHAT IT MAY CHANGE, AND WHAT A CHECK IS HANDED.
// Layer one is the browser itself: every host except the preview's is unresolvable (see browser.ts), whatever a check does with routes.
// Layer two counts and stops writes. Layer three hands a check a facade of the page that cannot lead back to the context or the cookies.
// This file imports nothing at runtime, so the sandboxed child can load it. Playwright is only described here by the few members it calls.
// -- CONSTANTS -- //
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HIDDEN = new Set([
    'context',
    'request',
    'route',
    'unroute',
    'unrouteAll',
    'routeFromHAR',
    'routeWebSocket',
    'addInitScript',
    'exposeFunction',
    'exposeBinding',
    'video',
    'pause',
    'browser',
    'page',
    'mainFrame',
    'frames',
    'frame',
    'parentFrame',
    'childFrames',
    'opener',
    'storageState',
    'cookies',
    'addCookies',
    'clearCookies',
    'newPage',
    'newContext',
    'newCDPSession'
]);
// Only Playwright's own objects are wrapped: plain data (what evaluate returns) is handed over as it is
const WRAPPED = /^_?(Locator|FrameLocator|Frame|ElementHandle|JSHandle|Response|Request|Keyboard|Mouse|Touchscreen|Dialog|Download|FileChooser|ConsoleMessage|Worker|WebSocket|Page)$/;
const NODE_MODULES = 'fs|fs/promises|child_process|net|http|https|http2|dgram|dns|tls|worker_threads|vm|os|cluster|module|v8|inspector|repl|readline|stream|zlib|crypto|perf_hooks|async_hooks|wasi|tty|process';
const UNSAFE = [
    [/\bchild_process\b/, 'child_process'],
    [/node:(net|http|https|http2|dgram|dns|tls|worker_threads|vm)\b/, 'a network or process module'],
    [/\brequire\s*\(/, 'require()'],
    [
        new RegExp(`\\bfrom\\s+['"](?:node:)?(?:${NODE_MODULES})['"]`),
        'a module of Node other than path and url'
    ],
    [
        new RegExp(`\\bimport\\s+['"](?:node:)?(?:${NODE_MODULES})['"]`),
        'a module of Node other than path and url'
    ],
    [/\bprocess\.(env|binding|kill|exit|getBuiltinModule)\b/, 'process'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    // A dynamic import is fine only for a file next to the check (a relative name written out in full)
    [/\bimport\s*\(\s*(?!['"]\.{1,2}\/)/, 'a dynamic import of a name that is not a relative file'],
    [/node:fs|\bfrom\s+['"]fs['"]/, 'the file system'],
    [/\bprofiles\b/, 'the profiles folder'],
    [
        /\.(page|context|browser|cookies|storageState|mainFrame|frames|frame|newPage|newContext|route|unroute|routeFromHAR|routeWebSocket|addInitScript|exposeFunction|exposeBinding)\s*\(|\.request\b/,
        'a way back to the browser context'
    ],
    [
        /\bgetBuiltinModule\b|\bglobalThis\b|\bFunction\s*\(|\beval\s*\(|\[\s*['"]constructor['"]\s*\]/,
        'a way around the checks'
    ]
];
// -- FUNCTIONS -- //
export const hostOf = (url) => {
    try {
        return new URL(url).hostname;
    }
    catch {
        return '';
    }
};
const sameOrigin = (url, origin) => {
    try {
        return new URL(url).origin === origin;
    }
    catch {
        return false;
    }
};
/**
 * Stops every write and counts what it stopped. A page that submits a form is answered with nothing so it stays where it is.
 * Writes are only let through when the person said so for this run (allowWrites).
 */
export async function guardContext(ctx, { origin, allowWrites = false, extraHosts = [], onBlocked = () => { } }) {
    const counts = { writes: 0, outside: 0 };
    await ctx.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if (url.startsWith('data:') || url.startsWith('blob:'))
            return route.continue();
        if (!sameOrigin(url, origin) && !extraHosts.includes(hostOf(url))) {
            counts.outside++;
            onBlocked(`blocked a request to ${hostOf(url)}`);
            return route.abort();
        }
        if (!READ_METHODS.has(req.method()) && !allowWrites) {
            counts.writes++;
            onBlocked(`stopped a ${req.method()} to ${new URL(url).pathname}`);
            return req.resourceType() === 'document'
                ? route.fulfill({ status: 204, body: '' })
                : route.abort();
        }
        return route.continue();
    });
    return counts;
}
const refuse = (prop) => () => {
    throw new Error(`${prop} is not available to a check. Checks drive the page; the tool keeps the session and the network rules.`);
};
const isThenable = (v) => typeof v.then === 'function';
/** Wraps something a page returned (a locator, a response, a promise of one) so it can never lead back to the context. */
function wrap(value, guard) {
    if (value === null || typeof value !== 'object')
        return value;
    if (isThenable(value))
        return value.then((v) => wrap(v, guard));
    if (Array.isArray(value))
        return value.map((v) => wrap(v, guard));
    const name = value.constructor?.name ?? '';
    if (!WRAPPED.test(name))
        return value;
    return proxy(value, guard);
}
const originals = new WeakMap();
/** The real object behind something a check was handed, for the tool's own use (expect needs the real locator). */
export const unwrap = (v) => typeof v === 'object' && v !== null ? (originals.get(v) ?? v) : v;
function proxy(value, guard) {
    const made = new Proxy(value, {
        get(target, prop) {
            if (typeof prop === 'string' && HIDDEN.has(prop))
                return new Proxy(refuse(prop), {
                    get: refuse(prop),
                    apply: refuse(prop),
                    set: refuse(prop)
                });
            // expect() talks to a locator through its internal _expect and nothing else
            if (typeof prop === 'string' && prop.startsWith('_') && prop !== '_expect')
                return undefined;
            const v = Reflect.get(target, prop, target);
            // Symbols and the constructor are handed over as they are, so instanceof checks and expect() still recognise a locator
            if (typeof prop === 'symbol' || prop === 'constructor')
                return v;
            if (typeof v !== 'function')
                return wrap(v, guard);
            return (...args) => {
                if (prop === 'goto')
                    guard.assertNavigable(args[0]);
                return wrap(v.apply(target, args), guard);
            };
        }
    });
    originals.set(made, value);
    return made;
}
/** What a check receives instead of the real page: no context, no cookies, no request client, no routes, and no way back to them through a frame, a locator or a response. */
export function pageForCheck(page, { origin, extraHosts = [] } = {}) {
    const guard = {
        assertNavigable(url) {
            const u = String(url ?? '');
            if (u.startsWith('/') && !u.startsWith('//'))
                return;
            let parsed;
            try {
                parsed = new URL(u);
            }
            catch {
                throw new Error(`The check tried to open "${u.slice(0, 60)}", which is not an address of the app under test.`);
            }
            if (!['http:', 'https:'].includes(parsed.protocol) ||
                (origin && parsed.origin !== origin && !extraHosts.includes(parsed.hostname)))
                throw new Error(`The check tried to open ${parsed.protocol}//${parsed.host}, which is not the app under test.`);
        }
    };
    return proxy(page, guard);
}
/** A speed bump, not a wall: names what a check does that a check has no business doing. Refused unless the person says --allow-unsafe. */
export function lintCheck(source) {
    const found = [];
    for (const [re, label] of UNSAFE)
        if (re.test(source) && !found.includes(label))
            found.push(label);
    return found;
}
