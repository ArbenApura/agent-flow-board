// THE SYSTEM SKILLS INDEX: BUNDLE VERSION, EACH SKILL'S VERSION, HASH AND FILES, AND THE CHANGELOG. PUBLIC, NO SIGN IN.

// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED MODULES
import { bundleSha256, systemSkillsIndex } from '#lib/server/system-skills/index.js';
import { publicAnswer } from '#lib/server/system-skills/http.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = ({ request }) =>
	publicAnswer(request, JSON.stringify(systemSkillsIndex()), {
		type: 'application/json; charset=utf-8',
		etag: bundleSha256()
	});
