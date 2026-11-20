// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED DEP-MODULES
import { Readable } from 'node:stream';
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
		// The file goes out as a byte stream with a 2 MiB buffer: Node moves it in large pieces with no per-chunk promise of our
		// own, so a copy of several hundred MB is never held in memory and the connection is kept full. A client that cancels
		// destroys the stream, which closes the stored file
		const body = Readable.toWeb(
			Readable.from(file.stream, { objectMode: false, highWaterMark: 2 * 1024 * 1024 })
		) as unknown as ReadableStream<Uint8Array>;
		return new Response(body, {
			headers: {
				'content-type': 'application/octet-stream',
				// The bytes are already encrypted, so they do not compress. Naming an encoding keeps the proxy (Caddy) from spending
				// CPU on them, and from dropping the Content-Length the download window needs for its progress bar
				'content-encoding': 'identity',
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
