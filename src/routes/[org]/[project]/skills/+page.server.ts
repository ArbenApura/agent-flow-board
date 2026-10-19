// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { listSkills, skillAccess } from '#lib/server/ops/skills.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * The project's skills and its organisation's, with what this person may do. A guest is refused here, before any skill is
 * read, and the page shows the permission panel instead. The live stream refetches it when a skill changes.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { access: null, skills: [] };
	const ctx = await childContext(locals, org.id);
	const access = await skillAccess(ctx, params.project);
	if (access.guest) return { access, skills: [] };
	const skills = await listSkills(ctx, { project: params.project });
	return {
		access,
		skills: skills.map((s) => ({
			id: s.id,
			name: s.name,
			summary: s.summary,
			files: s.files,
			source: s.source,
			author: s.author,
			revision: s.revision,
			hash: s.hash,
			version: s.version,
			updatedAt: s.updatedAt.toISOString()
		}))
	};
};
