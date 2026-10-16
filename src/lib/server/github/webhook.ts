// GITHUB WEBHOOKS: SIGNATURE CHECK AND THE FEW EVENTS THAT CHANGE WHAT A PUBLISH MAY DO (SPEC 8)
// GitHub sends the installation id and no org, so the first step is the small github_installation table. After that
// every write runs inside that org's own tenant.

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { GithubApi } from './app';
import type { PushCommit } from './commits';
// -- DEP-MODULES -- //
import { and, eq, inArray, sql } from 'drizzle-orm';
// -- MODULES -- //
import { githubInstallation, githubLink, publishRun } from '../db/schema';
import { withTenant } from '../db/tenant';
import { checkPullRequest, linkCommits } from './commits';

// -- TYPES -- //

type Payload = {
	action?: string;
	installation?: { id?: number | string };
	repositories_removed?: { full_name: string }[];
	repository?: { full_name?: string; private?: boolean };
	ref?: string;
	commits?: PushCommit[];
	number?: number;
	pull_request?: { number?: number; head?: { sha?: string } };
};

// -- CONSTANTS -- //

export const REMOVED_REASON =
	'The GitHub App was removed from this repository or suspended. Install it again, then connect the repository.';

// -- FUNCTIONS -- //

const enc = new TextEncoder();

/** True when `header` is GitHub's HMAC SHA-256 of the raw body under the shared secret. Constant time. */
export async function verifySignature(
	secret: string,
	rawBody: string,
	header: string | null
): Promise<boolean> {
	if (!header || !header.startsWith('sha256=')) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const want = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
	const hex = header.slice('sha256='.length);
	if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
	const got = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
	let diff = 0;
	for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
	return diff === 0;
}

/** Applies one event. Unknown events and unknown installations are accepted and ignored. */
export async function handleWebhook(
	handle: DbHandle,
	event: string,
	payload: Payload,
	deps: { github?: GithubApi } = {}
): Promise<{ handled: boolean; detail: string }> {
	if (event === 'ping') return { handled: true, detail: 'pong' };
	const installationId =
		payload.installation?.id !== undefined ? String(payload.installation.id) : null;
	if (!installationId) return { handled: false, detail: 'no installation' };
	const [known] = await withTenant(handle, { installationId }, (tx) =>
		tx
			.select()
			.from(githubInstallation)
			.where(eq(githubInstallation.installationId, installationId))
	);
	if (!known) return { handled: false, detail: 'unknown installation' };
	const orgId = known.orgId;

	const pause = (where: ReturnType<typeof and>) =>
		withTenant(handle, { orgId }, async (tx) => {
			const links = await tx
				.update(githubLink)
				.set({ pausedReason: REMOVED_REASON, autoPublish: false, updatedAt: sql`now()` })
				.where(where)
				.returning({ projectId: githubLink.projectId });
			if (links.length)
				await tx
					.update(publishRun)
					.set({ state: 'cancelled', message: REMOVED_REASON, updatedAt: sql`now()` })
					.where(
						and(
							eq(publishRun.state, 'pending'),
							inArray(
								publishRun.projectId,
								links.map((l) => l.projectId)
							)
						)
					);
			return links.length;
		});

	if (event === 'installation') {
		if (payload.action === 'deleted' || payload.action === 'suspend') {
			const n = await pause(eq(githubLink.installationId, installationId));
			if (payload.action === 'deleted')
				await withTenant(handle, { orgId }, (tx) =>
					tx.delete(githubInstallation).where(eq(githubInstallation.installationId, installationId))
				);
			return { handled: true, detail: `paused ${n}` };
		}
		if (payload.action === 'unsuspend') {
			// The person turns automatic publish back on by hand, so nothing is switched on here
			const n = await withTenant(
				handle,
				{ orgId },
				async (tx) =>
					(
						await tx
							.update(githubLink)
							.set({ pausedReason: null, updatedAt: sql`now()` })
							.where(
								and(
									eq(githubLink.installationId, installationId),
									eq(githubLink.pausedReason, REMOVED_REASON)
								)
							)
							.returning({ id: githubLink.id })
					).length
			);
			return { handled: true, detail: `resumed ${n}` };
		}
		return { handled: true, detail: 'ignored' };
	}
	if (event === 'push' && payload.repository?.full_name) {
		const repo = payload.repository.full_name;
		return withTenant(handle, { orgId }, async (tx) => {
			const [link] = await tx
				.select()
				.from(githubLink)
				.where(and(eq(githubLink.installationId, installationId), eq(githubLink.repo, repo)));
			if (!link) return { handled: true, detail: 'no linked project' };
			const branch = payload.ref?.startsWith('refs/heads/') ? payload.ref.slice(11) : null;
			const r = await linkCommits(tx, link, payload.commits ?? [], branch);
			return { handled: true, detail: `linked ${r.linked}, unmatched ${r.unmatched}` };
		});
	}
	if (
		event === 'pull_request' &&
		['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(payload.action ?? '') &&
		payload.repository?.full_name &&
		payload.pull_request?.number &&
		payload.pull_request.head?.sha &&
		deps.github
	) {
		const repo = payload.repository.full_name;
		const pr = { number: payload.pull_request.number, headSha: payload.pull_request.head.sha };
		const github = deps.github;
		return withTenant(handle, { orgId }, async (tx) => {
			const [link] = await tx
				.select()
				.from(githubLink)
				.where(and(eq(githubLink.installationId, installationId), eq(githubLink.repo, repo)));
			if (!link) return { handled: true, detail: 'no linked project' };
			const r = await checkPullRequest(tx, github, link, pr);
			return { handled: true, detail: `check ${r.conclusion}` };
		});
	}
	if (event === 'installation_repositories' && payload.action === 'removed') {
		const names = (payload.repositories_removed ?? []).map((r) => r.full_name);
		if (!names.length) return { handled: true, detail: 'nothing removed' };
		const n = await pause(
			and(eq(githubLink.installationId, installationId), inArray(githubLink.repo, names))
		);
		return { handled: true, detail: `paused ${n}` };
	}
	if (
		event === 'repository' &&
		(payload.action === 'publicized' || payload.action === 'privatized') &&
		payload.repository?.full_name
	) {
		const visibility = payload.action === 'publicized' ? 'public' : 'private';
		const n = await withTenant(
			handle,
			{ orgId },
			async (tx) =>
				(
					await tx
						.update(githubLink)
						.set({ repoVisibility: visibility, updatedAt: sql`now()` })
						.where(
							and(
								eq(githubLink.installationId, installationId),
								eq(githubLink.repo, payload.repository!.full_name!)
							)
						)
						.returning({ id: githubLink.id })
				).length
		);
		return { handled: true, detail: `${visibility} ${n}` };
	}
	return { handled: true, detail: 'ignored' };
}
