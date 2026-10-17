// A STAND IN FOR GITHUB FOR THE TESTS: THE FEW APP AND GIT DATA CALLS A PUBLISH USES, KEPT IN MEMORY, PLUS CONTROL CALLS
// Used by the unit tests (as a fetch function) and by the browser checks (as a small server, tests/runner/github-mock.mjs).
// It checks nothing about the App token except that one was sent, and it never talks to the network.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const blobId = (content) => sha1(`blob ${Buffer.byteLength(content)}\0${content}`);
const json = (status, body, headers = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

/** Signs a webhook body the way GitHub does, for tests that send events to the app. */
export const signWebhook = (secret, body) =>
	'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

export function createGithubMock() {
	/** @type {Map<string, {private: boolean, branch: string, refs: Map<string,string>, commits: Map<string,{tree:string,parents:string[],message:string}>, trees: Map<string, Map<string,string>>, blobs: Map<string,string>}>} */
	const repos = new Map();
	const calls = [];
	/** Commits a test seeds for evidence and push checks: repo to sha to { message, files, author }. */
	const known = new Map();
	/** Pull requests a test seeds: repo#number to the shas it holds. */
	const pulls = new Map();
	/** Check runs the app created. */
	const checks = [];
	const limits = { rate: 0, rateStatus: 403, retryAfter: 1, fail: 0, failStatus: 502 };

	function seed(
		fullName,
		{ private: isPrivate = true, branch = 'main', files = {}, empty = false } = {}
	) {
		const repo = {
			private: isPrivate,
			branch,
			refs: new Map(),
			commits: new Map(),
			trees: new Map(),
			blobs: new Map()
		};
		repos.set(fullName, repo);
		if (!empty) {
			const tree = new Map();
			for (const [path, content] of Object.entries(files)) {
				const id = blobId(content);
				repo.blobs.set(id, content);
				tree.set(path, id);
			}
			if (!tree.size) {
				repo.blobs.set(blobId('# Hello\n'), '# Hello\n');
				tree.set('README.md', blobId('# Hello\n'));
			}
			const treeId = sha1([...tree].sort().join('\n'));
			repo.trees.set(treeId, tree);
			const commit = sha1(`init ${randomBytes(6).toString('hex')}`);
			repo.commits.set(commit, { tree: treeId, parents: [], message: 'Initial commit' });
			repo.refs.set(branch, commit);
		}
		return repo;
	}

	/** The files at the tip of a branch (the default branch when none is named). */
	const filesOf = (fullName, branch) => {
		const repo = repos.get(fullName);
		const out = {};
		if (!repo) return out;
		const head = repo.refs.get(branch ?? repo.branch);
		if (!head) return out;
		for (const [path, id] of repo.trees.get(repo.commits.get(head).tree))
			out[path] = repo.blobs.get(id);
		return out;
	};

	async function handle(request) {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// -- control calls, never counted and never limited -- //
		if (path.startsWith('/__mock/')) {
			if (path === '/__mock/repo' && method === 'POST') {
				const body = await request.json();
				seed(body.fullName, body);
				return json(200, { ok: true });
			}
			if (path === '/__mock/files') {
				const repo = repos.get(url.searchParams.get('repo') ?? '');
				if (!repo) return json(404, { message: 'Not found' });
				const commits = [];
				for (
					let c = repo.refs.get(url.searchParams.get('branch') ?? repo.branch);
					c;
					c = repo.commits.get(c)?.parents[0]
				)
					commits.push({ sha: c, message: repo.commits.get(c).message });
				return json(200, {
					files: filesOf(url.searchParams.get('repo'), url.searchParams.get('branch') ?? undefined),
					commits
				});
			}
			if (path === '/__mock/visibility' && method === 'POST') {
				const body = await request.json();
				const repo = repos.get(body.fullName);
				if (!repo) return json(404, { message: 'Not found' });
				repo.private = body.private;
				return json(200, { ok: true });
			}
			if (path === '/__mock/limit' && method === 'POST') {
				const body = await request.json();
				limits.rate = body.count ?? 0;
				limits.rateStatus = body.status ?? 403;
				limits.retryAfter = body.retryAfter ?? 1;
				return json(200, { ok: true });
			}
			if (path === '/__mock/fail' && method === 'POST') {
				const body = await request.json();
				limits.fail = body.count ?? 0;
				limits.failStatus = body.status ?? 502;
				return json(200, { ok: true });
			}
			if (path === '/__mock/commit' && method === 'POST') {
				const body = await request.json();
				if (!known.has(body.repo)) known.set(body.repo, new Map());
				known.get(body.repo).set(body.sha, {
					message: body.message ?? 'A commit',
					files: body.files ?? [],
					author: body.author ?? 'dev@example.com'
				});
				return json(200, { ok: true });
			}
			if (path === '/__mock/pull' && method === 'POST') {
				const body = await request.json();
				pulls.set(`${body.repo}#${body.number}`, body.shas);
				return json(200, { ok: true });
			}
			if (path === '/__mock/checks') return json(200, { checks });
			if (path === '/__mock/calls') return json(200, { calls });
			if (path === '/__mock/reset' && method === 'POST') {
				repos.clear();
				known.clear();
				pulls.clear();
				checks.length = 0;
				calls.length = 0;
				limits.rate = 0;
				limits.fail = 0;
				return json(200, { ok: true });
			}
			return json(404, { message: 'No such control call' });
		}

		calls.push(`${method} ${path}`);
		if (!/^Bearer \S+/.test(request.headers.get('authorization') ?? ''))
			return json(401, { message: 'Bad credentials' });
		if (limits.rate > 0) {
			limits.rate--;
			return json(
				limits.rateStatus,
				{ message: 'You have exceeded a secondary rate limit.' },
				{ 'retry-after': String(limits.retryAfter), 'x-ratelimit-remaining': '0' }
			);
		}
		if (limits.fail > 0) {
			limits.fail--;
			return json(limits.failStatus, { message: 'Server Error' });
		}

		let m;
		if (/^\/app\/installations\/([^/]+)$/.test(path) && method === 'GET') {
			return json(200, { id: Number(path.split('/').pop()), created_at: new Date().toISOString() });
		}
		if (/^\/app\/installations\/([^/]+)\/access_tokens$/.test(path) && method === 'POST') {
			return json(201, {
				token: `ghs_${randomBytes(8).toString('hex')}`,
				expires_at: new Date(Date.now() + 3_600_000).toISOString()
			});
		}
		if (path === '/installation/repositories') {
			return json(200, {
				repositories: [...repos].map(([full_name, r]) => ({
					full_name,
					private: r.private,
					default_branch: r.branch
				}))
			});
		}
		if (
			(m = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-fA-F]+)$/)) &&
			method === 'GET'
		) {
			const found = [...(known.get(m[1]) ?? [])].find(([sha]) =>
				sha.startsWith(m[2].toLowerCase())
			);
			if (!found) return json(404, { message: 'No commit found for SHA' });
			return json(200, {
				sha: found[0],
				commit: { message: found[1].message },
				files: found[1].files.map((filename) => ({ filename }))
			});
		}
		if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/commits$/)) && method === 'GET') {
			const shas = pulls.get(`${m[1]}#${m[2]}`);
			if (!shas) return json(404, { message: 'Not Found' });
			return json(
				200,
				shas.map((sha) => ({ sha, commit: { message: known.get(m[1])?.get(sha)?.message ?? '' } }))
			);
		}
		if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/check-runs$/)) && method === 'POST') {
			const body = await request.json();
			checks.push({ repo: m[1], ...body });
			return json(201, { id: checks.length });
		}
		if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)$/)) && method === 'GET') {
			const r = repos.get(m[1]);
			if (!r) return json(404, { message: 'Not Found' });
			return json(200, { full_name: m[1], private: r.private, default_branch: r.branch });
		}
		if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/(ref|commits|trees|refs)(?:\/(.*))?$/))) {
			const repo = repos.get(m[1]);
			if (!repo) return json(404, { message: 'Not Found' });
			const [, , kind, rest] = m;
			if (kind === 'ref' && method === 'GET') {
				const branch = decodeURIComponent((rest ?? '').replace(/^heads\//, ''));
				const sha = repo.refs.get(branch);
				return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
			}
			if (kind === 'commits' && method === 'GET') {
				const c = repo.commits.get(rest ?? '');
				return c
					? json(200, { sha: rest, tree: { sha: c.tree } })
					: json(404, { message: 'Not Found' });
			}
			if (kind === 'trees' && method === 'GET') {
				const tree = repo.trees.get(rest ?? '');
				if (!tree) return json(404, { message: 'Not Found' });
				return json(200, {
					sha: rest,
					truncated: false,
					tree: [...tree].map(([p, sha]) => ({ path: p, type: 'blob', mode: '100644', sha }))
				});
			}
			if (kind === 'trees' && method === 'POST') {
				const body = await request.json();
				const base = new Map(repo.trees.get(body.base_tree) ?? []);
				for (const e of body.tree) {
					if (e.sha === null) base.delete(e.path);
					else {
						const id = blobId(e.content);
						repo.blobs.set(id, e.content);
						base.set(e.path, id);
					}
				}
				const treeId = sha1([...base].sort().join('\n'));
				repo.trees.set(treeId, base);
				return json(201, { sha: treeId });
			}
			if (kind === 'commits' && method === 'POST') {
				const body = await request.json();
				const sha = sha1(`${body.tree}${body.message}${randomBytes(6).toString('hex')}`);
				repo.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
				return json(201, { sha });
			}
			if (kind === 'refs' && method === 'POST') {
				const body = await request.json();
				const branch = String(body.ref ?? '').slice('refs/heads/'.length);
				if (repo.refs.has(branch)) return json(422, { message: 'Reference already exists' });
				if (!repo.commits.has(body.sha)) return json(422, { message: 'Object does not exist' });
				repo.refs.set(branch, body.sha);
				return json(201, { ref: body.ref, object: { sha: body.sha } });
			}
			if (kind === 'refs' && method === 'PATCH') {
				const body = await request.json();
				const branch = decodeURIComponent((rest ?? '').replace(/^heads\//, ''));
				if (!repo.commits.has(body.sha)) return json(422, { message: 'Object does not exist' });
				repo.refs.set(branch, body.sha);
				return json(200, { object: { sha: body.sha } });
			}
		}
		return json(404, { message: `Not implemented in the mock: ${method} ${path}` });
	}

	return {
		handle,
		seed,
		filesOf,
		repos,
		calls,
		limits,
		fetch: (input, init) => handle(new Request(input, init))
	};
}

/** Serves a mock on a port, for the browser checks. */
export function startGithubMock(port) {
	const mock = createGithubMock();
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		const out = await mock.handle(
			new Request(`http://localhost:${port}${req.url}`, {
				method: req.method,
				headers: req.headers,
				body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
			})
		);
		res.writeHead(out.status, Object.fromEntries(out.headers));
		res.end(Buffer.from(await out.arrayBuffer()));
	});
	return new Promise((resolve) => server.listen(port, () => resolve({ server, mock })));
}
