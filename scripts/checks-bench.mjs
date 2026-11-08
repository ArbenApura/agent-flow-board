// Benchmark of the browser check tools against this repo: the bridge's compiled runCheck (packages/bridge/dist) and the old afb-checks tool.
// Every run is its own node process, so the broker, the pools and the caches cooperate across processes the way they do for real runs.
// Nothing here prints an environment, a token or a value from a .env file: only stage seconds, counts and one-line messages.
//
//   node scripts/checks-bench.mjs [--tools bridge,old] [--scenarios cold1,second,cold4,cold8,warm8] [--old-dir <folder> (required for the old tool, or AFB_OLD_CHECKS_DIR)] [--md <file>]
//
// Bridge scenarios (each starts from a fresh throwaway state folder, AFB_BRIDGE_HOME, that this script removes at the end):
//   cold1 + second  run 1, then run 2 on the same tree and the same state folder (the second run finds the kept dependencies and build)
//   cold4, cold8    4 or 8 runs at once from an empty state folder
//   warm8           8 runs at once after the state folder was warmed by the runs above (needs cold1 or second first)
// Old tool scenarios (the tool keeps its own state between runs, so they are never cold): old1 (run 1, then run 2), old4, old8.
//
// Build the bridge first: yarn tsc -p packages/bridge/tsconfig.json
import { execFileSync, spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	rmdirSync,
	writeFileSync
} from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// The bridge under test is always the compiled dist, unpatched
const DIST = join(REPO, 'packages', 'bridge', 'dist') + '/checks/';
const ORG = 'arbenger';
const ITEM = 'AFB-20261108-0001';
const KEY = 'B1';
const RUN_LIMIT_MS = 25 * 60_000;
const MEM_WARN_BYTES = 1.5 * 1024 ** 3;
const MEM_ABORT_BYTES = 0.7 * 1024 ** 3;

const CHECK_SOURCE = `export default async ({ page, step, shot, log, baseUrl }) => {
	await step('Home opens', async () => {
		await page.goto('/');
		await page.waitForLoadState('load');
	});
	log('opened ' + baseUrl);
	await shot('Home');
};
`;

const imp = (f) => import(pathToFileURL(DIST + f).href);

// -- CHILD MODES -- //

/** `--setup`: registers this repo in the throwaway state folder and writes the trivial check. Throwaway home only: the approvals are minted here. */
async function setupMain() {
	const { mintApproval } = await imp('approve.js');
	const { addRoot } = await imp('roots.js');
	const { registerProject } = await imp('registry.js');
	const { scriptPath } = await imp('paths.js');
	const root = mintApproval('roots', REPO, { isTTY: true });
	addRoot(REPO, root.code);
	registerProject({ org: ORG, name: 'AFB', boardProject: 'AFB', repo: REPO, recipe: true });
	const file = scriptPath(ORG, ITEM, KEY);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, CHECK_SOURCE);
}

/** `--child <runId>`: one runCheck against a stub board. Prints `@@L <epoch ms> <line>` per log line and one `@@OUT <json>` at the end. */
async function childMain(runId) {
	const { runCheck } = await imp('run.js');
	const job = {
		kind: 'check',
		id: runId,
		project: { id: 'p', key: 'AFB' },
		item: { id: 'i', ref: ITEM },
		check: { key: KEY, script: null, coveredPaths: [], requiredTarget: 'preview' },
		target: 'preview',
		environment: {
			name: 'afb-checks',
			url: 'x',
			kind: 'preview',
			production: false,
			writeAllowed: true
		},
		readOnly: false,
		accounts: [],
		stepKey: null,
		registration: null
	};
	let n = 0;
	const fetchImpl = async (input) => {
		const path = String(input).split('/runner')[1] ?? String(input);
		if (path === '/claim') return Response.json({ job });
		if (path.startsWith('/runs/') && path.includes('/artifacts'))
			return Response.json({ attachmentId: 'att-' + ++n });
		return Response.json({ ok: true });
	};
	const startedAt = Date.now();
	const out = await runCheck({
		server: 'https://board.test',
		org: ORG,
		item: ITEM,
		key: KEY,
		dir: REPO,
		runId,
		runnerToken: 'afx_stub',
		personalToken: null,
		fetch: fetchImpl,
		log: (l) => process.stdout.write(`@@L ${Date.now()} ${String(l).replace(/\r?\n/g, ' | ')}\n`)
	});
	const endedAt = Date.now();
	process.stdout.write(
		`@@OUT ${JSON.stringify({ exitCode: out.exitCode, message: String(out.message).slice(0, 600), startedAt, endedAt })}\n`
	);
	process.exit(out.exitCode);
}

