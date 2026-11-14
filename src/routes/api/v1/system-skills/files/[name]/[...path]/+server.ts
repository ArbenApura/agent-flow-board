// ONE FILE OF A SYSTEM SKILL, AS IT IS INSTALLED (THE SKILL.md CARRIES ITS VERSION STAMP). PUBLIC, NO SIGN IN.

// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED MODULES
import { servedFile } from '#lib/server/system-skills/index.js';
import { sha256Hex } from '#lib/server/system-skills/hash.js';
import { notFound, publicAnswer } from '#lib/server/system-skills/http.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = ({ request, params }) => {
	// Only a flat name and a plain relative path are looked up; the answer is a map lookup, never a file read
	const text = /^[a-z][a-z0-9-]*$/.test(params.name) ? servedFile(params.name, params.path) : null;
	if (text === null) return notFound();
	return publicAnswer(request, text, {
		type: 'text/markdown; charset=utf-8',
		etag: sha256Hex(text)
	});
};
