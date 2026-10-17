// -- DEP-TYPES -- //
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
// -- ENVS -- //
import { building } from '$app/env';
import { AFB_BASE_URL, AFB_SEED_DEMO } from '$app/env/private';
// -- DEP-MODULES -- //
import { sequence } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
// -- MODULES -- //
import { getAuth } from '#lib/server/auth/index.js';
import { getDb } from '#lib/server/db/index.js';
import { onWorkers, workersPlatform } from '#lib/server/cloudflare/env.js';
import { flushChanges } from '#lib/server/cloudflare/flush.js';
import { getJobs } from '#lib/server/jobs/index.js';
import { runWithPlatform } from '#lib/server/platform.js';
import { seedForPreview } from '#lib/server/db/seedAuth.js';
import { MODE_COOKIE, SYSTEM_MODE_SCRIPT, parseMode, serverMode } from '#lib/theme/mode.js';

// -- FUNCTIONS -- //

/** Paths called by tools and scripts, which send no Origin header. They authenticate with tokens, never with the cookie, so CSRF does not apply. */
const NO_ORIGIN_CHECK = [/^\/oauth\/(token|register|device\/code)$/, /^\/api\/v1\//, /^\/mcp$/];
const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

/**
 * CSRF protection for form posts. SvelteKit's own check cannot exempt single paths, so it is replaced by this one: a
 * state changing form request must come from this site (Origin header), except the endpoints that use tokens.
 */
const csrf: Handle = ({ event, resolve }) => {
	const { request, url } = event;
	// Behind a tunnel or proxy the server sees http while the browser sends https, so the public address counts as this site too
	const origin = request.headers.get('origin');
	const ownOrigin = origin === url.origin || origin === new URL(AFB_BASE_URL).origin;
	const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
	const form = FORM_TYPES.some((t) =>
		(request.headers.get('content-type') ?? '').toLowerCase().startsWith(t)
	);
	if (unsafe && form && !NO_ORIGIN_CHECK.some((re) => re.test(url.pathname)) && !ownOrigin) {
		return new Response('Cross-site form submissions are forbidden', {
			status: 403,
			headers: { 'content-type': 'text/plain' }
		});
	}
	return resolve(event);
};

/** Adds a Server-Timing header to every response so the performance budgets can be checked from outside. */
const timing: Handle = async ({ event, resolve }) => {
	const start = performance.now();
	const response = await resolve(event);
	const total = performance.now() - start;
	// A response with immutable headers (a redirect from fetch) is left as it is
	try {
		response.headers.append('server-timing', `total;dur=${total.toFixed(1)}`);
	} catch {
		/* Headers are immutable on this response */
	}
	return response;
};

/** Renders the theme mode into the first HTML so the first paint is correct (no flash). */
const theme: Handle = ({ event, resolve }) => {
	const choice = parseMode(event.cookies.get(MODE_COOKIE));
	event.locals.modeChoice = choice;
	// The org palette (Phase 10) joins this style string; empty until an org sets one
	event.locals.paletteStyle = '';
	return resolve(event, {
		transformPageChunk: ({ html }) =>
			html
				.replace('%afb.mode%', serverMode(choice))
				.replace('%afb.system%', choice === 'system' ? '1' : '0')
				.replace('%afb.style%', event.locals.paletteStyle)
				.replace('%afb.modescript%', SYSTEM_MODE_SCRIPT)
	});
};

/** Paths that are not app pages, so a document request to them still reads the session. */
const NOT_A_SHELL =
	/^\/(api|oauth|mcp|github|internal|\.well-known|healthz|pictures)(\/|$)|\/shot\/|\/stream$|\.(json|md)$/;

/**
 * The app is a client rendered shell, so a browser asking for a page gets the same small HTML whoever asks and no database call is
 * made for it. The page's own data request reads the session and enforces every rule (ADR-019).
 */
const isShellRequest = (event: Parameters<Handle>[0]['event']) =>
	event.request.method === 'GET' &&
	event.request.headers.get('sec-fetch-dest') === 'document' &&
	!event.isDataRequest &&
	!NOT_A_SHELL.test(event.url.pathname);

/** Reads the session once per request and serves /api/auth/* through Better Auth. */
const authentication: Handle = async ({ event, resolve }) => {
	// Health checks never touch the database
	if (event.url.pathname === '/healthz') return resolve(event);
	if (isShellRequest(event)) {
		event.locals.user = null;
		event.locals.session = null;
		return resolve(event);
	}
	const auth = await getAuth();
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = session?.user ?? null;
	event.locals.session = session?.session ?? null;
	// Better Auth only answers when the request origin is AFB_BASE_URL. Behind a tunnel or proxy the server sees http and another host,
	// so the auth routes are handed over under the public address (the Google callback and every /api/auth call would be a 404 otherwise)
	if (event.url.pathname.startsWith('/api/auth/') && !building) {
		const target = new URL(event.url.pathname + event.url.search, AFB_BASE_URL);
		return auth.handler(new Request(target, event.request));
	}
	return svelteKitHandler({ auth, event, resolve, building });
};

/**
 * On a Cloudflare Worker, every request runs inside its platform (the bindings it was given) and tells the hub what it changed once
 * it has finished. On a Node server there is no platform and this does nothing.
 */
const platform: Handle = async ({ event, resolve }) => {
	const bindings = await workersPlatform();
	return runWithPlatform(bindings, async () => {
		const response = await resolve(event);
		bindings?.ctx?.waitUntil(flushChanges());
		return response;
	});
};

export const handle: Handle = sequence(platform, timing, csrf, theme, authentication);

/** Fills an empty preview database with the demo data once, when the server starts. */
export const init: ServerInit = async () => {
	// A Worker has no process of its own: its bindings arrive with each request, so there is nothing to start here
	if (onWorkers()) return;
	if (AFB_SEED_DEMO) await seedForPreview(await getDb());
	// Background jobs (publishing, backups) start with the server, not on the first request that needs them
	await getJobs();
};

/** Unexpected failures are logged with their stack on the server, and the person sees only a plain message with no detail. */
export const handleError: HandleServerError = ({ error, event }) => {
	console.error(
		`Unhandled error on ${event.request.method} ${event.url.pathname}`,
		error instanceof Error ? (error.stack ?? error.message) : error
	);
	return { message: 'Something went wrong on the server.' };
};
