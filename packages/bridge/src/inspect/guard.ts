// GUARDS: WHAT A PAGE MAY REACH AND WHAT IT MAY CHANGE, FOR THE MOCKUP RENDERS AND INSPECTION.
// Layer one is the browser itself: every host except the mockup's is unresolvable (see browser.ts), whatever the page does with routes.
// Layer two counts and stops writes.
// This file imports nothing at runtime. Playwright is only described here by the few members it calls.

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
	/** Absent: the app's own origin. Present (host or host:port): that one extra host only. */
	host?: string;
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
	// A rule without a host covers the app's own origin; a rule with a host covers that one registered extra host and nothing else
	const matchAllowlist = (method: string, pathname: string, host?: string): boolean => {
		if (!writeAllowlist) return host === undefined;
		const m = method.toUpperCase();
		return writeAllowlist.some(
			(r) =>
				r.method.toUpperCase() === m &&
				(r.host?.toLowerCase() || undefined) === host &&
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
			const parsed = new URL(url);
			const pathname = parsed.pathname;
			// A host rule needs the host in extraHosts too, so an approval never widens what the page may reach
			const permitted =
				allowWrites &&
				(sameOrigin(url, origin)
					? matchAllowlist(req.method(), pathname)
					: extraHosts.includes(parsed.hostname) &&
						matchAllowlist(req.method(), pathname, parsed.host.toLowerCase()));
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