// -- HELPERS -- //

const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const secs = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / 100) / 10);
const fmt = (v) => (v === null || v === undefined ? '-' : v.toFixed(1));
const median = (a) => {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function dockerNames() {
	try {
		return execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
			encoding: 'utf8',
			timeout: 30_000
		})
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => s.startsWith('afb-checks-'));
	} catch {
		return [];
	}
}

/** The run ids this bench made up for its bridge runs. Only containers named after one of them (or the pool container of a bench home) are ever removed. */
const createdRunIds = new Set();

/** The pool containers recorded by the markers of a bench home (checks/pool/db-*.json), by the exact name written there. */
function poolContainersOf(home) {
	const dir = join(home, 'checks', 'pool');
	const names = [];
	try {
		for (const f of readdirSync(dir)) {
			if (!/^db-.*\.json$/.test(f) || f.endsWith('.runs.json')) continue;
			try {
				const v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
				if (typeof v.containerName === 'string' && v.containerName.startsWith('afb-checks-pool-'))
					names.push(v.containerName);
			} catch {
				/* A marker that cannot be read names nothing */
			}
		}
	} catch {
		/* No pool folder: nothing was pooled */
	}
	return names;
}

/**
 * Removes the containers this bench caused, by exact name: afb-checks-<run id> for a run id it created, the pool containers named in `extra`, and the names `own` lists
 * (the old tool prints its own). A container that merely starts with afb-checks- and belongs to somebody else's run is left alone and is not counted.
 * Only names that appeared since `before` are considered. Returns the names removed.
 */
function removeNewContainers(before, { extra = [], own = [] } = {}) {
	const mine = new Set([...[...createdRunIds].map((id) => `afb-checks-${id}`), ...extra, ...own]);
	const left = dockerNames().filter((n) => !before.includes(n) && mine.has(n));
	for (const name of left) {
		try {
			execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 60_000 });
		} catch {
			/* Reported as left behind by the next listing */
		}
	}
	return left;
}

/** Runs one process, collects stdout lines with their arrival time, and resolves with the exit code. */
function runProcess(command, args, opts) {
	return new Promise((resolveRun) => {
		const started = Date.now();
		const lines = [];
		const child = spawn(command, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		let buf = '';
		const take = (chunk) => {
			buf += chunk.toString('utf8');
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				lines.push({ at: Date.now(), text: buf.slice(0, i).replace(/\r$/, '') });
				buf = buf.slice(i + 1);
			}
		};
		child.stdout.on('data', take);
		child.stderr.on('data', take);
		const timer = setTimeout(() => {
			try {
				execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
			} catch {
				child.kill('SIGKILL');
			}
		}, RUN_LIMIT_MS);
		opts.track?.(child);
		child.on('close', (code) => {
			clearTimeout(timer);
			if (buf) lines.push({ at: Date.now(), text: buf });
			resolveRun({ code: code ?? -1, lines, wallMs: Date.now() - started, startedAt: started });
		});
	});
}

