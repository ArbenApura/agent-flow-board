// PHASE 8: THE GITHUB APP CLIENT, THE EXPORT, PUBLISH NOW AND LATER, CANCEL BY STATE, RETRIES, PAUSE, PRIVACY AND WEBHOOKS
// GitHub is a stand in server kept in memory (tests/support/githubMock.mjs). Nothing here touches the network.

// -- DEP-MODULES -- //
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { memoryJobs } from '../../src/lib/server/adapters/jobs';
import { addAttachment, setAttachmentVisibility } from '../../src/lib/server/ops/attachments';
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { upsertDecision, upsertSection } from '../../src/lib/server/ops/docs';
import { createItem, updateItem } from '../../src/lib/server/ops/items';
import { recordSteps } from '../../src/lib/server/ops/steps';
import { githubLink, publishRun } from '../../src/lib/server/db/schema';
import { withTenant } from '../../src/lib/server/db/tenant';
import {
	TREE_CHUNK_ENTRIES,
	appJwt,
	blobSha,
	chunkTreeEntries,
	createGithubApi,
	pkcs1ToPkcs8
} from '../../src/lib/server/github/app';
import { renderExport, loadPublishable, diffHashes } from '../../src/lib/server/github/export';
import { DEFAULT_PUBLISH_BRANCH, isGitBranchName } from '../../src/lib/board/gitBranch';
import { appManifest, signState, verifyState } from '../../src/lib/server/github/install';
import { SCHEDULE_JOB, registerPublishJobs } from '../../src/lib/server/github/jobs';
import {
	DEFAULT_BRANCH_REFUSAL,
	FAILURES_BEFORE_PAUSE,
	cancelPublish,
	linkRepo,
	nextAllowed,
	previewPublish,
	publishState,
	requestPublish,
	scheduleAutoPublish,
	setPublishSettings,
	unlinkRepo
} from '../../src/lib/server/github/publish';
import {
	REMOVED_REASON,
	handleWebhook,
	verifySignature
} from '../../src/lib/server/github/webhook';
import { run } from '../../src/lib/server/ops/context';
import { createGithubMock, signWebhook } from '../support/githubMock.mjs';
import { makePglite, makePostgres, type TestDb } from '../support/db';
import { PLAN, makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PKCS1 = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const INSTALL = '4242';

// -- FUNCTIONS -- //

describe('the GitHub App client', () => {
	it('signs a token GitHub can verify, from a PKCS#1 key (as GitHub gives it) or a PKCS#8 key', async () => {
		for (const pem of [PKCS1, PKCS8, PKCS1.replace(/\n/g, '\\n')]) {
			const jwt = await appJwt({ apiUrl: 'x', appId: '777', privateKey: pem }, 1_000_000);
			const [h, p, s] = jwt.split('.');
			const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
			expect(payload).toMatchObject({ iss: '777', iat: 999_970, exp: 1_000_540 });
			expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
				alg: 'RS256',
				typ: 'JWT'
			});
			const ok = createVerify('RSA-SHA256')
				.update(`${h}.${p}`)
				.verify(createPublicKey(PKCS8), Buffer.from(s, 'base64url'));
			expect(ok).toBe(true);
		}
		expect(pkcs1ToPkcs8(Buffer.from('x'.repeat(300))).length).toBeGreaterThan(300);
		await expect(appJwt({ apiUrl: 'x', appId: '1', privateKey: 'nope' })).rejects.toThrow(/PEM/);
	});

	it('computes the git blob id, so an unchanged file is never sent again', async () => {
		expect(await blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
		expect(await blobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
	});

	it('writes only changed files in one commit, removes stale ones, and leaves the rest of the repo alone', async () => {
		const mock = createGithubMock();
		mock.seed('o/r', { files: { 'README.md': '# mine\n', 'board/old.md': 'old\n' } });
		const api = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, mock.fetch);
		const first = await api.commitFiles(
			INSTALL,
			'o/r',
			'main',
			{ 'a.md': 'A\n', 'b/c.md': 'C\n' },
			{ prefix: 'board', message: 'one' }
		);
		expect(first.changed.sort()).toEqual(['board/a.md', 'board/b/c.md']);
		expect(first.deleted).toEqual(['board/old.md']);
		expect(mock.filesOf('o/r')).toEqual({
			'README.md': '# mine\n',
			'board/a.md': 'A\n',
			'board/b/c.md': 'C\n'
		});
		const again = await api.commitFiles(
			INSTALL,
			'o/r',
			'main',
			{ 'a.md': 'A\n', 'b/c.md': 'C\n' },
			{ prefix: 'board', message: 'two' }
		);
		expect(again).toEqual({ sha: null, changed: [], deleted: [] });
		const some = await api.commitFiles(
			INSTALL,
			'o/r',
			'main',
			{ 'a.md': 'A2\n', 'b/c.md': 'C\n' },
			{ prefix: 'board', message: 'three' }
		);
		expect(some.changed).toEqual(['board/a.md']);
		expect(mock.filesOf('o/r')['board/a.md']).toBe('A2\n');
		expect(await api.getRepo(INSTALL, 'o/r')).toEqual({
			fullName: 'o/r',
			private: true,
			defaultBranch: 'main'
		});
		expect((await api.listInstallationRepos(INSTALL)).map((r) => r.fullName)).toEqual(['o/r']);
	});

	it('makes a dedicated branch from the default one, leaves an existing branch alone and reads a branch with a slash', async () => {
		const mock = createGithubMock();
		mock.seed('o/r', { files: { 'README.md': '# mine\n' } });
		const api = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, mock.fetch);
		expect(await api.createBranch(INSTALL, 'o/r', 'board-publish', 'main')).toEqual({
			created: true
		});
		expect(mock.filesOf('o/r', 'board-publish')).toEqual({ 'README.md': '# mine\n' });
		// A second call, or a person who made the branch first, changes nothing
		expect(await api.createBranch(INSTALL, 'o/r', 'board-publish', 'main')).toEqual({
			created: false
		});
		// A slash stays a slash in the ref path, so feat/x can be made and then written to
		expect(await api.createBranch(INSTALL, 'o/r', 'feat/x', 'main')).toEqual({ created: true });
		const wrote = await api.commitFiles(
			INSTALL,
			'o/r',
			'feat/x',
			{ 'a.md': 'A\n' },
			{ prefix: 'board', message: 'm' }
		);
		expect(wrote.changed).toEqual(['board/a.md']);
		expect(mock.filesOf('o/r', 'feat/x')['board/a.md']).toBe('A\n');
		// Nothing of this touched the default branch
		expect(mock.filesOf('o/r')).toEqual({ 'README.md': '# mine\n' });
	});

	it('treats a branch that appears between the check and the create as made, and says plainly when the repo has no commit', async () => {
		const mock = createGithubMock();
		mock.seed('o/r', {});
		const racing = ((u: string, i: RequestInit) => {
			// The ref exists by the time the POST arrives, as when two connects race
			if (i?.method === 'POST' && u.endsWith('/git/refs'))
				return mock.fetch(u, i).then(() => mock.fetch(u, i));
			return mock.fetch(u, i);
		}) as never;
		const api = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, racing);
		expect(await api.createBranch(INSTALL, 'o/r', 'race', 'main')).toEqual({ created: false });
		mock.seed('o/empty', { empty: true });
		await expect(api.createBranch(INSTALL, 'o/empty', 'board-publish', 'main')).rejects.toThrow(
			/no commit on "main"/
		);
	});

	it('says a network failure plainly with its reason and marks it retryable, instead of a bare "fetch failed"', async () => {
		const reset = (() =>
			Promise.reject(
				new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
			)) as unknown as typeof fetch;
		const api = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, reset);
		await expect(api.getRepo(INSTALL, 'o/r')).rejects.toMatchObject({
			name: 'GithubError',
			retryable: true,
			message: 'GitHub could not be reached (ECONNRESET).'
		});
		const slow = (() =>
			Promise.reject(
				new DOMException('signal timed out', 'TimeoutError')
			)) as unknown as typeof fetch;
		const late = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, slow);
		await expect(late.getRepo(INSTALL, 'o/r')).rejects.toThrow(
			/could not be reached \(timed out\)/
		);
	});

	it('writes a big project in several tree calls, so GitHub never times out, and the result holds every file', async () => {
		const mock = createGithubMock();
		mock.seed('o/big', { files: { 'README.md': '# mine\n', 'board/old.md': 'old\n' } });
		const api = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, mock.fetch);
		const files: Record<string, string> = {};
		for (let i = 0; i < 250; i++) files[`items/I-${i}/PLAN.md`] = `plan ${i}\n`;
		const wrote = await api.commitFiles(INSTALL, 'o/big', 'main', files, {
			prefix: 'board',
			message: 'big'
		});
		expect(wrote.changed).toHaveLength(250);
		expect(wrote.deleted).toEqual(['board/old.md']);
		const treeCalls = mock.calls.filter((c: string) => /^POST .*\/git\/trees$/.test(c));
		expect(treeCalls.length).toBeGreaterThanOrEqual(Math.ceil(251 / TREE_CHUNK_ENTRIES));
		const after = mock.filesOf('o/big');
		expect(Object.keys(after)).toHaveLength(251);
		expect(after['board/items/I-249/PLAN.md']).toBe('plan 249\n');
		expect(after['README.md']).toBe('# mine\n');
	});

	it('splits tree entries by count and by size, keeping their order', () => {
		const small = Array.from({ length: 230 }, (_, i) => ({ path: `a${i}`, content: 'x' }));
		expect(chunkTreeEntries(small).map((c) => c.length)).toEqual([100, 100, 30]);
		const big = [1, 2, 3].map((i) => ({ path: `b${i}`, content: 'y'.repeat(400_000) }));
		expect(chunkTreeEntries(big).map((c) => c.length)).toEqual([1, 1, 1]);
		expect(chunkTreeEntries([])).toEqual([]);
		expect(
			chunkTreeEntries(small)
				.flat()
				.map((e) => e.path)
		).toEqual(small.map((e) => e.path));
	});

	it('knows which names git accepts as a branch', () => {
		for (const ok of ['board-publish', 'flow-plans', 'feat/x', 'a.b', 'v1.2/x'])
			expect(isGitBranchName(ok)).toBe(true);
		for (const bad of ['a..b', '/x', 'x/', 'x//y', '.x', 'x/.y', '-x', 'x.', 'x.lock', 'a/b.lock'])
			expect(isGitBranchName(bad)).toBe(false);
	});

	it('says what is wrong in plain words: an empty repo, a missing repo, bad credentials, a bad name', async () => {
		const mock = createGithubMock();
		mock.seed('o/empty', { empty: true });
		const api = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, mock.fetch);
		await expect(
			api.commitFiles(INSTALL, 'o/empty', 'main', { 'a.md': 'A' }, { prefix: 'b', message: 'm' })
		).rejects.toThrow(/first commit/);
		await expect(api.getRepo(INSTALL, 'o/none')).rejects.toThrow(/cannot find/);
		await expect(api.getRepo(INSTALL, 'not a repo')).rejects.toThrow(/owner\/name/);
		const noAuth = createGithubApi({ apiUrl: 'http://gh', appId: '1', privateKey: PKCS8 }, ((
			u: string,
			i: RequestInit
		) => mock.fetch(u, { ...i, headers: {} })) as never);
		await expect(noAuth.getRepo(INSTALL, 'o/empty')).rejects.toThrow(/credentials/);
	});

	it('the manifest and the signed install state', async () => {
		const m = appManifest('https://board.example.com');
		expect(m.hook_attributes.url).toBe('https://board.example.com/github/webhook');
		expect(m.default_permissions).toEqual({
			contents: 'write',
			metadata: 'read',
			pull_requests: 'read',
			checks: 'write'
		});
		expect(m.default_events).toEqual(expect.arrayContaining(['push', 'pull_request']));
		expect(m.public).toBe(false);
		const state = await signState(
			'secret-secret-secret-secret-123456',
			{ orgId: 'o', projectId: 'p', userId: 'u' },
			1_000
		);
		expect(await verifyState('secret-secret-secret-secret-123456', state, 2_000)).toEqual({
			orgId: 'o',
			projectId: 'p',
			userId: 'u',
			startedAt: 1_000
		});
		expect(await verifyState('another-secret-another-secret-123456', state, 2_000)).toBeNull();
		expect(
			await verifyState('secret-secret-secret-secret-123456', state, 1_000 + 11 * 60_000)
		).toBeNull();
		expect(
			await verifyState(
				'secret-secret-secret-secret-123456',
				state.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
				2_000
			)
		).toBeNull();
		expect(await verifyState('secret-secret-secret-secret-123456', 'junk', 2_000)).toBeNull();
	});

	it('the webhook signature must match the body and the secret', async () => {
		const body = JSON.stringify({ action: 'deleted' });
		const sig = signWebhook('whsec', body);
		expect(await verifySignature('whsec', body, sig)).toBe(true);
		expect(await verifySignature('other', body, sig)).toBe(false);
		expect(await verifySignature('whsec', body + ' ', sig)).toBe(false);
		expect(await verifySignature('whsec', body, null)).toBe(false);
		expect(await verifySignature('whsec', body, 'sha256=zz')).toBe(false);
		expect(await verifySignature('whsec', body, sig.replace('sha256=', ''))).toBe(false);
	});
});

