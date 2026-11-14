// GUARDS: WHAT A PAGE MAY REACH, WHAT IT MAY CHANGE, AND WHAT A CHECK IS HANDED.
// Layer one is the browser itself: every host except the preview's is unresolvable (see browser.ts), whatever a check does with routes.
// Layer two counts and stops writes. Layer three hands a check a facade of the page that cannot lead back to the context or the cookies.
// This file imports nothing at runtime, so the sandboxed child can load it. Playwright is only described here by the few members it calls.

// -- TYPES -- //

/** The part of a Playwright request a guard reads. */
export interface RequestLike {
	url(): string;
	method(): string;
	resourceType(): string;
}
/** The part of a Playwright route a guard calls. */
export interface RouteLike {
	request(): RequestLike;
	continue(): Promise<void>;
	abort(): Promise<void>;
	fulfill(options: { status: number; body: string }): Promise<void>;
}
/** The part of a Playwright browser context the guard needs. */
export interface WebSocketRouteLike {
	url(): string;
	close(options?: { code?: number; reason?: string }): void | Promise<void>;
	onMessage?(handler: (message: string | Buffer) => void): void;
	connectToServer?(): {
		onMessage?(handler: (message: string | Buffer) => void): void;
		send?(message: string | Buffer): void;
	};
	send?(message: string | Buffer): void;
}
export interface ContextLike {
	route(url: string, handler: (route: RouteLike) => void | Promise<void>): Promise<void>;
	routeWebSocket?(
		url: string,
		handler: (ws: WebSocketRouteLike) => void | Promise<void>
	): Promise<void>;
}
export interface GuardWriteRule {
	method: string;
	pathPrefix: string;
}
export type GuardOptions = {
	/** The origin of the app under test, for example http://127.0.0.1:4173. */
	origin: string;
	/** True only when the person said so for this run. */
	allowWrites?: boolean;
	/** Method+path prefixes allowed when allowWrites is true (empty/omitted stops all writes unless legacy unconstrained opt-in). */
	writeAllowlist?: GuardWriteRule[];
	/** Host names (not origins) that may be reached besides the app. */
	extraHosts?: string[];
	onBlocked?: (message: string) => void;
};
export type GuardCounts = { writes: number; outside: number };

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
const WRAPPED =
	/^_?(Locator|FrameLocator|Frame|ElementHandle|JSHandle|Response|Request|Keyboard|Mouse|Touchscreen|Dialog|Download|FileChooser|ConsoleMessage|Worker|WebSocket|Page)$/;
const NODE_MODULES =
	'fs|fs/promises|child_process|net|http|https|http2|dgram|dns|tls|worker_threads|vm|os|cluster|module|v8|inspector|repl|readline|stream|zlib|crypto|perf_hooks|async_hooks|wasi|tty|process';
const UNSAFE: [RegExp, string][] = [
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

export const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
};

const sameOrigin = (url: string, origin: string): boolean => {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
};

const sameWsOrigin = (wsUrl: string, origin: string): boolean => {
	try {
		const ws = new URL(wsUrl);
		const orig = new URL(origin);
		const expectedProto = orig.protocol === 'https:' ? 'wss:' : 'ws:';
		return ws.protocol === expectedProto && ws.host === orig.host;
	} catch {
		return false;
	}
};

const VITE_HMR_PATHS: ReadonlySet<string> = new Set(['/', '/@vite/client', '/vite-hmr']);

function isStrictVitePing(url: string, origin: string, msg: string | Buffer): boolean {
	if (typeof msg !== 'string') return false;
	if (!sameWsOrigin(url, origin)) return false;
	try {
		const parsedUrl = new URL(url);
		if (!VITE_HMR_PATHS.has(parsedUrl.pathname)) return false;
		const parsed = JSON.parse(msg) as Record<string, unknown>;
		return (
			typeof parsed === 'object' &&
			parsed !== null &&
			parsed.type === 'ping' &&
			Object.keys(parsed).length === 1
		);
	} catch {
		return false;
	}
}

