// THE SYSTEM SKILLS BUNDLE AS ONE ZIP: ONE FOLDER PER SKILL, EVERY FILE AS IT IS INSTALLED. PUBLIC, NO SIGN IN.

// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { MANIFEST, bundleSha256, systemSkillsZip } from '#lib/server/system-skills/index.js';
import { publicAnswer } from '#lib/server/system-skills/http.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = ({ request }) =>
	publicAnswer(request, systemSkillsZip() as BodyInit, {
		type: 'application/zip',
		etag: `zip-${bundleSha256()}`,
		filename: `agent-flow-board-skills-${MANIFEST.bundle.version}.zip`
	});
