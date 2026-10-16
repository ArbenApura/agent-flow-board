// LINKING COMMITS TO ITEMS FROM PUSH WEBHOOKS, AND THE PULL REQUEST CHECK FOR UNRECORDED WORK (SPEC 9.4, L20, L21, L24)
// A commit links by an item reference in its message first, then by the claim of the session of the person who made it, and
// never by the branch name alone. A commit with an item and no recorded step is unrecorded work. The check only warns.

// -- TYPES -- //
import type { Tx } from '../db/client';
import type { Ctx } from '../ops/context';
import type { GithubApi } from './app';
// -- DEP-MODULES -- //
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
// -- MODULES -- //
import { commitLink, githubLink, item, session, step, user } from '../db/schema';
import { findItem } from '../ops/resolve';

// -- TYPES -- //

export type PushCommit = {
	id: string;
	message: string;
	timestamp?: string;
	author?: { email?: string };
	added?: string[];
	modified?: string[];
	removed?: string[];
};
type Link = typeof githubLink.$inferSelect;

// -- CONSTANTS -- //

/** A session counts as working at the time of a commit when it was seen within this long before it. */
const CLAIM_WINDOW_MS = 30 * 60_000;
const TRAILER = /^(?:board-item|items?|refs?|closes|fixes)\s*:\s*(.+)$/gim;
const TOKEN = /[A-Za-z][A-Za-z0-9]{1,9}-[A-Za-z0-9][A-Za-z0-9-]{0,30}/g;

// -- FUNCTIONS -- //

/** The item references a commit message names: trailer lines first, then a bracket at the end of the subject. */
export function trailerRefs(message: string): string[] {
	const found: string[] = [];
	for (const m of message.matchAll(TRAILER)) for (const t of m[1].match(TOKEN) ?? []) found.push(t);
	const subject = message.split('\n')[0] ?? '';
	const paren = /\(([^()]+)\)\s*$/.exec(subject);
	if (paren) for (const t of paren[1].match(TOKEN) ?? []) found.push(t);
	return [...new Set(found)];
}

async function resolveRef(tx: Tx, orgId: string, refs: string[], projectId: string) {
	for (const name of refs) {
		try {
			const it = await findItem(tx, { orgId } as Ctx, name);
			if (it.projectId === projectId) return it;
		} catch {
			/* Not an item of this org */
		}
	}
	return null;
}

/** The item a person's active session claims in this project around the time of a commit. */
async function claimedFor(tx: Tx, projectId: string, email: string | undefined, at: Date) {
	if (!email) return null;
	const rows = await tx
		.select({ itemId: item.id, ref: item.ref })
		.from(session)
		.innerJoin(item, eq(item.id, session.claimedItemId))
		.innerJoin(user, eq(user.id, session.userId))
		.where(
			and(
				eq(item.projectId, projectId),
				sql`lower(${user.email}) = lower(${email})`,
				sql`${session.createdAt} <= ${at}`,
				gt(session.lastSeenAt, new Date(at.getTime() - CLAIM_WINDOW_MS))
			)
		)
		.orderBy(desc(session.lastSeenAt))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Stores the commits of a push. Already known commits are left alone. Runs inside the org's tenant, with the project of the
 * linked repository.
 */
export async function linkCommits(
	tx: Tx,
	link: Link,
	commits: PushCommit[],
	branch: string | null
): Promise<{ linked: number; unmatched: number }> {
	let linked = 0;
	let unmatched = 0;
	for (const c of commits) {
		const at = c.timestamp ? new Date(c.timestamp) : new Date();
		const files = [...new Set([...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])])];
		let it = await resolveRef(tx, link.orgId, trailerRefs(c.message), link.projectId);
		let matchedBy: 'trailer' | 'claim' | 'none' = it ? 'trailer' : 'none';
		if (!it) {
			const claimed = await claimedFor(tx, link.projectId, c.author?.email, at);
			if (claimed) {
				it = (await findItem(tx, { orgId: link.orgId } as Ctx, claimed.itemId)) ?? null;
				matchedBy = it ? 'claim' : 'none';
			}
		}
		// A step already recorded with this commit as its evidence means the work is recorded
		let recorded = false;
		if (it) {
			const [hit] = await tx
				.select({ id: step.id })
				.from(step)
				.where(
					and(
						eq(step.itemId, it.id),
						sql`${step.evidence}->>'commit' is not null and ${c.id} like (${step.evidence}->>'commit') || '%'`
					)
				)
				.limit(1);
			recorded = Boolean(hit);
		}
		const inserted = await tx
			.insert(commitLink)
			.values({
				orgId: link.orgId,
				projectId: link.projectId,
				itemId: it?.id ?? null,
				sha: c.id.toLowerCase(),
				repo: link.repo,
				message: c.message.slice(0, 2000),
				authorEmail: c.author?.email ?? null,
				branch,
				committedAt: at,
				files,
				matchedBy,
				recorded
			})
			.onConflictDoNothing()
			.returning({ id: commitLink.id });
		if (!inserted.length) continue;
		if (it) linked++;
		else unmatched++;
	}
	return { linked, unmatched };
}