/**
 * Stops every write and counts what it stopped. A page that submits a form is answered with nothing so it stays where it is.
 * Writes are only let through when the person said so for this run (allowWrites).
 */
export async function guardContext(
	ctx: ContextLike,
	{
		origin,
		allowWrites = false,
		writeAllowlist,
		extraHosts = [],
		onBlocked = () => {}
	}: GuardOptions
): Promise<GuardCounts> {
	const counts: GuardCounts = { writes: 0, outside: 0 };
	const matchAllowlist = (method: string, pathname: string): boolean => {
		if (!writeAllowlist) return true;
		const m = method.toUpperCase();
		return writeAllowlist.some(
			(r) =>
				r.method.toUpperCase() === m &&
				(pathname === r.pathPrefix ||
					r.pathPrefix === '/' ||
					pathname.startsWith(r.pathPrefix.endsWith('/') ? r.pathPrefix : `${r.pathPrefix}/`))
		);
	};
	await ctx.route('**/*', async (route) => {
		const req = route.request();
		const url = req.url();
		if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
		if (!sameOrigin(url, origin) && !extraHosts.includes(hostOf(url))) {
			counts.outside++;
			onBlocked(`blocked a request to ${hostOf(url)}`);
			return route.abort();
		}
		if (!READ_METHODS.has(req.method())) {
			const pathname = new URL(url).pathname;
			const permitted =
				allowWrites && sameOrigin(url, origin) && matchAllowlist(req.method(), pathname);
			if (!permitted) {
				counts.writes++;
				onBlocked(`stopped a ${req.method()} to ${pathname}`);
				return req.resourceType() === 'document'
					? route.fulfill({ status: 204, body: '' })
					: route.abort();
			}
		}
		return route.continue();
	});
	// WebSockets route through the same origin and write guard (Vite HMR server pushes stay open; client writes stop when allowWrites is off)
	if (ctx.routeWebSocket) {
		await ctx.routeWebSocket('**/*', (ws) => {
			const url = ws.url();
			if (!sameWsOrigin(url, origin) && !extraHosts.includes(hostOf(url))) {
				counts.outside++;
				onBlocked(`blocked a WebSocket to ${hostOf(url)}`);
				void ws.close({ code: 1008, reason: 'Blocked outside origin' });
				return;
			}
			const server = ws.connectToServer?.();
			if (server) {
				const wsPathname = (() => {
					try {
						return new URL(url).pathname;
					} catch {
						return '/';
					}
				})();
				server.onMessage?.((msg) => ws.send?.(msg));
				ws.onMessage?.((msg) => {
					const pingOnly = isStrictVitePing(url, origin, msg);
					const allowedWsWrite =
						allowWrites &&
						sameWsOrigin(url, origin) &&
						(!writeAllowlist || matchAllowlist('WS', wsPathname));
					if (!pingOnly && !allowedWsWrite) {
						counts.writes++;
						onBlocked(`stopped a WebSocket message to ${wsPathname}`);
						return;
					}
					server.send?.(msg);
				});
			}
		});
	}
	return counts;
}

/** Write-guard helper for dev targets: writes are permitted ONLY for explicitly allowlisted non-GET rules. */
export async function guardDevContext(
	ctx: ContextLike,
	opts: {
		origin: string;
		writeAllowlist?: readonly GuardWriteRule[];
		extraHosts?: readonly string[];
		onBlocked?: (message: string) => void;
	}
): Promise<GuardCounts> {
	const safeRules = (opts.writeAllowlist ?? []).filter(
		(rule) => !READ_METHODS.has(String(rule.method).toUpperCase())
	);
	return guardContext(ctx, {
		origin: opts.origin,
		allowWrites: safeRules.length > 0,
		writeAllowlist: safeRules,
		extraHosts: opts.extraHosts ? [...opts.extraHosts] : undefined,
		onBlocked: opts.onBlocked
	});
}

