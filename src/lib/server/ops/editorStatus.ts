// THE INSTALL PLAN FOR THE EDITOR STATUS, FOR THE CALLER'S OWN ORGANISATION (AFB-20261108-0427, C.1)
// The organisation comes from the connection the call arrived on (ctx.orgId), never from an argument. The caller needs the read
// permission. Nothing returned is a secret: the plan is a constant template and the files are the mod's public source.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { apiToken, org } from '../db/schema';
import { MOD_PART, installPlan, servedModFile } from '../editor-status';
import { pageText } from '../system-skills/plan';
import { OpError, requireCap, run } from './context';
import { BRIDGE_CLIENT } from './environments';

// -- TYPES -- //

export const editorStatusInstallInput = z.object({
	/** One file of the mod, by the path the plan lists. Without it the answer is the plan. */
	file: z.string().min(1).max(200).optional(),
	offset: z.number().int().min(0).optional()
});

/**
 * Whether this person's bridge is signed in to the organisation of the call: the newest sign in the bridge made as a device token.
 * `expired` means there was one and it ended, so the prompt must be run again. Dates only: no token, prefix or hash comes back.
 */
export type BridgeSignIn = {
	state: 'signed-in' | 'expired' | 'none';
	lastUsedAt: string | null;
	expiresAt: string | null;
};

// -- FUNCTIONS -- //

export async function bridgeSignIn(ctx: Ctx): Promise<BridgeSignIn> {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const [row] = await tx
			.select({ expiresAt: apiToken.expiresAt, lastUsedAt: apiToken.lastUsedAt })
			.from(apiToken)
			.where(
				and(
					eq(apiToken.orgId, ctx.orgId),
					eq(apiToken.userId, ctx.actor.userId),
					eq(apiToken.kind, 'device'),
					eq(apiToken.name, BRIDGE_CLIENT),
					isNull(apiToken.revokedAt)
				)
			)
			.orderBy(desc(apiToken.createdAt))
			.limit(1);
		if (!row) return { state: 'none' as const, lastUsedAt: null, expiresAt: null };
		return {
			state: row.expiresAt.getTime() > Date.now() ? ('signed-in' as const) : ('expired' as const),
			lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
			expiresAt: row.expiresAt.toISOString()
		};
	});
}

export async function editorStatusInstall(ctx: Ctx, raw: z.input<typeof editorStatusInstallInput>) {
	const input = editorStatusInstallInput.parse(raw);
	const slug = await run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'read');
		const [row] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, ctx.orgId));
		return row?.slug ?? null;
	});
	if (!slug) throw new OpError('NOT_FOUND', 'Not found.');
	const server = ctx.services?.baseUrl;
	// Missing configuration fails loudly: a plain error is an internal error to the caller, never an invented address
	if (!server) throw new Error('The board address is not configured.');
	if (!input.file) return installPlan({ slug, server });

	const file = servedModFile(input.file);
	if (!file) throw new OpError('NOT_FOUND', 'No such mod file.');
	let part: { text: string; next: number | null };
	try {
		part = pageText(file.text, input.offset ?? 0, MOD_PART);
	} catch (e) {
		throw new OpError('INVALID', e instanceof Error ? e.message : 'The offset is not valid.');
	}
	return {
		file: file.path,
		total: file.text.length,
		bytes: file.bytes,
		// The checksum of the whole file, on every part
		sha256: file.sha256,
		offset: input.offset ?? 0,
		text: part.text,
		next: part.next
	};
}
