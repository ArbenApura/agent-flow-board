// SHARED FILES: WHICH REPO FILES A CLAIMED SESSION EDITED, AND WHICH OF THEM ANOTHER LIVE SESSION ALSO EDITED (AFB-20261125-1527)
// The tool hook writes one row per session and repo-relative path while the session holds a claim. An agent hears about a
// file another live session of the same project also edited, so it commits only its own hunks. A warning, never a refusal.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { item, session, sessionFile } from '../db/schema';
import { run } from './context';
import { readableProjectIds } from './relatedNotes';

// -- CONSTANTS -- //

/** How long a session's own rows are kept, and how far back the warning looks. */
const KEEP_HOURS = 24;
/** Another session counts as live while it was seen this recently (the stale-claim limit of board_validate). */
export const LIVE_MINUTES = 30;
/** The most shared files one reply names. */
const MAX_SHARED = 10;
const PATH_MAX = 500;

// -- FUNCTIONS -- //

/**
 * The path of an edited file relative to the folder the tool works in, with forward slashes, or null when the file is
 * outside that folder or no folder was sent. A Windows drive letter is compared without case. A local path never leaves
 * this function: what is stored and shown is the part inside the repo.
 */
export function repoRelative(cwd: string | undefined, file: string): string | null {
	if (!cwd || !file) return null;
	const norm = (p: string) =>
		p
			.trim()
			.replaceAll('\\', '/')
			.replace(/\/{2,}/g, '/')
			.replace(/^([a-zA-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
	const root = norm(cwd).replace(/\/+$/, '');
	const path = norm(file);
	// A path the tool already sent relative to the folder
	const rel = /^([a-z]:)?\//.test(path)
		? path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
			? path.slice(root.length + 1)
			: null
		: path.replace(/^\.\//, '');
	if (!rel || rel.startsWith('../') || rel.includes('/../') || rel.length > PATH_MAX) return null;
	return rel;
}

/**
 * Records one edit of a claimed session: one row per session and path, the time moved on a repeat, and this session's rows
 * older than a day removed. Runs inside the hook's own transaction, after the edit was counted.
 */
export async function recordSessionFile(
	tx: Tx,
	ctx: Ctx,
	s: { id: string; claimedItemId: string | null },
	cwd: string | undefined,
	file: string
): Promise<void> {
	if (!s.claimedItemId) return;
	const rel = repoRelative(cwd, file);
	if (!rel) return;
	const [held] = await tx
		.select({ projectId: item.projectId })
		.from(item)
		.where(and(eq(item.id, s.claimedItemId), eq(item.orgId, ctx.orgId)));
	if (!held) return;
	await tx
		.insert(sessionFile)
		.values({
			orgId: ctx.orgId,
			projectId: held.projectId,
			sessionId: s.id,
			itemId: s.claimedItemId,
			path: rel
		})
		.onConflictDoUpdate({
			target: [sessionFile.sessionId, sessionFile.path],
			set: { lastEditedAt: sql`now()`, itemId: s.claimedItemId, projectId: held.projectId }
		});
	// Every row of the project older than a day goes, so a session that ended leaves nothing behind for long
	await tx
		.delete(sessionFile)
		.where(
			and(
				eq(sessionFile.projectId, held.projectId),
				sql`${sessionFile.lastEditedAt} < now() - make_interval(hours => ${KEEP_HOURS})`
			)
		);
}

/**
 * The files this session edited in the last day that another live session of the same project also edited, newest
 * first. The other session's plan is named only when the caller may see it; otherwise it is "another session". Only
 * repo-relative paths are returned, never a person's local folder.
 */
export async function sharedFilesFor(
	ctx: Ctx,
	sessionId: string
): Promise<{ path: string; item: string; editedAt: Date }[]> {
	return run(ctx, async (tx) => {
		// Only projects the caller still reads and the token reaches: an old session id names no other project's files
		const reach = await readableProjectIds(tx, ctx);
		if (!reach.length) return [];
		const projects = sql.join(
			reach.map((p) => sql`${p}::uuid`),
			sql`, `
		);
		const res = await tx.execute(sql`
			select o.path, o.last_edited_at as edited_at,
				(select i.ref from item i where i.id = o.item_id and i.deleted_at is null
					and (i.visibility = 'public' or i.created_by = ${ctx.actor.userId})) as ref
			from ${sessionFile} m
			join ${session} ms on ms.id = m.session_id and ms.user_id = ${ctx.actor.userId}
			join ${sessionFile} o on o.project_id = m.project_id and o.path = m.path and o.session_id <> m.session_id
			join ${session} os on os.id = o.session_id
			where m.session_id = ${sessionId}
				and m.project_id in (${projects})
				and m.last_edited_at > now() - make_interval(hours => ${KEEP_HOURS})
				and o.last_edited_at > now() - make_interval(hours => ${KEEP_HOURS})
				and os.last_seen_at > now() - make_interval(mins => ${LIVE_MINUTES})
			order by o.last_edited_at desc
			limit ${MAX_SHARED * 3}
		`);
		const rows = (
			res as unknown as { rows: { path: string; edited_at: string; ref: string | null }[] }
		).rows;
		// One line per path: the newest other edit of it
		const seen = new Set<string>();
		const out: { path: string; item: string; editedAt: Date }[] = [];
		for (const r of rows) {
			if (seen.has(r.path)) continue;
			seen.add(r.path);
			out.push({ path: r.path, item: r.ref ?? 'another session', editedAt: new Date(r.edited_at) });
			if (out.length >= MAX_SHARED) break;
		}
		return out;
	});
}

/** The sharedFiles part of an agent's reply: nothing for a person, nothing when no file is shared, never a failure. */
export async function sharedFilesNote(ctx: Ctx, sessionId: string | null | undefined) {
	if (!sessionId || ctx.actor.kind !== 'agent') return {};
	try {
		const files = await sharedFilesFor(ctx, sessionId);
		return files.length
			? {
					sharedFiles: files,
					sharedFilesNotice:
						'Another live session of this project edited these files too: stage and commit only your own hunks.'
				}
			: {};
	} catch (e) {
		console.error('sharedFiles failed', e instanceof Error ? e.message : 'unknown error');
		return {};
	}
}
