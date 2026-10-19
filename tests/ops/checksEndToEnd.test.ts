// A BROWSER CHECK FROM START TO END WITH NOBODY AT THE KEYBOARD (AFB-20261019-0510 STEP 5.2)
// The real MCP tools (check_save, check_run with wait, check_wait, runner_status) talk to the real board code and the embedded PostgreSQL. The real afb-checks tool,
// started as a separate process, takes the run through the real runner API (served over HTTP by a small shim), runs the local file in a real browser against a
// fixture page, and reports. The test only runs where the tool's dev copy is on this machine; it is skipped, loudly, anywhere else.

// -- DEP-MODULES -- //
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { handleRunnerApi } from '../../src/lib/server/api/runner';
import { registerToolRunner } from '../../src/lib/server/ops/environments';
import { createItem } from '../../src/lib/server/ops/items';
import { createToken } from '../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../support/db';
import { call, connect } from '../support/mcp';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const TOOL = process.env.AFB_CHECKS_TOOL_DIR ?? 'C:/Users/Admin/Desktop/afb-checks-dev';
const HAVE_TOOL =
	existsSync(path.join(TOOL, 'afb-checks.mjs')) &&
	existsSync(path.join(TOOL, 'template', 'HASH')) &&
	existsSync(path.join(TOOL, 'node_modules', '@playwright', 'test'));
// A skip must be seen, not guessed: the reason is printed when the tool is not here
if (!HAVE_TOOL)
	console.warn(
		`SKIPPED tests/ops/checksEndToEnd.test.ts: no afb-checks tool with its dependencies at ${TOOL}. Set AFB_CHECKS_TOOL_DIR to run it.`
	);
const MASTER = 'test-master-key-for-the-vault-0123456789abcdef';
const SCRIPT = `export default async ({ page, step, shot, expect }) => {
	await step('the home page opens', async () => {
		await page.goto('/');
		await expect(page.locator('h1')).toHaveText('Home');
	});
	await shot('the home page');
};
`;

// -- FUNCTIONS -- //