/** Browser-layer write guard note (Step A.9): service workers blocked, all HTTP methods, sendBeacon and WebSocket routed through the guard. */
export function describeWriteGuard(counts: GuardCounts): string {
	return `Browser-layer write guard (service workers blocked, HTTP methods, sendBeacon and WebSocket routed): stopped ${counts.writes} write(s), blocked ${counts.outside} outside request(s).`;
}

const refuse = (prop: string) => () => {
	throw new Error(
		`${prop} is not available to a check. Checks drive the page; the tool keeps the session and the network rules.`
	);
};

type Guard = { assertNavigable(url: unknown): void };

const isThenable = (v: object): v is PromiseLike<unknown> =>
	typeof (v as { then?: unknown }).then === 'function';

/** Wraps something a page returned (a locator, a response, a promise of one) so it can never lead back to the context. */
function wrap(value: unknown, guard: Guard): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (isThenable(value)) return value.then((v) => wrap(v, guard));
	if (Array.isArray(value)) return value.map((v) => wrap(v, guard));
	const name = (value as { constructor?: { name?: string } }).constructor?.name ?? '';
	if (!WRAPPED.test(name)) return value;
	return proxy(value, guard);
}

const originals = new WeakMap<object, object>();

/** The real object behind something a check was handed, for the tool's own use (expect needs the real locator). */
export const unwrap = <T>(v: T): T =>
	typeof v === 'object' && v !== null ? ((originals.get(v) as T | undefined) ?? v) : v;

function proxy<T extends object>(value: T, guard: Guard): T {
	const made = new Proxy(value, {
		get(target, prop) {
			if (typeof prop === 'string' && HIDDEN.has(prop))
				return new Proxy(refuse(prop), {
					get: refuse(prop),
					apply: refuse(prop),
					set: refuse(prop)
				});
			// expect() talks to a locator through its internal _expect and nothing else
			if (typeof prop === 'string' && prop.startsWith('_') && prop !== '_expect') return undefined;
			const v: unknown = Reflect.get(target, prop, target);
			// Symbols and the constructor are handed over as they are, so instanceof checks and expect() still recognise a locator
			if (typeof prop === 'symbol' || prop === 'constructor') return v;
			if (typeof v !== 'function') return wrap(v, guard);
			return (...args: unknown[]) => {
				if (prop === 'goto') guard.assertNavigable(args[0]);
				return wrap((v as (...a: unknown[]) => unknown).apply(target, args), guard);
			};
		}
	});
	originals.set(made, value);
	return made;
}

/** What a check receives instead of the real page: no context, no cookies, no request client, no routes, and no way back to them through a frame, a locator or a response. */
export function pageForCheck<T extends object>(
	page: T,
	{ origin, extraHosts = [] }: { origin?: string; extraHosts?: string[] } = {}
): T {
	const guard: Guard = {
		assertNavigable(url) {
			const u = String(url ?? '');
			if (u.startsWith('/') && !u.startsWith('//')) return;
			let parsed: URL;
			try {
				parsed = new URL(u);
			} catch {
				throw new Error(
					`The check tried to open "${u.slice(0, 60)}", which is not an address of the app under test.`
				);
			}
			if (
				!['http:', 'https:'].includes(parsed.protocol) ||
				(origin && parsed.origin !== origin && !extraHosts.includes(parsed.hostname))
			)
				throw new Error(
					`The check tried to open ${parsed.protocol}//${parsed.host}, which is not the app under test.`
				);
		}
	};
	return proxy(page, guard);
}

/** A speed bump, not a wall: names what a check does that a check has no business doing. Refused unless the person says --allow-unsafe. */
export function lintCheck(source: string): string[] {
	const found: string[] = [];
	for (const [re, label] of UNSAFE)
		if (re.test(source) && !found.includes(label)) found.push(label);
	return found;
}
