// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- DEP-MODULES -- //
import { json } from '@sveltejs/kit';
// -- MODULES -- //
import { continueChoice } from '#lib/server/db/zod.js';
import { saveContinueChoice } from '#lib/server/web/continuePref.js';

// -- FUNCTIONS -- //

/** Saves the tool and the way a person picked for "Continue with". JSON only, for a signed in person. Nothing else in their preferences changes. */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return json({ message: 'Sign in first.' }, { status: 401 });
	const body = await request.json().catch(() => null);
	const parsed = continueChoice.safeParse(body);
	if (!parsed.success)
		return json(
			{ message: parsed.error.issues[0]?.message ?? 'Pick a tool and a way.' },
			{ status: 400 }
		);
	await saveContinueChoice(locals.user.id, parsed.data);
	return json({ ok: true });
};
