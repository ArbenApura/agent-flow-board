// THE REST DISPATCHER. KNOWS NOTHING ABOUT SVELTEKIT, SO IT IS TESTED DIRECTLY AND CALLED FROM THE ROUTE GLUE

// -- TYPES -- //
import type { JobRunner } from '../adapters/jobs';
import type { Storage } from '../adapters/storage';
import type { GithubApi } from '../github/app';
import type { Mailer } from '../email/mailer';
import type { DbHandle } from '../db/client';
import type { Ctx } from '../ops/context';
import { fingerprintOf } from '../ops/context';
import { requireSession } from '../mcp/sessions';
// -- MODULES -- //
import { authenticateToken } from '../ops/tokens';
import { listMyOrgs, orgForSlug } from '../orgs/orgs';
import { buildOpenApi } from './openapi';
import { NO_STORE, errorResponse, fail } from './respond';
import { handleRunnerApi } from './runner';
import { match } from './routes';

// -- TYPES -- //

export type ApiRequest = {
	method: string;
	/** The path after /api/v1, starting with a slash. */
	path: string;
	query: Record<string, string>;
	headers: Headers;
	/** The address this server was reached at, which a browser's own Origin header is compared with. */
	origin?: string;
	/** The raw body. Parsed as JSON for JSON routes and used as bytes for uploads. */
	body: Uint8Array;
	/** The signed in person from the session cookie, when there is one. */
	session: { id: string; name: string } | null;
};
export type ApiResponse = { status: number; body: unknown; headers?: Record<string, string> };
export type ApiDeps = {
	handle: DbHandle;
	storage?: Storage;
	baseUrl: string;
	mailer?: Mailer;
	github?: GithubApi;
	jobs?: JobRunner;
	/** Wraps the org data keys for test account secrets, and the wait for a runner. */
	masterKey?: string;
	runnerQueueMinutes?: number;
};

// -- CONSTANTS -- //

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Handles one API call from a session or a token and returns a status and a JSON body. */
export async function handleApi(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
	try {
		if (req.path === '/openapi.json' && req.method === 'GET')
			return {
				status: 200,
				body: buildOpenApi(deps.baseUrl),
				headers: { 'cache-control': 'public, max-age=300' }
			};
		// A runner program has its own token and its own small set of calls
		if (req.path.startsWith('/runner/')) return await handleRunnerApi(req, deps);
		if (req.body.byteLength > MAX_BODY_BYTES)
			return fail(413, 'INVALID', 'The request body is larger than 16 MB.');
		// Who is calling: a bearer token, or the signed in person of the session cookie
		const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
		const token = bearer ? await authenticateToken(deps.handle, bearer) : null;
		if (bearer && !token)
			return fail(
				401,
				'UNAUTHENTICATED',
				'The token is not valid. It may have expired or been revoked.'
			);
		const userId = token?.userId ?? req.session?.id;
		if (!userId) return fail(401, 'UNAUTHENTICATED', 'Sign in or send a personal access token.');
		// A signed in browser carries its cookie on every request to this site, from any page. A browser always names where a
		// state changing request came from, so one that comes from another site is refused. A program with a cookie names nothing.
		if (!token && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
			const origin = req.headers.get('origin');
			const site = req.headers.get('sec-fetch-site');
			if (
				(origin &&
					origin !== 'null' &&
					origin !== req.origin &&
					origin !== new URL(deps.baseUrl).origin) ||
				origin === 'null' ||
				site === 'cross-site' ||
				site === 'same-site'
			)
				return fail(403, 'FORBIDDEN', 'This request came from another site.');
		}

		if (req.path === '/me' && req.method === 'GET') {
			const orgs = (await listMyOrgs(deps.handle, userId)).filter((o) => !o.deletedAt);
			return {
				status: 200,
				headers: NO_STORE,
				body: {
					userId,
					via: token ? 'token' : 'session',
					orgs: token ? orgs.filter((o) => o.id === token.orgId) : orgs
				}
			};
		}

		const found = match(req.method, req.path);
		if (!found) return fail(404, 'NOT_FOUND', 'No such endpoint.');
		if ('allowed' in found)
			return {
				status: 405,
				headers: { ...NO_STORE, allow: found.allowed.join(', ') },
				body: {
					error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${found.allowed.join(' or ')}.` }
				}
			};
		const { route, params } = found;
		if (route.sessionOnly && token)
			return fail(403, 'FORBIDDEN', 'This needs a signed in person. A token cannot do it.');

		// The org comes from the path and is checked against membership (and the token's own org)
		const org = await orgForSlug(deps.handle, params.org, userId);
		if (!org || (token && token.orgId !== org.id)) return fail(404, 'NOT_FOUND', 'Not found.');

		let body: unknown;
		if (route.body) {
			const text = new TextDecoder().decode(req.body);
			let json: unknown = undefined;
			if (text.trim() !== '') {
				try {
					json = JSON.parse(text);
				} catch {
					return fail(400, 'INVALID', 'The body must be valid JSON.');
				}
			}
			const parsed = route.body.safeParse(json ?? {});
			if (!parsed.success)
				return fail(
					400,
					'INVALID',
					parsed.error.issues[0]?.message ?? 'Invalid input',
					parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
				);
			body = parsed.data;
		}

		const requestId = req.headers.get('idempotency-key') ?? undefined;
		if (requestId !== undefined && !/^[A-Za-z0-9._:-]{8,80}$/.test(requestId))
			return fail(400, 'INVALID', 'The Idempotency-Key must be 8 to 80 letters, digits or . _ : -');
		const sessionId = req.headers.get('x-session-id') ?? undefined;
		const ctx: Ctx = {
			handle: deps.handle,
			orgId: org.id,
			requestId,
			fingerprint: requestId
				? fingerprintOf(`${route.method} ${route.path}`, params, body)
				: undefined,
			services: {
				storage: deps.storage,
				baseUrl: deps.baseUrl,
				mailer: deps.mailer,
				github: deps.github,
				jobs: deps.jobs,
				masterKey: deps.masterKey,
				runnerQueueMinutes: deps.runnerQueueMinutes
			},
			actor: token
				? {
						userId,
						kind: 'agent',
						tool: token.name,
						tokenId: token.tokenId,
						tokenCaps: token.caps,
						tokenProjects: token.projectIds,
						sessionId,
						label: token.name
					}
				: { userId, kind: 'person', label: req.session?.name, sessionId }
		};
		// A session id names the caller's own session or nothing: it decides whose work the events are filed under
		if (sessionId) await requireSession(ctx, sessionId);
		const result = await route.handler({
			ctx,
			params,
			body,
			query: req.query,
			bytes: route.upload ? req.body : undefined
		});
		return { status: 200, headers: NO_STORE, body: result };
	} catch (e) {
		return errorResponse(e);
	}
}
