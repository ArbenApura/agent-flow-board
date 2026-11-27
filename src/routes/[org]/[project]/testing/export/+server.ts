// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED DEP-MODULES
import { error } from '@sveltejs/kit';
// IMPORTED MODULES
import { OpError, run } from '#lib/server/ops/context.js';
import { findProject } from '#lib/server/ops/resolve.js';
import { testingExportTable } from '#lib/server/ops/testing.js';
import { toCsv, toXlsx } from '#lib/server/testing/export.js';
import { orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * The Testing sheet as a file for a member who may read it (AFB-20261127-0438): ?format=csv or xlsx. Data only, from the same
 * visibility-filtered read as the page; a proof is the address of its picture on the board.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { ctx } = await orgContext(locals, params.org, url.pathname);
	const format = url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv';
	try {
		const proj = await run(ctx, (tx) => findProject(tx, ctx, params.project));
		const table = await testingExportTable(ctx, proj.key, url.origin);
		const stamp = new Date().toISOString().slice(0, 10);
		const name = `${proj.key}-test-cases-${stamp}.${format}`;
		const body = format === 'xlsx' ? toXlsx(table) : new TextEncoder().encode(toCsv(table));
		return new Response(body as BodyInit, {
			headers: {
				'content-type':
					format === 'xlsx'
						? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
						: 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="${name}"`,
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (e) {
		if (e instanceof OpError)
			error(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400, e.message);
		throw e;
	}
};