/** The stage seconds of one bridge run, from its `@@L` lines and its `@@OUT` record. */
function bridgeRun(res) {
	const logs = [];
	let out = null;
	for (const l of res.lines) {
		const m = /^@@L (\d+) (.*)$/.exec(l.text);
		if (m) logs.push({ ts: Number(m[1]), text: m[2] });
		else if (l.text.startsWith('@@OUT ')) {
			try {
				out = JSON.parse(l.text.slice(6));
			} catch {
				/* A broken record counts as no outcome */
			}
		}
	}
	const stage = {};
	const stageAt = {};
	for (const l of logs) {
		const m = /^Stage ([a-z-]+): ([0-9.]+)s$/.exec(l.text);
		if (m) {
			stage[m[1]] = Number(m[2]);
			stageAt[m[1]] = l.ts;
		}
	}
	const lastStep = [...logs].reverse().find((l) => /^\s+(PASS|FAIL) /.test(l.text));
	const row = {
		wall: secs(res.wallMs),
		ok: out ? out.exitCode === 0 : false,
		exitCode: out ? out.exitCode : res.code,
		message: out ? out.message : `no outcome record (exit ${res.code})`,
		copy: stage.copy ?? null,
		database: stage.database ?? null,
		install: stage.install ?? null,
		build: stage.build ?? null,
		start: stage['start-and-ready'] ?? null,
		pre: null,
		check: null,
		finish: null,
		proc: null,
		hit: logs.some((l) => /^Restored the kept (dependencies|build)/.test(l.text))
			? logs
					.filter((l) => /^Restored the kept/.test(l.text))
					.map((l) => (l.text.includes('dependencies') ? 'deps' : 'build'))
					.join('+')
			: ''
	};
	if (out) {
		row.proc = secs(res.wallMs - (out.endedAt - out.startedAt));
		const firstStage = Object.entries(stageAt).sort((a, b) => a[1] - b[1])[0];
		if (firstStage) row.pre = secs(firstStage[1] - stage[firstStage[0]] * 1000 - out.startedAt);
		if (stageAt['start-and-ready']) {
			const checkEnd = lastStep ? lastStep.ts : out.endedAt;
			row.check = secs(checkEnd - stageAt['start-and-ready']);
			row.finish = secs(out.endedAt - checkEnd);
		}
	}
	return row;
}

/** The old tool's run: only the wall time, the exit code and its last plain message line can be known from outside. */
function oldRun(res) {
	const texts = res.lines.map((l) => l.text.trim()).filter((t) => t && !t.startsWith('RESULT '));
	const last = texts.slice(-2).join(' / ').slice(0, 300);
	return {
		wall: secs(res.wallMs),
		ok: res.code === 0,
		exitCode: res.code,
		message: res.code === 0 ? 'passed' : last || 'no output'
	};
}

