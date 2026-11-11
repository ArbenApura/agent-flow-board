// THE SHAPE OF AN API ANSWER AND HOW EVERY KIND OF ERROR BECOMES ONE, SHARED BY THE USER API AND THE RUNNER API

// -- TYPES -- //
import type { ApiResponse } from './dispatch';
// -- MODULES -- //
import { OpError } from '../ops/context';
import { OrgError } from '../orgs/orgs';

// -- CONSTANTS -- //

export const STATUS: Record<string, number> = {
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	INVALID: 400,
	STALE_VERSION: 409,
	RATE_LIMITED: 429,
	CONFLICT: 409,
	COMPLETED_REFUSED: 409,
	MOCKUP_UNREAD: 409,
	CONFIRM_REQUIRED: 409,
	ORG_LOCKED: 423
};
export const NO_STORE = { 'cache-control': 'no-store' };

// -- FUNCTIONS -- //

export const fail = (
	status: number,
	code: string,
	message: string,
	details?: unknown
): ApiResponse => ({
	status,
	headers: NO_STORE,
	body: { error: { code, message, ...(details ? { details } : {}) } }
});

export function errorResponse(e: unknown): ApiResponse {
	if (e instanceof OpError) return fail(STATUS[e.code] ?? 400, e.code, e.message, e.details);
	// Organisation and member rules (the last owner, a role that may not do that) speak the same language
	if (e instanceof OrgError)
		return fail(
			{
				FORBIDDEN: 403,
				LAST_OWNER: 409,
				NOT_FOUND: 404,
				SLUG_TAKEN: 409,
				INVALID: 400,
				ORG_LOCKED: 423
			}[e.code] ?? 400,
			e.code,
			e.message
		);
	const err = e as { name?: string; issues?: { path: (string | number)[]; message: string }[] };
	// A Zod error from a verb's own input check
	if (err?.name === 'ZodError' && err.issues)
		return fail(
			400,
			'INVALID',
			err.issues[0]?.message ?? 'Invalid input',
			err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
		);
	console.error('API error', e instanceof Error ? (e.stack ?? e.message) : e);
	// Nothing about the failure is returned, so a server problem cannot leak a query, a path or a secret
	return fail(500, 'INTERNAL', 'Something went wrong on the server.');
}
