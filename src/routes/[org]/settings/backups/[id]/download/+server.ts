// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED MODULES
import { OpError } from '#lib/server/ops/context.js';
import { backupDownload } from '#lib/server/ops/settings.js';
import { orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * One finished backup as the encrypted file it is stored as, for an admin or owner of the organisation. The size is sent first,
 * so the download window can show real progress. The file is never decrypted here.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { ctx } = await orgContext(locals, params.org, url.pathname);
	try {
		const file = await backupDownload(ctx, params.id);
		const chunks = file.stream[Symbol.asyncIterator]();
		// The stream is pulled one chunk at a time, so a copy of several hundred MB is never held in memory
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const next = await chunks.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			async cancel() {
				await chunks.return?.();
			}
		});
		return new Response(body, {
			headers: {
				'content-type': 'application/octet-stream',
				'content-length': String(file.size),
				'content-disposition': `attachment; filename="${file.filename}"`,
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (e) {
		if (e instanceof OpError) {
			const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
			return new Response(e.message, { status, headers: { 'cache-control': 'no-store' } });
		}
		throw e;
	}
};