/** The text of the pull request check, and whether anything needs saying. */
export function checkSummary(
	rows: { sha: string; itemRef: string | null; recorded: boolean }[],
	unknown: string[]
) {
	const lines: string[] = [];
	for (const r of rows) {
		if (!r.itemRef)
			lines.push(
				`- ${r.sha.slice(0, 7)} is not linked to any item. Name one in the message (Item: CKT-12) or claim it before committing.`
			);
		else if (!r.recorded)
			lines.push(
				`- ${r.sha.slice(0, 7)} belongs to ${r.itemRef} but no step was recorded since. Record it with step_done.`
			);
	}
	for (const sha of unknown) lines.push(`- ${sha.slice(0, 7)} has not been seen by the board yet.`);
	return {
		conclusion: lines.length ? ('neutral' as const) : ('success' as const),
		title: lines.length ? 'Some commits are not recorded on the board' : 'Every commit is recorded',
		summary: lines.length
			? `${lines.join('\n')}\n\nThis check only warns. It never blocks a merge.`
			: 'Every commit of this pull request belongs to an item with recorded progress.'
	};
}

/** Looks at a pull request's commits and posts a warn-only check. */
export async function checkPullRequest(
	tx: Tx,
	github: GithubApi,
	link: Link,
	pr: { number: number; headSha: string }
): Promise<{ posted: boolean; conclusion: string }> {
	const commits = await github.listPullCommits(link.installationId, link.repo, pr.number);
	const shas = commits.map((c) => c.sha.toLowerCase());
	const rows = shas.length
		? await tx
				.select({
					sha: commitLink.sha,
					recorded: commitLink.recorded,
					itemId: commitLink.itemId
				})
				.from(commitLink)
				.where(and(eq(commitLink.projectId, link.projectId), inArray(commitLink.sha, shas)))
		: [];
	const refs = new Map<string, string>();
	const ids = rows.map((r) => r.itemId).filter((v): v is string => !!v);
	if (ids.length)
		for (const r of await tx
			.select({ id: item.id, ref: item.ref })
			.from(item)
			.where(inArray(item.id, ids)))
			refs.set(r.id, r.ref);
	const seen = new Set(rows.map((r) => r.sha));
	const summary = checkSummary(
		rows.map((r) => ({
			sha: r.sha,
			itemRef: r.itemId ? (refs.get(r.itemId) ?? null) : null,
			recorded: r.recorded
		})),
		shas.filter((s) => !seen.has(s))
	);
	await github.createCheck(link.installationId, link.repo, pr.headSha, {
		name: 'Board record',
		conclusion: summary.conclusion,
		title: summary.title,
		summary: summary.summary
	});
	return { posted: true, conclusion: summary.conclusion };
}