describe('the schedule of automatic publish', () => {
	const weekdays = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', timezone: 'UTC' };
	it('keeps a time inside the window and moves one outside it to the next opening', () => {
		const inside = new Date('2026-10-14T10:30:00Z'); // a Wednesday
		expect(nextAllowed(inside, weekdays)).toEqual(inside);
		expect(nextAllowed(new Date('2026-10-14T19:00:00Z'), weekdays)).toEqual(
			new Date('2026-10-15T09:00:00Z')
		);
		expect(nextAllowed(new Date('2026-10-17T12:00:00Z'), weekdays)).toEqual(
			new Date('2026-10-19T09:00:00Z')
		);
		expect(nextAllowed(new Date('2026-10-14T19:00:00Z'), null)).toEqual(
			new Date('2026-10-14T19:00:00Z')
		);
	});
	it('reads the window in its own time zone, including one that crosses midnight', () => {
		const berlin = {
			days: [0, 1, 2, 3, 4, 5, 6],
			from: '08:00',
			to: '10:00',
			timezone: 'Europe/Berlin'
		};
		// 08:00 in Berlin on 2026-10-14 is 06:00 UTC (summer time)
		expect(nextAllowed(new Date('2026-10-14T05:00:00Z'), berlin)).toEqual(
			new Date('2026-10-14T06:00:00Z')
		);
		const night = { days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00', timezone: 'UTC' };
		expect(nextAllowed(new Date('2026-10-14T23:30:00Z'), night)).toEqual(
			new Date('2026-10-14T23:30:00Z')
		);
		expect(nextAllowed(new Date('2026-10-14T12:00:00Z'), night)).toEqual(
			new Date('2026-10-14T22:00:00Z')
		);
	});
});

describe.each([
	['pglite', makePglite],
	['postgres', makePostgres]
] as const)('publishing on %s', (_name, make) => {
	let db: TestDb;
	let w: World;
	const mock = createGithubMock();
	const github = createGithubApi(
		{ apiUrl: 'http://gh', appId: '1', privateKey: PKCS1 },
		mock.fetch
	);
	let jobs: ReturnType<typeof memoryJobs>;
	const storage = memoryStorage('storage-secret-for-tests-0123456789');
	const admin = (who: 'admin' | 'owner' | 'member' | 'viewer' = 'admin') => ({
		...w.ctx(who),
		services: { github, jobs, storage, baseUrl: 'http://localhost' }
	});
	const repoFiles = () => mock.filesOf('acme/board', DEFAULT_PUBLISH_BRANCH);
	const link = () =>
		withTenant(db, { orgId: w.orgId }, async (tx) => (await tx.select().from(githubLink))[0]);
	const runs = () =>
		withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.select().from(publishRun).orderBy(publishRun.createdAt)
		);

	beforeAll(async () => {
		db = await make();
		w = await makeWorld(db);
		jobs = memoryJobs(db);
		registerPublishJobs(jobs, { github });
		// The installation the org made through the install link, and one that belongs to the other org
		await db.admin.exec(
			`insert into github_installation (installation_id, org_id) values ('${INSTALL}', '${w.orgId}'), ('9999', '${w.other.orgId}')`
		);
	});
	afterAll(() => db.stop());

	it('only people with the publish capability may connect a repository, and a repo the App cannot reach is refused', async () => {
		mock.seed('acme/board', { private: true });
		const input = { project: w.projectKey, installationId: INSTALL, repo: 'acme/board' };
		await expect(linkRepo(admin('member'), input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(linkRepo(admin('viewer'), input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(linkRepo(admin(), { ...input, repo: 'acme/ghost' })).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/cannot find/)
		});
		await expect(linkRepo(admin(), { ...input, installationId: 'abc' })).rejects.toThrow();
		// Another org's installation is refused as if it did not exist, and an empty or climbing folder is refused
		await expect(linkRepo(admin(), { ...input, installationId: '9999' })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(linkRepo(admin(), { ...input, installationId: '1234' })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(linkRepo(admin(), { ...input, path: '' })).rejects.toThrow();
		await expect(linkRepo(admin(), { ...input, path: 'a/../b' })).rejects.toThrow();
		const row = await linkRepo(admin(), input);
		expect(row).toMatchObject({
			repo: 'acme/board',
			branch: DEFAULT_PUBLISH_BRANCH,
			path: 'board',
			repoVisibility: 'private',
			autoPublish: false
		});
		// Without the App settings on the server, publishing says so plainly
		await expect(linkRepo({ ...admin(), services: {} }, input)).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/not set up/)
		});
		const state = await publishState(admin('viewer'), w.projectKey);
		expect(state.configured).toBe(true);
		expect(state.canPublish).toBe(false);
		expect(state.link?.repo).toBe('acme/board');
	});

	it('never connects to the default branch, makes the dedicated branch only for a person who may publish, and reuses one that exists', async () => {
		mock.seed('acme/lane', { private: true });
		const base = { project: w.projectKey, installationId: INSTALL, repo: 'acme/lane' };
		const branchesOf = () => [...mock.repos.get('acme/lane')!.refs.keys()].sort();
		// The default branch is refused whatever its case, and nothing is created
		for (const branch of ['main', 'MAIN'])
			await expect(linkRepo(admin(), { ...base, branch })).rejects.toMatchObject({
				code: 'INVALID',
				message: DEFAULT_BRANCH_REFUSAL
			});
		await expect(linkRepo(admin(), { ...base, branch: 'a..b' })).rejects.toThrow();
		// Someone without the publish capability creates no branch in the real repository
		for (const who of ['member', 'viewer'] as const)
			await expect(linkRepo(admin(who), base)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(branchesOf()).toEqual(['main']);
		// An admin gets the default dedicated branch, made from the default branch
		const made = await linkRepo(admin(), base);
		expect(made.branch).toBe(DEFAULT_PUBLISH_BRANCH);
		expect(branchesOf()).toEqual(['board-publish', 'main']);
		// A branch that already exists (like flow-plans) is reused as it is
		mock.repos
			.get('acme/lane')!
			.refs.set('flow-plans', mock.repos.get('acme/lane')!.refs.get('main')!);
		const reused = await linkRepo(admin(), { ...base, branch: 'flow-plans', path: 'board' });
		expect(reused.branch).toBe('flow-plans');
		expect(branchesOf()).toEqual(['board-publish', 'flow-plans', 'main']);
		// Put the project back on its usual repository for the tests that follow
		await linkRepo(admin(), {
			project: w.projectKey,
			installationId: INSTALL,
			repo: 'acme/board'
		});
	});

	it('Publish now writes Markdown and a JSON snapshot, leaves private items out, and an unchanged project writes nothing', async () => {
		const pub = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Saved cards | with a pipe',
			...PLAN
		});
		await createItem(w.ctx('owner'), {
			project: w.projectKey,
			title: 'Secret plan',
			visibility: 'private'
		});
		await upsertDecision(w.ctx('member'), {
			item: pub.ref,
			kind: 'settled',
			title: 'Which colour',
			answer: 'Graphite',
			source: 'tokens.md'
		});
		await upsertDecision(w.ctx('member'), {
			item: pub.ref,
			kind: 'adr',
			title: 'Use REST',
			decision: 'Yes'
		});
		await upsertSection(w.ctx('member'), {
			item: pub.ref,
			slug: 'spec',
			title: 'Spec',
			body: '# Spec\n\nSome words.'
		});
		await recordSteps(w.ctx('member'), { item: pub.ref, marks: [{ key: '1.1', mark: 'done' }] });

		const preview = await previewPublish(admin(), w.projectKey);
		expect(preview).toMatchObject({ linked: true, refusal: null, itemCount: 1, privateItems: 1 });
		expect(preview.diff.added).toEqual([pub.ref]);

		const first = await requestPublish(admin(), { project: w.projectKey });
		expect(first.done).toBe(true);
		expect(first.run).toMatchObject({ state: 'done', trigger: 'manual', repo: 'acme/board' });
		expect(first.run.commitSha).toBeTruthy();
		const files = repoFiles();
		expect(Object.keys(files).sort()).toEqual(
			[
				'README.md',
				'board/README.md',
				'board/registry.md',
				'board/snapshot.json',
				`board/items/${pub.ref}/PLAN.md`,
				`board/items/${pub.ref}/PROGRESS.md`,
				`board/items/${pub.ref}/DECISIONS.md`,
				`board/items/${pub.ref}/docs/spec.md`
			].sort()
		);
		// The private item is nowhere, by title, ref or content
		expect(JSON.stringify(files)).not.toMatch(/Secret plan/);
		const plan = files[`board/items/${pub.ref}/PLAN.md`];
		expect(plan).toContain('- [x] 1.1 Write the code');
		expect(plan).toContain('- [ ] 1.2 Write the tests');
		expect(plan).toContain('[auto] Runs by itself');
		expect(files[`board/items/${pub.ref}/DECISIONS.md`]).toContain(
			'| Which colour | Graphite | tokens.md |'
		);
		expect(files['board/registry.md']).toContain('Saved cards \\| with a pipe');
		const snapshot = JSON.parse(files['board/snapshot.json']);
		expect(snapshot).toMatchObject({ format: 'agent-flow-board-snapshot', version: 1 });
		expect(snapshot.items).toHaveLength(1);
		expect(snapshot.items[0].phases[0].steps[0]).toMatchObject({ key: '1.1', state: 'done' });
		expect(
			snapshot.items[0].decisions.find((d: { kind: string }) => d.kind === 'settled')
		).toMatchObject({ answer: 'Graphite' });

		// Nothing changed: no commit, and the run says so
		const second = await requestPublish(admin(), { project: w.projectKey });
		expect(second.run.state).toBe('done');
		expect(second.run.commitSha).toBeNull();
		expect(second.run.message).toMatch(/Nothing had changed/);
		expect(Object.keys(repoFiles()).length).toBe(Object.keys(files).length);
	});

	it('shows what changed since the last publish and writes only that, and removes an item that turns private', async () => {
		const before = await previewPublish(admin(), w.projectKey);
		expect(before.diff.total).toBe(0);
		const items = await withTenant(db, { orgId: w.orgId }, (tx) =>
			loadPublishable(tx, w.projectId)
		);
		const ref = items.items[0].item.ref;
		// Only the person who made an item can make it private or public
		const maker = {
			...w.ctx('owner'),
			actor: { ...w.ctx('owner').actor, userId: items.items[0].item.createdBy! }
		};
		await recordSteps(w.ctx('member'), { item: ref, marks: [{ key: '1.2', mark: 'done' }] });
		const changed = await previewPublish(admin(), w.projectKey);
		expect(changed.diff).toMatchObject({ changed: [ref], added: [], removed: [], total: 1 });
		const run1 = (await requestPublish(admin(), { project: w.projectKey })).run;
		expect(run1.changedItems).toEqual([ref]);
		expect(run1.message).toMatch(/Wrote 5 files/); // PLAN, PROGRESS, snapshot, registry and README
		// Turn it private: its files disappear from the repo on the next publish
		await updateItem(maker, { item: ref, visibility: 'private' });
		const gone = (await requestPublish(admin(), { project: w.projectKey })).run;
		expect(gone.changedItems).toEqual([ref]);
		expect(Object.keys(repoFiles()).filter((p) => p.includes(ref))).toEqual([]);
		await updateItem(maker, { item: ref, visibility: 'public' });
		await requestPublish(admin(), { project: w.projectKey });
		expect(Object.keys(repoFiles()).some((p) => p.includes(ref))).toBe(true);
	});

	it('is deterministic: the same data renders the same files and hashes', async () => {
		const a = await withTenant(db, { orgId: w.orgId }, async (tx) =>
			renderExport(await loadPublishable(tx, w.projectId))
		);
		const b = await withTenant(db, { orgId: w.orgId }, async (tx) =>
			renderExport(await loadPublishable(tx, w.projectId))
		);
		expect(a).toEqual(b);
		expect(diffHashes(a.hashes, b.hashes).total).toBe(0);
		expect(diffHashes({ X: '1', Y: '2' }, { Y: '3', Z: '4' })).toMatchObject({
			added: ['Z'],
			removed: ['X'],
			changed: ['Y']
		});
	});

	it('a cancelled delayed publish writes nothing, on the job runner and by state; a kept one writes', async () => {
		const items = await withTenant(db, { orgId: w.orgId }, (tx) =>
			loadPublishable(tx, w.projectId)
		);
		const ref = items.items[0].item.ref;
		await recordSteps(w.ctx('member'), { item: ref, marks: [{ key: '2.1', mark: 'done' }] });
		const before = JSON.stringify(repoFiles());
		const at = new Date(Date.now() + 60_000).toISOString();
		const kept = await requestPublish(admin(), { project: w.projectKey, runAt: at });
		const cancelled = await requestPublish(admin(), { project: w.projectKey, runAt: at });
		expect(kept.done).toBe(false);
		expect(kept.run.state).toBe('pending');
		expect((await cancelPublish(admin(), cancelled.run.id)).cancelled).toBe(true);
		// Cancelling twice, and cancelling a run that is not waiting, change nothing
		expect((await cancelPublish(admin(), cancelled.run.id)).cancelled).toBe(false);
		await expect(cancelPublish(admin('member'), kept.run.id)).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		await expect(
			cancelPublish(admin(), '00000000-0000-4000-8000-000000000999')
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// Nothing is due yet
		await jobs.drain(new Date());
		expect(JSON.stringify(repoFiles())).toBe(before);
		// The time comes: the kept run writes, the cancelled one does not
		await jobs.drain(new Date(Date.now() + 120_000));
		const all = await runs();
		expect(all.find((r) => r.id === kept.run.id)?.state).toBe('done');
		const cancelledRow = all.find((r) => r.id === cancelled.run.id)!;
		expect(cancelledRow.state).toBe('cancelled');
		expect(cancelledRow.commitSha).toBeNull();
		expect(JSON.stringify(repoFiles())).not.toBe(before);
		// Past and far future times are refused
		await expect(
			requestPublish(admin(), {
				project: w.projectKey,
				runAt: new Date(Date.now() + 1000).toISOString()
			})
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			requestPublish(admin(), {
				project: w.projectKey,
				runAt: new Date(Date.now() + 40 * 86_400_000).toISOString()
			})
		).rejects.toMatchObject({ code: 'INVALID' });
	});

	it('a rate limit backs off and retries by itself, and the run stays cancellable meanwhile', async () => {
		const items = await withTenant(db, { orgId: w.orgId }, (tx) =>
			loadPublishable(tx, w.projectId)
		);
		await updateItem(w.ctx('member'), {
			item: items.items[0].item.ref,
			title: 'Renamed for the rate limit check'
		});
		mock.limits.rate = 1;
		mock.limits.retryAfter = 7;
		const started = await requestPublish(admin(), { project: w.projectKey });
		expect(started.run.state).toBe('pending');
		expect(started.run.error).toMatch(/limiting requests/);
		expect(started.run.attempt).toBe(1);
		expect(new Date(started.run.runAt).getTime()).toBeGreaterThan(Date.now() + 6_000);
		await jobs.drain(new Date(Date.now() + 60_000));
		const after = (await runs()).find((r) => r.id === started.run.id)!;
		expect(after.state).toBe('done');
		expect(after.attempt).toBe(2);
		expect((await link()).failures).toBe(0);
		expect(
			Object.values(repoFiles()).some((f) => f.includes('Renamed for the rate limit check'))
		).toBe(true);
	});

	it('a failure that keeps happening ends as failed, counts, and three in a row pause automatic publish with a reason', async () => {
		await setPublishSettings(admin(), {
			project: w.projectKey,
			autoPublish: true,
			delayMinutes: 1
		});
		expect((await link()).autoPublish).toBe(true);
		const items = await withTenant(db, { orgId: w.orgId }, (tx) =>
			loadPublishable(tx, w.projectId)
		);
		for (let n = 1; n <= FAILURES_BEFORE_PAUSE; n++) {
			await updateItem(w.ctx('member'), { item: items.items[0].item.ref, title: `Failing ${n}` });
			mock.limits.fail = 99;
			mock.limits.failStatus = 502;
			const first = await requestPublish(admin(), { project: w.projectKey });
			// A bad gateway is retried with growing waits, five tries in all
			let state = first.run.state;
			for (let t = 0; t < 6 && state === 'pending'; t++) {
				await jobs.drain(new Date(Date.now() + (t + 1) * 3_600_000));
				state = (await runs()).find((r) => r.id === first.run.id)!.state;
			}
			expect(state).toBe('failed');
			const failed = (await runs()).find((r) => r.id === first.run.id)!;
			expect(failed.attempt).toBe(5);
			expect(failed.error).toMatch(/GitHub answered 502/);
			expect((await link()).failures).toBe(n);
		}
		mock.limits.fail = 0;
		const paused = await link();
		expect(paused.pausedReason).toMatch(/failed 3 times in a row/);
		// While paused, an automatic run does nothing
		const sched = await scheduleAutoPublish(
			{
				payload: { orgId: w.orgId, projectId: w.projectId },
				tenant: (fn) => withTenant(db, { orgId: w.orgId, projectId: w.projectId }, fn)
			},
			jobs
		);
		expect(sched.scheduled).toBe(false);
		// A person publishing by hand works and clears the count, and turning the switch on again clears the pause
		const hand = await requestPublish(admin(), { project: w.projectKey });
		expect(hand.run.state).toBe('done');
		expect((await link()).failures).toBe(0);
		await setPublishSettings(admin(), { project: w.projectKey, autoPublish: true });
		expect((await link()).pausedReason).toBeNull();
	});

	it('automatic publish queues one cancellable run after the delay when something changed, and none when nothing did', async () => {
		const ctxFor = () => ({
			payload: { orgId: w.orgId, projectId: w.projectId },
			tenant: <T>(fn: (tx: never) => Promise<T>) =>
				withTenant(db, { orgId: w.orgId, projectId: w.projectId }, fn as never)
		});
		// Everything is published, so nothing is due
		expect((await scheduleAutoPublish(ctxFor(), jobs)).scheduled).toBe(false);
		const items = await withTenant(db, { orgId: w.orgId }, (tx) =>
			loadPublishable(tx, w.projectId)
		);
		await updateItem(w.ctx('member'), {
			item: items.items[0].item.ref,
			title: 'Changed for automatic publish'
		});
		const now = new Date();
		const first = await scheduleAutoPublish(ctxFor(), jobs, now);
		expect(first.scheduled).toBe(true);
		// A second change joins the waiting run instead of adding another
		await updateItem(w.ctx('member'), {
			item: items.items[0].item.ref,
			title: 'Changed again for automatic publish'
		});
		expect((await scheduleAutoPublish(ctxFor(), jobs, now)).scheduled).toBe(false);
		const waiting = (await runs()).filter((r) => r.state === 'pending');
		expect(waiting).toHaveLength(1);
		expect(waiting[0].trigger).toBe('auto');
		expect(new Date(waiting[0].runAt).getTime()).toBeGreaterThanOrEqual(now.getTime() + 59_000);
		expect(new Date(waiting[0].runAt).getTime()).toBeLessThanOrEqual(now.getTime() + 61_000);
		// Before the delay nothing is written, after it the repo has the newest title
		await jobs.drain(new Date(now.getTime() + 30_000));
		expect(
			Object.values(repoFiles()).some((f) => f.includes('Changed again for automatic publish'))
		).toBe(false);
		await jobs.drain(new Date(now.getTime() + 90_000));
		expect(
			Object.values(repoFiles()).some((f) => f.includes('Changed again for automatic publish'))
		).toBe(true);
		// The publish itself is not a change that needs publishing
		expect((await scheduleAutoPublish(ctxFor(), jobs)).scheduled).toBe(false);
		// Switched off, nothing is queued, and the job name is registered for the scheduler
		await setPublishSettings(admin(), { project: w.projectKey, autoPublish: false });
		await updateItem(w.ctx('member'), {
			item: items.items[0].item.ref,
			title: 'Changed with the switch off'
		});
		expect((await scheduleAutoPublish(ctxFor(), jobs)).scheduled).toBe(false);
		expect(SCHEDULE_JOB).toBe('publish.schedule');
	});

	it('a link that was made on the default branch, or a default branch renamed to the linked one, writes nothing', async () => {
		const guardKey = 'acme/guard';
		mock.seed(guardKey, { private: true });
		await linkRepo(admin(), { project: w.projectKey, installationId: INSTALL, repo: guardKey });
		// The default branch becomes the linked branch, as a rename on GitHub would do
		const repo = mock.repos.get(guardKey)!;
		const before = JSON.stringify(mock.filesOf(guardKey, DEFAULT_PUBLISH_BRANCH));
		repo.branch = DEFAULT_PUBLISH_BRANCH;
		const refused = await requestPublish(admin(), { project: w.projectKey });
		expect(refused.run.state).toBe('failed');
		expect(refused.run.error).toBe(DEFAULT_BRANCH_REFUSAL);
		expect(JSON.stringify(mock.filesOf(guardKey, DEFAULT_PUBLISH_BRANCH))).toBe(before);
		expect((await link()).failures).toBe(0);
		// An automatic publish meeting the same refusal pauses itself and says why, instead of retrying or counting a failure
		await setPublishSettings(admin(), {
			project: w.projectKey,
			autoPublish: true,
			delayMinutes: 1
		});
		const loaded = await withTenant(db, { orgId: w.orgId }, (tx) =>
			loadPublishable(tx, w.projectId)
		);
		await updateItem(w.ctx('member'), {
			item: loaded.items[0].item.ref,
			title: 'Changed for the default branch guard'
		});
		const at = new Date();
		const ctxFor = () => ({
			payload: { orgId: w.orgId, projectId: w.projectId },
			tenant: <T>(fn: (tx: never) => Promise<T>) =>
				withTenant(db, { orgId: w.orgId, projectId: w.projectId }, fn as never)
		});
		expect((await scheduleAutoPublish(ctxFor(), jobs, at)).scheduled).toBe(true);
		await jobs.drain(new Date(at.getTime() + 90_000));
		const stopped = await link();
		expect(stopped.pausedReason).toBe(DEFAULT_BRANCH_REFUSAL);
		expect(stopped.failures).toBe(0);
		expect(JSON.stringify(mock.filesOf(guardKey, DEFAULT_PUBLISH_BRANCH))).toBe(before);
		await setPublishSettings(admin(), { project: w.projectKey, autoPublish: false });
		repo.branch = 'main';
		await linkRepo(admin(), { project: w.projectKey, installationId: INSTALL, repo: 'acme/board' });
	});

	it('a schedule moves the run into its window', async () => {
		const ctxFor = () => ({
			payload: { orgId: w.orgId, projectId: w.projectId },
			tenant: <T>(fn: (tx: never) => Promise<T>) =>
				withTenant(db, { orgId: w.orgId, projectId: w.projectId }, fn as never)
		});
		await setPublishSettings(admin(), {
			project: w.projectKey,
			autoPublish: true,
			delayMinutes: 5,
			schedule: { days: [1], from: '03:00', to: '04:00', timezone: 'UTC' }
		});
		const [row] = await withTenant(db, { orgId: w.orgId }, (tx) => tx.select().from(githubLink));
		expect(row.schedule).toEqual({ days: [1], from: '03:00', to: '04:00', timezone: 'UTC' });
		expect(
			(await scheduleAutoPublish(ctxFor(), jobs, new Date('2026-10-14T10:00:00Z'))).scheduled
		).toBe(true);
		const waiting = (await runs()).filter((r) => r.state === 'pending');
		expect(waiting).toHaveLength(1);
		expect(waiting[0].trigger).toBe('schedule');
		// The next Monday at 03:00 UTC
		expect(new Date(waiting[0].runAt)).toEqual(new Date('2026-10-19T03:00:00Z'));
		await setPublishSettings(admin(), { project: w.projectKey, autoPublish: false });
		await withTenant(db, { orgId: w.orgId }, (tx) =>
			tx.update(publishRun).set({ state: 'cancelled' }).where(eq(publishRun.state, 'pending'))
		);
	});

	it('a public repository is refused when the project holds private items or private files, and nothing is written', async () => {
		mock.seed('acme/open', { private: false });
		const info = { project: w.projectKey, installationId: INSTALL, repo: 'acme/open' };
		const l = await linkRepo(admin(), info);
		expect(l.repoVisibility).toBe('public');
		// The project has a private item (Secret plan), so the preview already says no
		const preview = await previewPublish(admin(), w.projectKey);
		expect(preview.refusal).toMatch(/public and the project holds 1 private item/);
		const refused = await requestPublish(admin(), { project: w.projectKey });
		expect(refused.run.state).toBe('failed');
		expect(refused.run.error).toMatch(/Nothing was published/);
		expect(Object.keys(mock.filesOf('acme/open', DEFAULT_PUBLISH_BRANCH))).toEqual(['README.md']);
		// Making the private item public is not enough while a private file remains
		const secret = await withTenant(db, { orgId: w.orgId }, async (tx) => {
			const { item } = await import('../../src/lib/server/db/schema');
			return (await tx.select().from(item).where(eq(item.visibility, 'private')))[0];
		});
		await updateItem(w.ctx('owner'), { item: secret.id, visibility: 'public' });
		const shared = (await loadFirstPublic()).ref;
		await addAttachment(
			admin('member'),
			{
				item: shared,
				filename: 'shot.png',
				caption: 'A screenshot',
				kind: 'ui-shot',
				visibility: 'private',
				refs: []
			},
			new Uint8Array([1, 2, 3])
		);
		const stillRefused = await requestPublish(admin(), { project: w.projectKey });
		expect(stillRefused.run.state).toBe('failed');
		expect(stillRefused.run.error).toMatch(/1 private file/);
		expect(stillRefused.run.error).toMatch(/screenshots and check pictures are private by default/);
		// Making the file public lets it through, and the file itself is still never published
		const att = await withTenant(db, { orgId: w.orgId }, async (tx) => {
			const { attachment } = await import('../../src/lib/server/db/schema');
			return (await tx.select().from(attachment))[0];
		});
		await setAttachmentVisibility(admin('member'), att.id, 'public');
		const ok = await requestPublish(admin(), { project: w.projectKey });
		expect(ok.run.state).toBe('done');
		expect(
			Object.keys(mock.filesOf('acme/open', DEFAULT_PUBLISH_BRANCH)).some((p) => p.endsWith('.png'))
		).toBe(false);
		// The visibility is read fresh from GitHub on every run: the repo turns private behind our back
		mock.repos.get('acme/open')!.private = true;
		await requestPublish(admin(), { project: w.projectKey });
		expect((await link()).repoVisibility).toBe('private');

		async function loadFirstPublic() {
			const data = await withTenant(db, { orgId: w.orgId }, (tx) =>
				loadPublishable(tx, w.projectId)
			);
			return data.items[0].item;
		}
	});

	it('webhooks pause publishing when the App is removed, and follow a repository going public', async () => {
		const state = await publishState(admin(), w.projectKey);
		expect(state.link?.installationId).toBe(INSTALL);
		// An unknown installation, no installation, and ping are all accepted and ignored
		expect(
			await handleWebhook(db, 'installation', { action: 'deleted', installation: { id: 999 } })
		).toEqual({ handled: false, detail: 'unknown installation' });
		expect(await handleWebhook(db, 'installation', { action: 'deleted' })).toEqual({
			handled: false,
			detail: 'no installation'
		});
		expect(await handleWebhook(db, 'ping', {})).toEqual({ handled: true, detail: 'pong' });
		// A repository going public is followed
		await handleWebhook(db, 'repository', {
			action: 'publicized',
			installation: { id: INSTALL as never },
			repository: { full_name: 'acme/open' }
		});
		expect((await link()).repoVisibility).toBe('public');
		await handleWebhook(db, 'repository', {
			action: 'privatized',
			installation: { id: INSTALL as never },
			repository: { full_name: 'acme/open' }
		});
		expect((await link()).repoVisibility).toBe('private');
		// Removal from the installation pauses and cancels what was waiting
		await setPublishSettings(admin(), { project: w.projectKey, autoPublish: true });
		const waiting = await requestPublish(admin(), {
			project: w.projectKey,
			runAt: new Date(Date.now() + 60_000).toISOString()
		});
		const removed = await handleWebhook(db, 'installation_repositories', {
			action: 'removed',
			installation: { id: INSTALL as never },
			repositories_removed: [{ full_name: 'acme/open' }]
		});
		expect(removed.detail).toBe('paused 1');
		const paused = await link();
		expect(paused.pausedReason).toBe(REMOVED_REASON);
		expect(paused.autoPublish).toBe(false);
		expect((await runs()).find((r) => r.id === waiting.run.id)?.state).toBe('cancelled');
		// A suspended App resumes without switching anything on by itself
		await handleWebhook(db, 'installation', {
			action: 'unsuspend',
			installation: { id: INSTALL as never }
		});
		const resumed = await link();
		expect(resumed.pausedReason).toBeNull();
		expect(resumed.autoPublish).toBe(false);
		// Deleting the installation removes the mapping and pauses again
		await handleWebhook(db, 'installation', {
			action: 'deleted',
			installation: { id: INSTALL as never }
		});
		expect((await link()).pausedReason).toBe(REMOVED_REASON);
		expect(
			await handleWebhook(db, 'installation', {
				action: 'deleted',
				installation: { id: INSTALL as never }
			})
		).toMatchObject({ handled: false });
	});

	it('disconnecting a repository cancels what was waiting and the events say who did what', async () => {
		// The uninstall webhook above removed the installation, so the org installs it again
		await db.admin.exec(
			`insert into github_installation (installation_id, org_id) values ('${INSTALL}', '${w.orgId}') on conflict do nothing`
		);
		await linkRepo(admin(), { project: w.projectKey, installationId: INSTALL, repo: 'acme/board' });
		const waiting = await requestPublish(admin(), {
			project: w.projectKey,
			runAt: new Date(Date.now() + 60_000).toISOString()
		});
		expect((await unlinkRepo(admin(), w.projectKey)).unlinked).toBe(true);
		expect((await runs()).find((r) => r.id === waiting.run.id)?.state).toBe('cancelled');
		expect((await unlinkRepo(admin(), w.projectKey)).unlinked).toBe(false);
		const verbs = await run(admin(), async (tx) => {
			const { event } = await import('../../src/lib/server/db/schema');
			return (await tx.select({ verb: event.verb }).from(event)).map((e) => e.verb);
		});
		for (const v of [
			'github.link',
			'github.unlink',
			'publish.done',
			'publish.failed',
			'publish.refused',
			'github.settings'
		])
			expect(verbs, v).toContain(v);
		await expect(requestPublish(admin(), { project: w.projectKey })).rejects.toMatchObject({
			message: expect.stringMatching(/Connect a repository/)
		});
	});
});
