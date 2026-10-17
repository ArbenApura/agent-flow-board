// THE GITHUB APP CLIENT: A SIGNED APP TOKEN, AN INSTALLATION TOKEN, AND THE FEW GIT DATA CALLS A PUBLISH NEEDS (SPEC 8)
// It uses plain fetch and Web Crypto only, so it runs on a VPS and in a Worker alike. The API address is configurable, so
// the tests run it against a local stand in for GitHub and never touch the real service.

// -- TYPES -- //

export type GithubConfig = {
	/** https://api.github.com, or the address of a test server. */
	apiUrl: string;
	appId: string;
	/** The App private key in PEM form, as GitHub gives it (PKCS#1) or as PKCS#8. */
	privateKey: string;
	webhookSecret?: string;
	/** The App URL name, used for the install link. */
	appSlug?: string;
};
export type RepoInfo = { fullName: string; private: boolean; defaultBranch: string };
export type CommitResult = {
	/** The new commit, or null when nothing differed from what the repo already holds. */
	sha: string | null;
	changed: string[];
	deleted: string[];
};
export interface GithubApi {
	/** When an installation was made, as the App sees it, or null when the App has no such installation. */
	installationCreatedAt(installationId: string): Promise<Date | null>;
	listInstallationRepos(installationId: string): Promise<RepoInfo[]>;
	getRepo(installationId: string, repo: string): Promise<RepoInfo>;
	/** One commit with the files it changed, or null when the repository has no such commit. */
	getCommit(
		installationId: string,
		repo: string,
		sha: string
	): Promise<{ sha: string; message: string; files: string[] } | null>;
	/** The commits of a pull request, newest last. */
	listPullCommits(
		installationId: string,
		repo: string,
		number: number
	): Promise<{ sha: string; message: string }[]>;
	/** A finished check on a commit, shown on the pull request. Warn only: the conclusion is never failure. */
	createCheck(
		installationId: string,
		repo: string,
		sha: string,
		check: { name: string; conclusion: 'success' | 'neutral'; title: string; summary: string }
	): Promise<void>;
	/**
	 * Makes `branch` from the tip of `from` when it does not exist yet. An existing branch is left exactly as it is, so the call is
	 * safe to repeat and to race. Returns whether this call made it.
	 */
	createBranch(
		installationId: string,
		repo: string,
		branch: string,
		from: string
	): Promise<{ created: boolean }>;
	/** Writes `files` (path to text) under `prefix` in one commit and removes files there that are no longer wanted. */
	commitFiles(
		installationId: string,
		repo: string,
		branch: string,
		files: Record<string, string>,
		options: { prefix: string; message: string }
	): Promise<CommitResult>;
}

export class GithubError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** A short outage or a rate limit may work later. A refusal never will. */
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'GithubError';
	}
}

export class GithubRateLimited extends GithubError {
	constructor(readonly retryAfterSeconds: number) {
		super(`GitHub is limiting requests. Trying again in ${retryAfterSeconds} seconds.`, 429, true);
		this.name = 'GithubRateLimited';
	}
}

// -- CONSTANTS -- //

const FETCH_TIMEOUT_MS = 20_000;
const enc = new TextEncoder();

// -- FUNCTIONS -- //

const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

/** DER length bytes. */
function derLength(n: number): number[] {
	if (n < 128) return [n];
	const bytes: number[] = [];
	for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 255);
	return [0x80 | bytes.length, ...bytes];
}

/** Wraps a PKCS#1 RSA key (what GitHub hands out) as PKCS#8, the only form Web Crypto imports. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
	const algorithm = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
	];
	const octet = [0x04, ...derLength(pkcs1.length)];
	const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
	const total = inner.length + pkcs1.length;
	return Uint8Array.from([0x30, ...derLength(total), ...inner, ...pkcs1]);
}

/** Reads a PEM private key in either form into a Web Crypto signing key. */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const text = pem.replace(/\\n/g, '\n');
	const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(text);
	if (!pkcs1 && !/-----BEGIN PRIVATE KEY-----/.test(text))
		throw new Error('GITHUB_APP_PRIVATE_KEY must be a PEM private key.');
	const body = text.replace(/-----(BEGIN|END)[A-Z ]+-----/g, '').replace(/\s+/g, '');
	const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
	return crypto.subtle.importKey(
		'pkcs8',
		(pkcs1 ? pkcs1ToPkcs8(der) : der) as BufferSource,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);
}