describe.skipIf(!HAVE_TOOL)('a check from start to end through the MCP', () => {
	let db: TestDb;
	let w: World;
	let board: http.Server;
	let page: http.Server;
	let worker: ChildProcess | undefined;
	let workerOut = '';
	let world: { home: string; data: string; checks: string; base: string };
	let toolToken = '';
	const storage = memoryStorage('e2e-storage-secret-0123456789abcdef');
	const listen = (s: http.Server) =>
		new Promise<number>((resolve) =>
			s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port))
		);
	const env = () => ({
		...process.env,
		AFB_CHECKS_HOME: world.home,
		AFB_CHECKS_DATA: world.data,
		AFB_CHECKS_CHECKS: world.checks,
		AFB_CHECKS_TEST_PERSON: '1',
		AFB_CHECKS_BEAT_SECONDS: '1'
	});
	const tool = (args: string[]) =>
		spawnSync(process.execPath, [path.join(TOOL, 'afb-checks.mjs'), ...args], {
			cwd: TOOL,
			env: env(),
			encoding: 'utf8',
			windowsHide: true
		});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		await db.admin.exec(`update project set web_app = true where id = '${w.projectId}'`);
		// A page for the check to open
		page = http.createServer((_req, res) => {
			res.setHeader('content-type', 'text/html');
			res.end('<h1>Home</h1>');
		});
		const pagePort = await listen(page);
		// The runner API of the board, over HTTP, for the tool
		board = http.createServer(async (req, res) => {
			const url = new URL(req.url ?? '/', 'http://x');
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			if (!url.pathname.startsWith('/api/v1/runner')) {
				res.statusCode = 404;
				return void res.end();
			}
			const out = await handleRunnerApi(
				{
					method: req.method ?? 'GET',
					path: url.pathname.slice('/api/v1'.length),
					query: Object.fromEntries(url.searchParams),
					headers: new Headers(req.headers as Record<string, string>),
					body: new Uint8Array(Buffer.concat(chunks)),
					session: null
				},
				{ handle: db, baseUrl: 'http://board.test', masterKey: MASTER, storage }
			);
			res.statusCode = out.status;
			for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, String(v));
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(out.body));
		});
		const boardPort = await listen(board);
		// A tool world in the temp folder, trusted by its own home, signed in to this board with a runner token the board made
		const base = mkdtempSync(path.join(tmpdir(), 'afbc-e2e-'));
		world = {
			base,
			home: path.join(base, 'home'),
			data: path.join(base, 'data'),
			checks: path.join(base, 'checks')
		};
		for (const d of [world.home, world.data, world.checks]) mkdirSync(d, { recursive: true });
		writeFileSync(
			path.join(world.home, 'template.hash'),
			readFileSync(path.join(TOOL, 'template', 'HASH'), 'utf8')
		);
		toolToken = (await registerToolRunner(w.ctx('admin'), { name: 'E2E PC afb-checks' })).token;
		const cred = `import { saveCredential } from '${new URL(`file:///${TOOL.replace(/\\/g, '/')}/template/lib/board.mjs`).href}'; saveCredential(${JSON.stringify({ server: `http://127.0.0.1:${boardPort}`, org: 'e2e', token: toolToken, name: 'E2E PC afb-checks' })});`;
		const saved = spawnSync(process.execPath, ['--input-type=module', '-e', cred], {
			env: env(),
			encoding: 'utf8'
		});
		expect(saved.status, saved.stderr).toBe(0);
		const reg = tool(['project', w.projectKey, '--url', `http://127.0.0.1:${pagePort}`]);
		expect(reg.status, reg.stdout + reg.stderr).toBe(0);
	}, 240_000);

	afterAll(async () => {
		worker?.kill();
		await new Promise<void>((r) => (board ? board.close(() => r()) : r()));
		await new Promise<void>((r) => (page ? page.close(() => r()) : r()));
		await db?.stop();
	});

	it('an agent saves a check, asks for a run, waits, and reads a pass, with no keyboard and no pasted script', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Check end to end',
			phases: [
				{
					key: '1',
					title: 'Build',
					steps: [{ text: 'Open the home page', requiredTarget: 'preview' as const }]
				}
			],
			manualChecks: [{ key: 'M1', text: 'The home page opens' }]
		});
		const token = (
			await createToken(w.ctx('member'), {
				name: 'agent',
				permissions: ['read', 'comment', 'write', 'complete', 'delete']
			})
		).token;
		const client = await connect({ handle: db, storage, baseUrl: 'http://board.test' }, token);
		const { sessionId } = await call(client, 'session_start', { tool: 'claude-code' });

		// The agent writes the check where the tool runs it, and saves the same text on the board (no copy and paste by a person)
		mkdirSync(path.join(world.checks, made.ref), { recursive: true });
		writeFileSync(path.join(world.checks, made.ref, 'M1.mjs'), SCRIPT);
		const saved = await call(client, 'check_save', {
			sessionId,
			item: made.ref,
			check: 'M1',
			script: SCRIPT,
			target: 'preview'
		});
		expect(saved).toMatchObject({ created: true, auto: true });

		// Nothing is running yet: the status says so, and says what to do
		const before = await call(client, 'runner_status', { project: w.projectKey });
		expect(before.projects[0].online).toBe(false);

		// The worker is started (what the service does at logon) and shows up as online
		worker = spawn(process.execPath, [path.join(TOOL, 'afb-checks.mjs'), 'work'], {
			cwd: TOOL,
			env: env(),
			windowsHide: true
		});
		worker.stdout?.on('data', (d) => (workerOut += d));
		worker.stderr?.on('data', (d) => (workerOut += d));
		await vi.waitFor(
			async () => {
				const s = await call(client, 'runner_status', { project: w.projectKey });
				expect(s.projects[0].online, workerOut).toBe(true);
			},
			{ timeout: 60_000, interval: 500 }
		);

		// One call asks for the run and waits for it
		const asked = await call(client, 'check_run', {
			sessionId,
			item: made.ref,
			check: 'M1',
			target: 'preview',
			step: '1.1',
			wait: 90
		});
		expect(asked.error, JSON.stringify(asked.error)).toBeUndefined();
		expect(asked.finished, workerOut).toBe(true);
		expect(asked.run).toMatchObject({ result: 'pass', code: null, fix: null });
		expect(asked.run.durationMs).toBeGreaterThan(0);
		// The picture of each step reached the board
		const status = await call(client, 'check_status', { item: made.ref });
		const run = status.checks[0].runs[0];
		expect(run.id).toBe(asked.run.id);
		expect(run.evidence.length).toBe(2);
		// The same answer by id
		const waited = await call(client, 'check_wait', { run: asked.run.id });
		expect(waited).toMatchObject({ finished: true });
		expect(waited.run).toMatchObject({ result: 'pass', key: 'M1', item: made.ref });
		// While the worker held it, it told the board it was alive
		const beat = await db.admin.query<{ b: string | null }>(
			`select last_beat_at as b from check_run where id = '${asked.run.id}'`
		);
		expect(beat[0].b).not.toBeNull();
		// Asked again, a new run is made (the first is finished), and it passes too
		const again = await call(client, 'check_run', {
			sessionId,
			item: made.ref,
			check: 'M1',
			target: 'preview',
			wait: 90
		});
		expect(again.run.id).not.toBe(asked.run.id);
		expect(again.run.result).toBe('pass');
	}, 240_000);

	it('a check that fails is a finding with its step named, and a run with no local file says what to do', async () => {
		const made = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Check that fails',
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Open it' }] }],
			manualChecks: [{ key: 'M1', text: 'It opens' }]
		});
		const token = (
			await createToken(w.ctx('member'), { name: 'agent2', permissions: ['read', 'write'] })
		).token;
		const client = await connect({ handle: db, storage, baseUrl: 'http://board.test' }, token);
		const { sessionId } = await call(client, 'session_start', { tool: 'claude-code' });
		const failing = SCRIPT.replace("toHaveText('Home')", "toHaveText('Something else')");
		mkdirSync(path.join(world.checks, made.ref), { recursive: true });
		writeFileSync(path.join(world.checks, made.ref, 'M1.mjs'), failing);
		await call(client, 'check_save', { sessionId, item: made.ref, check: 'M1', script: failing });
		const asked = await call(client, 'check_run', {
			sessionId,
			item: made.ref,
			check: 'M1',
			target: 'preview',
			wait: 90
		});
		expect(asked.finished).toBe(true);
		expect(asked.run.result).toBe('fail');
		expect(asked.run.code).toBeNull();
		// A check saved on the board with no local file: the tool does not run the board's text, and the answer says what happened
		const noFile = await createItem(w.ctx('member'), {
			project: w.projectKey,
			title: 'Check with no file',
			phases: [{ key: '1', title: 'Build', steps: [{ text: 'Open it' }] }],
			manualChecks: [{ key: 'M1', text: 'It opens' }]
		});
		await call(client, 'check_save', { sessionId, item: noFile.ref, check: 'M1', script: SCRIPT });
		const none = await call(client, 'check_run', {
			sessionId,
			item: noFile.ref,
			check: 'M1',
			target: 'preview',
			wait: 90
		});
		expect(none.run.result).toBe('error');
		expect(none.run.reason).toMatch(/no check file for/);
		expect(none.run.reason).toMatch(/pull/);
	}, 240_000);
});
