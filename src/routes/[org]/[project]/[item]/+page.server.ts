// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { error, redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { renderMarkdownCached } from '#lib/markdown.js';
import { itemCore, itemExtras } from '#lib/server/ops/board.js';
import { OpError } from '#lib/server/ops/context.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';
import { itemMockups } from '#lib/server/web/itemMockups.js';

// -- FUNCTIONS -- //

/** One item with everything its page shows. Markdown is rendered here, once per distinct text, and arrives as safe HTML. */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) return { detail: null, extras: null, denied: null, mockups: null };
	const ctx = await childContext(locals, org.id);
	try {
		const d = await itemCore(ctx, params.item);
		// An old alias or another project's key in the address lands on the item's own address
		if (d.project.key !== params.project || d.item.ref !== params.item)
			redirect(307, `/${org.slug}/${d.project.key}/${d.item.ref}`);
		// Where the texts live, so an afb: link or a bare reference in them becomes an address of this project
		const linkBase = { org: org.slug, project: d.project.key };
		// The mockups of this plan: a count and a list always, the preview and notes when their tab is open
		const mockups = await itemMockups(
			ctx,
			d.project.key,
			d.item.ref,
			url.searchParams.get('tab') === 'mockups',
			url.searchParams.get('m')
		);
		// Discussion, files and activity are not on the first tab, so they stream in after the page is sent
		const extras = itemExtras(ctx, d.item).then((x) => ({
			...x,
			comments: x.comments.map((c) => ({
				...c,
				html: renderMarkdownCached(c.body, { untrusted: c.untrusted, linkBase })
			}))
		}));
		// A failure of the streamed part must reach the page as a rejected promise, never crash the server
		extras.catch(() => undefined);
		return {
			denied: null,
			mockups,
			extras,
			detail: {
				...d,
				sections: d.sections.map((s) => ({
					...s,
					html: renderMarkdownCached(s.body, { linkBase })
				})),
				decisions: d.decisions.map((x) => ({
					...x,
					contextHtml: renderMarkdownCached(x.context, { linkBase }),
					decisionHtml: renderMarkdownCached(x.decision, { linkBase }),
					alternativesHtml: renderMarkdownCached(x.alternatives, { linkBase }),
					consequencesHtml: renderMarkdownCached(x.consequences, { linkBase })
				}))
			}
		};
	} catch (e) {
		if (e instanceof OpError) {
			if (e.code === 'NOT_FOUND') error(404, 'Not found');
			return { detail: null, extras: null, mockups: null, ...pageError(e) };
		}
		throw e;
	}
};