/** The short lived token that proves this server is the App (RS256, at most 10 minutes). */
export async function appJwt(config: GithubConfig, nowSeconds = Math.floor(Date.now() / 1000)) {
	const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
	const payload = b64url(
		enc.encode(
			JSON.stringify({ iat: nowSeconds - 30, exp: nowSeconds + 9 * 60, iss: config.appId })
		)
	);
	const key = await importPrivateKey(config.privateKey);
	const sig = new Uint8Array(
		await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`))
	);
	return `${header}.${payload}.${b64url(sig)}`;
}

/** The git blob id of a text, so an unchanged file is recognised without being sent again. */
export async function blobSha(content: string): Promise<string> {
	const body = enc.encode(content);
	const head = enc.encode(`blob ${body.length}\0`);
	const all = new Uint8Array(head.length + body.length);
	all.set(head);
	all.set(body, head.length);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
	return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const repoName = (repo: string) => {
	if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
		throw new GithubError('A repository is written owner/name.', 400, false);
	return repo;
};

/** The most entries, and the most text, one tree call carries. GitHub times out a larger one. */
export const TREE_CHUNK_ENTRIES = 100;
export const TREE_CHUNK_BYTES = 600_000;

/** Splits the entries of one commit into the groups a tree call may carry, in order. */
export function chunkTreeEntries(entries: Record<string, unknown>[]): Record<string, unknown>[][] {
	const chunks: Record<string, unknown>[][] = [];
	let current: Record<string, unknown>[] = [];
	let bytes = 0;
	for (const entry of entries) {
		const size = typeof entry.content === 'string' ? enc.encode(entry.content).length : 0;
		if (
			current.length &&
			(current.length >= TREE_CHUNK_ENTRIES || bytes + size > TREE_CHUNK_BYTES)
		) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(entry);
		bytes += size;
	}
	if (current.length) chunks.push(current);
	return chunks;
}

/** The short reason behind a failed request: the error code when there is one (ECONNRESET, ENOTFOUND), or a timeout. */
function networkReason(e: unknown): string {
	if (e instanceof DOMException && e.name === 'TimeoutError') return 'timed out';
	const cause =
		e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
	return cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : 'unknown error');
}

/** A branch as it goes into a ref URL: each part is encoded, the slashes of a name such as feat/x stay slashes. */
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

/** The client for a real GitHub, or any server that speaks the same few calls. */
export function createGithubApi(config: GithubConfig, fetchImpl: typeof fetch = fetch): GithubApi {
	const api = config.apiUrl.replace(/\/$/, '');
	const tokens = new Map<string, { token: string; expiresAt: number }>();

	async function call<T>(
		method: string,
		path: string,
		auth: string,
		body?: unknown,
		expect: number[] = [200, 201]
	): Promise<T> {
		// A network failure (a reset, a timeout, no route) is not an answer from GitHub: it is said plainly and tried again later
		const res = await fetchImpl(`${api}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${auth}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28',
				'user-agent': 'agent-flow-board',
				...(body !== undefined ? { 'content-type': 'application/json' } : {})
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		}).catch((e: unknown) => {
			throw new GithubError(`GitHub could not be reached (${networkReason(e)}).`, 503, true);
		});
		if (expect.includes(res.status)) return (await res.json()) as T;
		const text = await res.text().catch(() => '');
		let message = '';
		try {
			message = (JSON.parse(text) as { message?: string }).message ?? '';
		} catch {
			/* Not JSON */
		}
		const remaining = res.headers.get('x-ratelimit-remaining');
		const limited =
			res.status === 429 ||
			(res.status === 403 && (remaining === '0' || /rate limit|abuse/i.test(message)));
		if (limited) {
			const retry = Number(res.headers.get('retry-after'));
			const reset = Number(res.headers.get('x-ratelimit-reset'));
			const wait =
				Number.isFinite(retry) && retry > 0
					? retry
					: Number.isFinite(reset) && reset > 0
						? Math.max(1, reset - Math.floor(Date.now() / 1000))
						: 60;
			throw new GithubRateLimited(Math.min(wait, 3600));
		}
		if (res.status === 401)
			throw new GithubError('GitHub did not accept the App credentials.', 401, false);
		if (res.status === 404)
			throw new GithubError(
				'GitHub cannot find that repository for this App. It may have been removed from the installation.',
				404,
				false
			);
		throw new GithubError(
			`GitHub answered ${res.status}${message ? `: ${message}` : ''}`,
			res.status,
			res.status >= 500
		);
	}

	async function installationToken(installationId: string): Promise<string> {
		const hit = tokens.get(installationId);
		if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
		const jwt = await appJwt(config);
		const made = await call<{ token: string; expires_at: string }>(
			'POST',
			`/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
			jwt
		);
		tokens.set(installationId, {
			token: made.token,
			expiresAt: new Date(made.expires_at).getTime()
		});
		return made.token;
	}

	const info = (r: { full_name: string; private: boolean; default_branch: string }): RepoInfo => ({
		fullName: r.full_name,
		private: r.private,
		defaultBranch: r.default_branch
	});

	const client: GithubApi = {
		async installationCreatedAt(installationId) {
			try {
				const jwt = await appJwt(config);
				const made = await call<{ created_at: string }>(
					'GET',
					`/app/installations/${encodeURIComponent(installationId)}`,
					jwt
				);
				const at = new Date(made.created_at);
				return Number.isNaN(at.getTime()) ? null : at;
			} catch (e) {
				if (e instanceof GithubError && e.status === 404) return null;
				throw e;
			}
		},
		async listInstallationRepos(installationId) {
			const token = await installationToken(installationId);
			const res = await call<{ repositories: Parameters<typeof info>[0][] }>(
				'GET',
				'/installation/repositories?per_page=100',
				token
			);
			return res.repositories.map(info);
		},
		async getRepo(installationId, repo) {
			const token = await installationToken(installationId);
			return info(await call('GET', `/repos/${repoName(repo)}`, token));
		},
		async getCommit(installationId, repo, sha) {
			const token = await installationToken(installationId);
			if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) return null;
			try {
				const c = await call<{
					sha: string;
					commit: { message: string };
					files?: { filename: string }[];
				}>('GET', `/repos/${repoName(repo)}/commits/${sha}`, token);
				return {
					sha: c.sha,
					message: c.commit.message,
					files: (c.files ?? []).map((f) => f.filename)
				};
			} catch (e) {
				// A commit GitHub does not know answers 404 (or 422 for a short hash it cannot place)
				if (e instanceof GithubError && (e.status === 404 || e.status === 422)) return null;
				throw e;
			}
		},
		async listPullCommits(installationId, repo, number) {
			const token = await installationToken(installationId);
			const list = await call<{ sha: string; commit: { message: string } }[]>(
				'GET',
				`/repos/${repoName(repo)}/pulls/${number}/commits?per_page=100`,
				token
			);
			return list.map((c) => ({ sha: c.sha, message: c.commit.message }));
		},
		async createCheck(installationId, repo, sha, check) {
			const token = await installationToken(installationId);
			await call('POST', `/repos/${repoName(repo)}/check-runs`, token, {
				name: check.name,
				head_sha: sha,
				status: 'completed',
				conclusion: check.conclusion,
				output: { title: check.title, summary: check.summary }
			});
		},
		async createBranch(installationId, repo, branch, from) {
			const name = repoName(repo);
			const token = await installationToken(installationId);
			// A missing branch (404) or a repository with no commit at all (409) is not an error of the call, it is the answer
			const tip = async (head: string) =>
				call<{ object: { sha: string } }>(
					'GET',
					`/repos/${name}/git/ref/heads/${refPath(head)}`,
					token
				).then(
					(r) => r.object.sha,
					(e) => {
						if (e instanceof GithubError && (e.status === 404 || e.status === 409)) return null;
						throw e;
					}
				);
			if (await tip(branch)) return { created: false };
			const base = await tip(from);
			if (!base)
				throw new GithubError(
					`The repository has no commit on "${from}" yet. Make a first commit there (a README is enough), then connect again.`,
					422,
					false
				);
			try {
				await call('POST', `/repos/${name}/git/refs`, token, {
					ref: `refs/heads/${branch}`,
					sha: base
				});
			} catch (e) {
				// Two connects at the same moment: the branch now exists, which is what was wanted
				if (e instanceof GithubError && e.status === 422 && /already exists/i.test(e.message))
					return { created: false };
				throw e;
			}
			return { created: true };
		},
		async commitFiles(installationId, repo, branch, files, options) {
			const name = repoName(repo);
			const token = await installationToken(installationId);
			const prefix = options.prefix.replace(/^\/+|\/+$/g, '');
			// An empty folder would make every file of the repository look like part of the export, and delete it
			if (!prefix)
				throw new GithubError('A publish needs a folder inside the repository.', 422, false);
			const base = await call<{ object: { sha: string } }>(
				'GET',
				`/repos/${name}/git/ref/heads/${refPath(branch)}`,
				token
			).catch((e) => {
				if (e instanceof GithubError && e.status === 404)
					throw new GithubError(
						`The branch "${branch}" does not exist yet. Make a first commit on it (a README is enough), then publish again.`,
						404,
						false
					);
				throw e;
			});
			const parent = base.object.sha;
			const commit = await call<{ tree: { sha: string } }>(
				'GET',
				`/repos/${name}/git/commits/${parent}`,
				token
			);
			const existing = await call<{
				tree: { path: string; type: string; sha: string }[];
				truncated?: boolean;
			}>('GET', `/repos/${name}/git/trees/${commit.tree.sha}?recursive=1`, token);
			if (existing.truncated)
				throw new GithubError(
					'The repository tree is too large to compare in one call. Publish into a smaller repository.',
					422,
					false
				);
			const here = new Map(
				existing.tree
					.filter((t) => t.type === 'blob' && (prefix === '' || t.path.startsWith(`${prefix}/`)))
					.map((t) => [t.path, t.sha])
			);
			const entries: Record<string, unknown>[] = [];
			const changed: string[] = [];
			const wanted = new Set<string>();
			for (const [rel, content] of Object.entries(files)) {
				const path = prefix ? `${prefix}/${rel}` : rel;
				wanted.add(path);
				if (here.get(path) === (await blobSha(content))) continue;
				changed.push(path);
				entries.push({ path, mode: '100644', type: 'blob', content });
			}
			const deleted: string[] = [];
			for (const path of here.keys()) {
				if (wanted.has(path)) continue;
				deleted.push(path);
				entries.push({ path, mode: '100644', type: 'blob', sha: null });
			}
			if (!entries.length) return { sha: null, changed: [], deleted: [] };
			// GitHub answers 422 "request timed out" to one tree call that carries a whole project. The entries go in chunks, each
			// built on the tree the one before it made, so the last tree holds all of them
			let treeSha = commit.tree.sha;
			for (const chunk of chunkTreeEntries(entries)) {
				const part = await call<{ sha: string }>('POST', `/repos/${name}/git/trees`, token, {
					base_tree: treeSha,
					tree: chunk
				});
				treeSha = part.sha;
			}
			const made = await call<{ sha: string }>('POST', `/repos/${name}/git/commits`, token, {
				message: options.message,
				tree: treeSha,
				parents: [parent]
			});
			await call('PATCH', `/repos/${name}/git/refs/heads/${refPath(branch)}`, token, {
				sha: made.sha,
				force: false
			});
			return { sha: made.sha, changed, deleted };
		}
	};
	// A branch that moved while the commit was being made is read again and committed again, up to three times: a person pushing
	// to the repository at the same moment is not a failed publish
	return {
		...client,
		async commitFiles(installationId, repo, branch, files, options) {
			for (let attempt = 1; ; attempt++) {
				try {
					return await client.commitFiles(installationId, repo, branch, files, options);
				} catch (e) {
					const moved =
						e instanceof GithubError && e.status === 422 && /fast.?forward/i.test(e.message);
					if (!moved || attempt >= 3) throw e;
				}
			}
		}
	};
}