/** Samples the free memory once a second while `work` runs; aborts the children below the abort line. */
async function withMemory(work) {
	let min = freemem();
	const children = new Set();
	let aborted = false;
	const timer = setInterval(() => {
		const f = freemem();
		if (f < min) min = f;
		if (f < MEM_ABORT_BYTES && !aborted) {
			aborted = true;
			for (const c of children) {
				try {
					execFileSync('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
				} catch {
					/* Already gone */
				}
			}
		}
	}, 1000);
	try {
		const value = await work((c) => children.add(c));
		return { value, minFreeGB: Math.round((min / 1024 ** 3) * 10) / 10, aborted };
	} finally {
		clearInterval(timer);
	}
}

// -- BRIDGE -- //

async function bridgeBatch(home, n, tag, track) {
	const env = { ...process.env, AFB_BRIDGE_HOME: home };
	const tasks = [];
	for (let i = 0; i < n; i++) {
		const runId = `bench-${tag}-${i + 1}-${Math.random().toString(36).slice(2, 7)}`;
		createdRunIds.add(runId);
		tasks.push(
			runProcess(process.execPath, [join(HERE, 'checks-bench.mjs'), '--child', runId], {
				cwd: REPO,
				env,
				track
			}).then(bridgeRun)
		);
	}
	return Promise.all(tasks);
}

async function bridgeScenarios(wanted, results, notes) {
	const needHome = wanted.some((s) => ['cold1', 'second', 'warm8'].includes(s));
	let seqHome = null;
	const mkHome = async () => {
		const home = mkdtempSync(join(tmpdir(), 'afb-bench-home-'));
		const setup = await runProcess(process.execPath, [join(HERE, 'checks-bench.mjs'), '--setup'], {
			cwd: REPO,
			env: { ...process.env, AFB_BRIDGE_HOME: home }
		});
		if (setup.code !== 0) {
			notes.push(
				`Bridge setup failed (exit ${setup.code}): ${setup.lines
					.slice(-3)
					.map((l) => l.text)
					.join(' / ')
					.slice(0, 300)}`
			);
			rmSync(home, { recursive: true, force: true });
			return null;
		}
		return home;
	};
	const homes = [];
	try {
		if (needHome) {
			seqHome = await mkHome();
			if (seqHome) homes.push(seqHome);
		}
		const step = async (name, home, n, tag) => {
			const before = dockerNames();
			const m = await withMemory((track) => bridgeBatch(home, n, tag, track));
			const left = removeNewContainers(before, { extra: poolContainersOf(home) });
			results.push({
				tool: 'bridge',
				scenario: name,
				runs: m.value,
				minFreeGB: m.minFreeGB,
				aborted: m.aborted,
				leftContainers: left.length
			});
			console.log(`done bridge ${name}`);
		};
		if (seqHome && wanted.includes('cold1')) await step('bridge cold, 1 run', seqHome, 1, 'c1');
		if (seqHome && wanted.includes('second'))
			await step('bridge second run, same tree', seqHome, 1, 'c2');
		for (const [name, n] of [
			['cold4', 4],
			['cold8', 8]
		]) {
			if (!wanted.includes(name)) continue;
			const home = await mkHome();
			if (!home) continue;
			homes.push(home);
			await step(`bridge cold, ${n} at once`, home, n, name);
		}
		if (seqHome && wanted.includes('warm8')) await step('bridge warm, 8 at once', seqHome, 8, 'w8');
	} finally {
		for (const h of homes) rmSync(h, { recursive: true, force: true });
	}
}

// -- OLD TOOL -- //

/** What the old tool is given to run with: the system folders and the user profile it needs to find node, git and docker, and nothing else (no token, no .env value, no AFB_ setting). */
const OLD_ENV_NAMES = [
	'PATH',
	'Path',
	'PATHEXT',
	'SystemRoot',
	'SYSTEMROOT',
	'windir',
	'ComSpec',
	'TEMP',
	'TMP',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'HOME',
	'APPDATA',
	'LOCALAPPDATA',
	'ProgramFiles',
	'ProgramFiles(x86)',
	'ProgramData',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE'
];
const minimalEnv = () => {
	const env = {};
	for (const k of OLD_ENV_NAMES) if (process.env[k] !== undefined) env[k] = process.env[k];
	return env;
};

async function oldScenarios(wanted, oldDir, results, notes) {
	if (!wanted.some((s) => s.startsWith('old'))) return;
	const entry = join(oldDir, 'afb-checks.mjs');
	if (!existsSync(entry)) {
		notes.push(`The old tool is not at ${oldDir}.`);
		return;
	}
	const orgDir = join(oldDir, 'checks', ORG);
	const itemDir = join(orgDir, ITEM);
	const orgExisted = existsSync(orgDir);
	const oldOwn = new Set();
	mkdirSync(itemDir, { recursive: true });
	const file = join(itemDir, `${KEY}.mjs`);
	writeFileSync(file, CHECK_SOURCE);
	const run = (track) =>
		runProcess(process.execPath, [entry, 'run', ITEM, KEY, '--org', ORG], {
			cwd: oldDir,
			env: minimalEnv(),
			track
		}).then((res) => {
			// The containers the old tool names in its own output are its own
			for (const l of res.lines)
				for (const m of l.text.matchAll(/afb-checks-[A-Za-z0-9_.-]+/g)) oldOwn.add(m[0]);
			return oldRun(res);
		});
	try {
		const step = async (name, n) => {
			const before = dockerNames();
			const m = await withMemory((track) =>
				Promise.all(Array.from({ length: n }, () => run(track)))
			);
			const left = removeNewContainers(before, { own: [...oldOwn] });
			results.push({
				tool: 'old',
				scenario: name,
				runs: m.value,
				minFreeGB: m.minFreeGB,
				aborted: m.aborted,
				leftContainers: left.length
			});
			console.log(`done ${name}`);
		};
		if (wanted.includes('old1')) {
			await step('old, 1 run', 1);
			await step('old second run, same tree', 1);
		}
		if (wanted.includes('old4')) await step('old, 4 at once', 4);
		if (wanted.includes('old8')) await step('old, 8 at once', 8);
	} finally {
		rmSync(file, { force: true });
		try {
			rmdirSync(itemDir);
			if (!orgExisted && readdirSync(orgDir).length === 0) rmdirSync(orgDir);
		} catch {
			/* Not empty: someone else's files stay */
		}
	}
}

// -- REPORT -- //

function report(results, notes) {
	const lines = [];
	lines.push('| Scenario | Runs | Total s min / median / max | Failures | Min free GB |');
	lines.push('| --- | --- | --- | --- | --- |');
	for (const r of results) {
		const w = r.runs.map((x) => x.wall).filter((x) => x !== null);
		const fails = r.runs.filter((x) => !x.ok).length;
		lines.push(
			`| ${r.scenario} | ${r.runs.length} | ${fmt(Math.min(...w))} / ${fmt(median(w))} / ${fmt(Math.max(...w))} | ${fails} | ${r.minFreeGB}${r.minFreeGB * 1024 ** 3 < MEM_WARN_BYTES ? ' (UNDER 1.5)' : ''}${r.aborted ? ' ABORTED' : ''} |`
		);
	}
	lines.push('');
	lines.push(
		'Per run, bridge stage seconds (pre = claim, slot, browser; check = ready until the last step line; finish = uploads, report, teardown; proc = node start and exit):'
	);
	lines.push('');
	lines.push(
		'| Scenario | Run | Total | pre | copy | database | install | build | start | check | finish | proc | cache | Result |'
	);
	lines.push(
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	);
	for (const r of results.filter((x) => x.tool === 'bridge')) {
		r.runs.forEach((x, i) =>
			lines.push(
				`| ${r.scenario} | ${i + 1} | ${fmt(x.wall)} | ${fmt(x.pre)} | ${fmt(x.copy)} | ${fmt(x.database)} | ${fmt(x.install)} | ${fmt(x.build)} | ${fmt(x.start)} | ${fmt(x.check)} | ${fmt(x.finish)} | ${fmt(x.proc)} | ${x.hit || '-'} | ${x.ok ? 'pass' : 'FAIL'} |`
			)
		);
	}
	lines.push('');
	lines.push('Failures (message, shortened):');
	let any = false;
	for (const r of results)
		r.runs.forEach((x, i) => {
			if (x.ok) return;
			any = true;
			lines.push(
				`- ${r.scenario} run ${i + 1}: exit ${x.exitCode}: ${String(x.message).replace(/\s+/g, ' ').slice(0, 300)}`
			);
		});
	if (!any) lines.push('- none');
	lines.push('');
	lines.push(
		`Containers named afb-checks-* left behind and removed: ${results.map((r) => `${r.scenario}=${r.leftContainers}`).join(', ')}`
	);
	for (const n of notes) lines.push(`Note: ${n}`);
	return lines.join('\n');
}

// -- MAIN -- //

async function main() {
	const tools = arg('--tools', 'bridge,old').split(',');
	const wanted = arg('--scenarios', 'cold1,second,cold4,cold8,warm8,old1,old4,old8').split(',');
	// The old tool's folder is named by the person: there is no default path to somebody else's checkout
	const oldDir = arg('--old-dir', process.env.AFB_OLD_CHECKS_DIR ?? '');
	if (tools.includes('old') && wanted.some((w) => w.startsWith('old')) && !oldDir) {
		console.error(
			'Name the old tool folder with --old-dir <folder> (or set AFB_OLD_CHECKS_DIR), or leave the old tool out with --tools bridge.'
		);
		process.exit(2);
	}
	const results = [];
	const notes = [];
	if (tools.includes('bridge')) await bridgeScenarios(wanted, results, notes);
	if (tools.includes('old')) await oldScenarios(wanted, oldDir, results, notes);
	const text = report(results, notes);
	console.log(text);
	const md = arg('--md', '');
	if (md) writeFileSync(md, text + '\n');
}

if (process.argv.includes('--setup')) {
	await setupMain();
	process.exit(0);
} else if (process.argv.includes('--child')) await childMain(arg('--child', 'bench-run'));
else await main();
