// THE POOLED THROWAWAY DATABASES: ALL UNIT TESTS USE A FAKE DOCKER THAT UNDERSTANDS THE FEW SQL STATEMENTS THE POOL SENDS, SO NO CONTAINER IS EVER STARTED.
// One opt-in test (AFB_REAL_DOCKER=1) starts a real pool container (afb-checks-pool-...) and proves the isolation and the clone time.

// IMPORTED DEP-MODULES
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	DatabasePool,
	PoolUnavailableError,
	dropPooledDatabase,
	listPools,
	liveRunCount,
	poolIo,
	pooledNames,
	provisionDatabase,
	sweepPool,
	type DatabaseTemplate,
	type PoolMarker
} from './dbpool.js';
import { markerPath, poolDir } from './paths.js';
import { RunScope, sweepOrphans } from './scope.js';
import type { DockerRun } from './provision.js';

// -- FUNCTIONS -- //

type Fake = {
	docker: DockerRun;
	calls: string[][];
	sqls: string[];
	dbs: Map<string, string>;
	roles: Set<string>;
	containers: Set<string>;
	busy: { left: number };
	failPoolRun: { on: boolean };
	dockerDown: { on: boolean };
};

/** A docker that answers like the pool container does for the statements dbpool.ts sends. */
const fakeDocker = (): Fake => {
	const f: Fake = {
		calls: [],
		sqls: [],
		dbs: new Map([['postgres', '']]),
		roles: new Set(),
		containers: new Set(),
		busy: { left: 0 },
		failPoolRun: { on: false },
		dockerDown: { on: false },
		docker: async () => ({ status: 0, stdout: '', stderr: '' })
	};
	const ok = (stdout = ''): { status: number; stdout: string; stderr: string } => ({
		status: 0,
		stdout,
		stderr: ''
	});
	f.docker = async (args) => {
		f.calls.push(args);
		const [cmd] = args;
		if (cmd === 'version') return f.dockerDown.on ? { status: 1, stdout: '', stderr: '' } : ok();
		if (cmd === 'run') {
			const name = args[args.indexOf('--name') + 1];
			if (name.startsWith('afb-checks-pool-') && f.failPoolRun.on)
				return { status: 1, stdout: '', stderr: 'boom' };
			f.containers.add(name);
			return ok('id');
		}
		if (cmd === 'inspect') {
			return f.containers.has(args[1])
				? ok(JSON.stringify([{ State: { Running: true } }]))
				: { status: 1, stdout: '', stderr: 'no such' };
		}
		if (cmd === 'rm') {
			for (const a of args.slice(1)) f.containers.delete(a);
			return ok();
		}
		if (cmd === 'exec') {
			if (args[2] === 'pg_isready') return ok();
			const sql = args[args.length - 1];
			f.sqls.push(sql);
			const quoted = [...sql.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
			const ready = /datname='([^']+)'/.exec(sql);
			if (sql.startsWith('SELECT coalesce(shobj_description') && ready)
				return ok(f.dbs.get(ready[1]) ?? '');
			if (sql.startsWith('CREATE DATABASE')) {
				if (/TEMPLATE/.test(sql) && f.busy.left > 0) {
					f.busy.left--;
					return {
						status: 1,
						stdout: '',
						stderr: 'ERROR: source database "x" is being accessed by other users'
					};
				}
				f.dbs.set(quoted[0], '');
				return ok();
			}
			if (sql.startsWith('COMMENT ON DATABASE')) {
				f.dbs.set(quoted[0], 'afb-ready');
				return ok();
			}
			if (sql.startsWith('DROP DATABASE')) {
				f.dbs.delete(quoted[0]);
				return ok();
			}
			if (sql.startsWith('DROP ROLE')) {
				for (const q of quoted) f.roles.delete(q);
				return ok();
			}
			if (sql.includes('CREATE ROLE "afb')) {
				for (const q of quoted.filter((n) => n.startsWith('afb'))) f.roles.add(q);
				return ok();
			}
			return ok();
		}
		return ok();
	};
	return f;
};

const template = (counter: { warmed: string[] }, hash = 'm1'): DatabaseTemplate => ({
	recipeHash: 'r1',
	migrationHash: hash,
	warm: async (url) => {
		counter.warmed.push(url);
		await new Promise((r) => setTimeout(r, 30));
	}
});

describe('pooled databases', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-dbpool-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const make = (f: Fake, extra: Partial<ConstructorParameters<typeof DatabasePool>[0]> = {}) =>
		new DatabasePool({
			docker: f.docker,
			pickPort: async () => 6777,
			slots: 3,
			retryMs: 1,
			...extra
		});

	it('starts one pool container named afb-checks-pool-, on 127.0.0.1, sized to the slots, with a marker', async () => {
		const f = fakeDocker();
		const pool = make(f);
		const w = { warmed: [] as string[] };
		const db = await pool.acquireDatabase('r1', { template: template(w) });
		const run = f.calls.find((c) => c[0] === 'run');
		expect(run).toBeDefined();
		const name = run?.[run.indexOf('--name') + 1] ?? '';
		expect(name).toMatch(/^afb-checks-pool-[a-f0-9]{8}$/);
		expect(run?.[run.indexOf('-p') + 1]).toBe('127.0.0.1:6777:5432');
		expect(run).toContain(`max_connections=${3 * 12 + 20}`);
		expect(run?.join(' ')).not.toMatch(/5433/);
		const pools = listPools();
		expect(pools).toHaveLength(1);
		expect(pools[0].marker).toMatchObject({
			containerName: name,
			port: 6777,
			ownerPid: process.pid,
			slots: 3
		});
		expect(pools[0].ownerAlive).toBe(true);
		expect(db.poolId).toBe(pools[0].marker.poolId);
		expect(f.sqls).toContain('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC');
	});

	it('refuses port 5433 and the other forbidden ports before any container is started', async () => {
		for (const port of [5433, 5180, 5190]) {
			const f = fakeDocker();
			const pool = make(f, { pickPort: async () => port });
			await expect(
				pool.acquireDatabase('r1', { template: template({ warmed: [] }) })
			).rejects.toThrow(/may use/);
			expect(f.calls.some((c) => c[0] === 'run')).toBe(false);
			expect(listPools()).toHaveLength(0);
		}
	});

	it('gives each run its own roles, closes CONNECT to PUBLIC and grants it to that role only', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const w = { warmed: [] as string[] };
		const a = await pool.acquireDatabase('run-a', {
			runtimeRole: 'app_runtime',
			template: template(w)
		});
		const b = await pool.acquireDatabase('run-b', {
			runtimeRole: 'app_runtime',
			template: template(w)
		});
		expect(a.dbName).not.toBe(b.dbName);
		expect(a.roleName).not.toBe(b.roleName);
		expect(a.databaseUrl).toContain(`${a.roleName}:`);
		expect(a.databaseUrl).toContain(`/${a.dbName}`);
		expect(a.ownerUrl).not.toBe(a.databaseUrl);
		expect(a.databaseUrl).toMatch(/@127\.0\.0\.1:6777\//);
		const joined = f.sqls.join('\n');
		expect(joined).toContain(`REVOKE ALL ON DATABASE "${a.dbName}" FROM PUBLIC`);
		expect(joined).toContain(`GRANT CONNECT ON DATABASE "${a.dbName}" TO "${a.roleName}"`);
		expect(joined).not.toContain(`GRANT CONNECT ON DATABASE "${a.dbName}" TO "${b.roleName}"`);
		expect(joined).toContain(`ALTER DATABASE "${a.dbName}" CONNECTION LIMIT`);
		expect(joined).toContain('NOLOGIN');
		expect(joined).toMatch(
			new RegExp(`CREATE ROLE "${a.roleName}" LOGIN PASSWORD '[a-f0-9]+' IN ROLE "app_runtime"`)
		);
		// The template is closed too
		expect(joined).toMatch(/REVOKE ALL ON DATABASE "afbt_[a-f0-9]+" FROM PUBLIC/);
		expect(joined).toMatch(/ALTER DATABASE "afbt_[a-f0-9]+" ALLOW_CONNECTIONS false/);
	});

	it('refuses a runtime role that is not a plain, unreserved name', async () => {
		const f = fakeDocker();
		const pool = make(f);
		for (const role of ['postgres', 'pg_monitor', 'afbr_x', 'Bad-Name', 'a;drop']) {
			await expect(
				pool.acquireDatabase('r1', { runtimeRole: role, template: template({ warmed: [] }) })
			).rejects.toThrow(/plain role name/);
		}
	});

	it('warms the template once, for sequential and for concurrent runs, and again for a new migration hash', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const w = { warmed: [] as string[] };
		await Promise.all([
			pool.acquireDatabase('r1', { template: template(w) }),
			pool.acquireDatabase('r2', { template: template(w) }),
			pool.acquireDatabase('r3', { template: template(w) })
		]);
		await pool.acquireDatabase('r4', { template: template(w) });
		expect(w.warmed).toHaveLength(1);
		expect(w.warmed[0]).toMatch(/^postgresql:\/\/postgres:[a-f0-9]+@127\.0\.0\.1:6777\/afbt_/);
		await pool.acquireDatabase('r5', { template: template(w, 'm2') });
		expect(w.warmed).toHaveLength(2);
		expect(f.containers.size).toBe(1); // One container for all of it
	});

	it('drops a template whose warm-up failed and lets the next run warm it again', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		let n = 0;
		const t: DatabaseTemplate = {
			recipeHash: 'r',
			migrationHash: 'm',
			warm: async () => {
				if (n++ === 0) throw new Error('migration failed');
			}
		};
		await expect(pool.acquireDatabase('r1', { template: t })).rejects.toThrow('migration failed');
		expect([...f.dbs.keys()].filter((d) => d.startsWith('afbt_'))).toHaveLength(0);
		await pool.acquireDatabase('r2', { template: t });
		expect(n).toBe(2);
	});

	it('retries the clone while the template is busy', async () => {
		const f = fakeDocker();
		const pool = make(f);
		f.busy.left = 3;
		const db = await pool.acquireDatabase('r1', { template: template({ warmed: [] }) });
		expect(f.sqls.filter((s) => /^CREATE DATABASE .* TEMPLATE/.test(s))).toHaveLength(4);
		expect(f.dbs.has(db.dbName)).toBe(true);
	});

	it('drops the database and roles by the recorded names and keeps the pool while another run is live', async () => {
		const f = fakeDocker();
		const pool = make(f);
		const w = { warmed: [] as string[] };
		const a = await pool.acquireDatabase('r1', { template: template(w) });
		const b = await pool.acquireDatabase('r2', { template: template(w) });
		expect(liveRunCount(a.poolId)).toBe(2);
		await pool.releaseDatabase('r1');
		expect(f.dbs.has(a.dbName)).toBe(false);
		expect(f.dbs.has(b.dbName)).toBe(true);
		expect(f.roles.has(a.roleName)).toBe(false);
		expect(f.roles.has(b.roleName)).toBe(true);
		expect(f.containers.size).toBe(1);
		expect(liveRunCount(a.poolId)).toBe(1);
		await pool.releaseDatabase('r1'); // Twice is harmless
		await pool.releaseDatabase('r2');
		// The last run ended and this process owns the pool: the container goes, and only by its recorded name
		expect(f.containers.size).toBe(0);
		expect(listPools()).toHaveLength(0);
		const rm = f.calls.filter((c) => c[0] === 'rm');
		expect(rm).toHaveLength(1);
		expect(rm[0].slice(1).every((x) => x.startsWith('-') || x.startsWith('afb-checks-pool-'))).toBe(
			true
		);
	});

	it('gives the owner role BYPASSRLS (FORCE ROW LEVEL SECURITY seeds) and never the runtime role or the superuser', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const a = await pool.acquireDatabase('run-a', {
			runtimeRole: 'app_runtime',
			template: template({ warmed: [] })
		});
		const create = f.sqls.find((s) => s.includes('CREATE ROLE "afbo_run_a"')) ?? '';
		expect(create).toMatch(/CREATE ROLE "afbo_run_a" LOGIN BYPASSRLS PASSWORD '[a-f0-9]+'/);
		expect(create).not.toMatch(/SUPERUSER/);
		// The statements are sent as one batch: look at each CREATE ROLE on its own
		const statements = f.sqls.flatMap((q) => q.split(/;\s*(?=CREATE ROLE)/));
		const runtime = statements.find((q) => q.startsWith(`CREATE ROLE "${a.roleName}"`)) ?? '';
		expect(runtime).toMatch(/LOGIN PASSWORD/);
		expect(runtime).not.toMatch(/BYPASSRLS|SUPERUSER/);
		// The group role has no bypass either
		const group = statements.find((q) => q.includes('NOLOGIN')) ?? '';
		expect(group).not.toMatch(/BYPASSRLS|SUPERUSER/);
		expect(a.ownerUrl).not.toMatch(/postgres:/);
		expect(a.databaseUrl).not.toMatch(/postgres:/);
	});

	it('keeps the container when the owner process ends first and removes it when the last run ends in another process', async () => {
		const f = fakeDocker();
		const owner = make(f);
		const other = make(f);
		const w = { warmed: [] as string[] };
		const a = await owner.acquireDatabase('r1', { template: template(w) });
		await other.acquireDatabase('r2', { template: template(w) });
		expect(f.containers.size).toBe(1);
		// The owner process is gone (a pid that does not exist)
		const file = join(poolDir(), `db-${a.poolId}.json`);
		const marker = JSON.parse(readFileSync(file, 'utf8')) as PoolMarker;
		writeFileSync(file, JSON.stringify({ ...marker, ownerPid: 2147483000 }) + '\n');
		await owner.releaseDatabase('r1');
		// Another run is still live: the container stays
		expect(f.containers.size).toBe(1);
		// A new process still finds this pool and does not start a second container
		const third = make(f);
		await third.acquireDatabase('r3', { template: template(w) });
		expect(f.containers.size).toBe(1);
		await third.releaseDatabase('r3');
		expect(f.containers.size).toBe(1);
		// The last run ends in a process that does not own the pool: it removes the container, by its recorded name
		await other.releaseDatabase('r2');
		expect(f.containers.size).toBe(0);
		expect(listPools()).toHaveLength(0);
		const rm = f.calls.filter((c) => c[0] === 'rm');
		expect(rm).toHaveLength(1);
		expect(rm[0].slice(1).every((x) => x.startsWith('-') || x.startsWith('afb-checks-pool-'))).toBe(
			true
		);
	});

	it('retries the rename of the runs file while another process holds it (EPERM on Windows)', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		let fails = 6;
		poolIo.rename = (from, to) => {
			if (fails > 0 && to.endsWith('.runs.json')) {
				fails--;
				const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
				e.code = 'EPERM';
				throw e;
			}
			renameSync(from, to);
		};
		try {
			const db = await pool.acquireDatabase('r1', { template: template({ warmed: [] }) });
			expect(fails).toBe(0);
			expect(liveRunCount(db.poolId)).toBe(1);
			expect(readdirSync(poolDir()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
		} finally {
			poolIo.rename = (from, to) => renameSync(from, to);
		}
	});

	it('two processes ending together remove the container once', async () => {
		const f = fakeDocker();
		const a = make(f);
		const b = make(f);
		const w = { warmed: [] as string[] };
		await a.acquireDatabase('r1', { template: template(w) });
		await b.acquireDatabase('r2', { template: template(w) });
		await Promise.all([a.releaseDatabase('r1'), b.releaseDatabase('r2')]);
		expect(f.containers.size).toBe(0);
		expect(f.calls.filter((c) => c[0] === 'rm')).toHaveLength(1);
	});

	it('keeps the container when removeWhenIdle is off, and removes it on closePoolIfIdle', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		await pool.acquireDatabase('r1', { template: template({ warmed: [] }) });
		await pool.releaseDatabase('r1');
		expect(f.containers.size).toBe(1);
		expect(await pool.closePoolIfIdle()).toBe(true);
		expect(f.containers.size).toBe(0);
	});

	it('registers the names on the scope and closes the database when the scope closes', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const infos: unknown[] = [];
		const disposers: (() => void | Promise<void>)[] = [];
		const db = await pool.acquireDatabase('r1', {
			template: template({ warmed: [] }),
			scope: { add: (_n, d) => void disposers.push(d), setInfo: (i) => void infos.push(i) }
		});
		expect(infos).toEqual([{ dbName: db.dbName, roleName: db.roleName, poolId: db.poolId }]);
		expect(JSON.stringify(infos)).not.toContain('containerName');
		await disposers[0]();
		expect(f.dbs.has(db.dbName)).toBe(false);
	});

	it('every docker command it sends names an afb-checks- container', async () => {
		const f = fakeDocker();
		const pool = make(f);
		await pool.acquireDatabase('r1', {
			runtimeRole: 'app_runtime',
			template: template({ warmed: [] })
		});
		await pool.releaseDatabase('r1');
		for (const c of f.calls) {
			if (c[0] === 'version') continue;
			const target =
				c[0] === 'run' ? c[c.indexOf('--name') + 1] : c.slice(1).find((a) => !a.startsWith('-'));
			expect(target).toMatch(/^afb-checks-pool-/);
		}
	});

	it('refuses to drop names that are not a matched pair of ours, and a marker that names a foreign container', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const db = await pool.acquireDatabase('r1', { template: template({ warmed: [] }) });
		const before = f.calls.length;
		expect(
			await dropPooledDatabase(
				{ dbName: 'postgres', roleName: db.roleName, poolId: db.poolId },
				{ docker: f.docker }
			)
		).toBe(false);
		expect(
			await dropPooledDatabase(
				{ dbName: db.dbName, roleName: 'afbr_other', poolId: db.poolId },
				{ docker: f.docker }
			)
		).toBe(false);
		expect(f.calls.length).toBe(before);
		// A planted marker for the person's own container
		const planted: PoolMarker = {
			kind: 'db',
			poolId: 'abcdef12',
			containerName: 'afb-local-postgres-1',
			port: 6800,
			ownerPid: process.pid,
			ownerStartedAt: 0,
			image: 'x',
			maxConnections: 10,
			slots: 1,
			password: 'x',
			createdAt: new Date().toISOString()
		};
		writeFileSync(join(poolDir(), 'db-abcdef12.json'), JSON.stringify(planted));
		expect(listPools().map((p) => p.marker.poolId)).not.toContain('abcdef12');
		expect(
			await dropPooledDatabase(
				{ dbName: db.dbName, roleName: db.roleName, poolId: 'abcdef12' },
				{ docker: f.docker }
			)
		).toBe(false);
		expect(f.calls.length).toBe(before);
	});

	it('names the objects of a run the same way every time and shortens a long run id', () => {
		const a = pooledNames('r1abc-2');
		expect(a).toMatchObject({
			dbName: 'afbd_r1abc_2',
			roleName: 'afbr_r1abc_2',
			ownerRole: 'afbo_r1abc_2'
		});
		const long = pooledNames('x'.repeat(60));
		expect(long.dbName.length).toBeLessThan(63);
		expect(pooledNames('x'.repeat(60)).dbName).toBe(long.dbName);
		expect(() => pooledNames('../x')).toThrow();
	});

	it('falls back to a container for the run when the pool is unavailable', async () => {
		const f = fakeDocker();
		f.failPoolRun.on = true;
		const pool = make(f);
		const w = { warmed: [] as string[] };
		const logs: string[] = [];
		const added: string[] = [];
		const db = await provisionDatabase(
			'rfall',
			{ runId: 'rfall', add: (n) => void added.push(n), close: async () => {}, setInfo: () => {} },
			(l) => logs.push(l),
			{
				template: template(w),
				pool,
				docker: f.docker,
				pickPort: async () => 6778,
				runtimeRole: 'app_runtime'
			}
		);
		expect(db.pooled).toBe(false);
		expect(f.containers.has('afb-checks-rfall')).toBe(true);
		expect(w.warmed).toHaveLength(1);
		expect(w.warmed[0]).toMatch(/:6778\/app$/);
		expect(logs.join(' ')).toMatch(/not available/);
		expect(listPools()).toHaveLength(0);
	});

	it('uses the pool when Docker works, and says the pool is unavailable when Docker is down', async () => {
		const f = fakeDocker();
		const pool = make(f);
		const scope = { runId: 'r1', add: () => {}, close: async () => {}, setInfo: () => {} };
		const ok = await provisionDatabase('r1', scope, () => {}, {
			template: template({ warmed: [] }),
			pool,
			docker: f.docker
		});
		expect(ok.pooled).toBe(true);
		const down = fakeDocker();
		down.dockerDown.on = true;
		await expect(make(down).ensurePool()).rejects.toBeInstanceOf(PoolUnavailableError);
	});

	it('sweepOrphans drops only the dead run database and roles, never the pool, and the other run survives', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const w = { warmed: [] as string[] };
		const scopeA = new RunScope('rsweepa');
		const scopeB = new RunScope('rsweepb');
		const a = await pool.acquireDatabase('rsweepa', { template: template(w), scope: scopeA });
		const b = await pool.acquireDatabase('rsweepb', { template: template(w), scope: scopeB });
		const markerA = markerPath('rsweepa');
		const m = JSON.parse(readFileSync(markerA, 'utf8')) as Record<string, unknown>;
		expect(m).toMatchObject({ dbName: a.dbName, roleName: a.roleName, poolId: a.poolId });
		expect(m.containerName).toBeUndefined();
		// Run A's process dies mid-way: its marker names a dead process
		writeFileSync(markerA, JSON.stringify({ ...m, pid: 2_147_483_000 }));
		const cleaned = await sweepOrphans(() => {}, { docker: f.docker });
		expect(cleaned).toBe(1);
		expect(f.dbs.has(a.dbName)).toBe(false);
		expect(f.roles.has(a.roleName)).toBe(false);
		expect(f.dbs.has(b.dbName)).toBe(true);
		expect(f.roles.has(b.roleName)).toBe(true);
		expect(f.containers.size).toBe(1);
		expect(f.calls.some((c) => c[0] === 'rm')).toBe(false);
		expect(listPools()).toHaveLength(1);
		await scopeB.close();
		expect(f.dbs.has(b.dbName)).toBe(false);
	});

	it('a drop that failed keeps the run entry and says false; a drop that worked forgets the run (C10)', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const w = { warmed: [] as string[] };
		const scope = new RunScope('rdropfail');
		const a = await pool.acquireDatabase('rdropfail', { template: template(w), scope });
		const info = { dbName: a.dbName, roleName: a.roleName, poolId: a.poolId };
		expect(liveRunCount(a.poolId)).toBe(1);
		// The statement that removes the database answers with a failing exit status (no exception)
		const failing: DockerRun = async (args) => {
			const sql = args[args.length - 1] ?? '';
			if (args[0] === 'exec' && sql.startsWith('DROP DATABASE'))
				return { status: 1, stdout: '', stderr: 'database is being accessed by other users' };
			return f.docker(args);
		};
		expect(await dropPooledDatabase(info, { docker: failing })).toBe(false);
		expect(f.dbs.has(a.dbName)).toBe(true);
		// The entry is still there, so a later sweep (or the doctor) tries again
		expect(liveRunCount(a.poolId)).toBe(1);
		expect(await dropPooledDatabase(info, { docker: f.docker })).toBe(true);
		expect(f.dbs.has(a.dbName)).toBe(false);
		expect(liveRunCount(a.poolId)).toBe(0);
		await scope.close();
	});

	it('a failing role drop keeps the entry as well (C10)', async () => {
		const f = fakeDocker();
		const pool = make(f, { removeWhenIdle: false });
		const scope = new RunScope('rrolefail');
		const a = await pool.acquireDatabase('rrolefail', {
			template: template({ warmed: [] }),
			scope
		});
		const failing: DockerRun = async (args) => {
			const sql = args[args.length - 1] ?? '';
			if (args[0] === 'exec' && sql.startsWith('DROP ROLE'))
				return { status: 1, stdout: '', stderr: 'role is in use' };
			return f.docker(args);
		};
		expect(
			await dropPooledDatabase(
				{ dbName: a.dbName, roleName: a.roleName, poolId: a.poolId },
				{ docker: failing }
			)
		).toBe(false);
		expect(liveRunCount(a.poolId)).toBe(1);
		await scope.close();
	});

	describe('sweeping', () => {
		const plant = (
			poolId: string,
			over: Partial<PoolMarker>,
			runs: Record<string, unknown> = {}
		) => {
			mkdirSync(poolDir(), { recursive: true });
			const marker: PoolMarker = {
				kind: 'db',
				poolId,
				containerName: `afb-checks-pool-${poolId}`,
				port: 6801,
				ownerPid: 2_147_483_000,
				ownerStartedAt: 0,
				image: 'postgres:17',
				maxConnections: 60,
				slots: 4,
				password: 'x',
				createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
				...over
			};
			writeFileSync(join(poolDir(), `db-${poolId}.json`), JSON.stringify(marker));
			writeFileSync(join(poolDir(), `db-${poolId}.runs.json`), JSON.stringify({ runs }));
		};

		it('removes a pool whose owner is gone and that no run uses, and only that one', async () => {
			const f = fakeDocker();
			for (const n of [
				'afb-checks-pool-aaaaaa01',
				'afb-checks-pool-aaaaaa02',
				'afb-checks-pool-aaaaaa03',
				'afb-checks-pool-aaaaaa04'
			])
				f.containers.add(n);
			plant('aaaaaa01', {});
			plant('aaaaaa02', { ownerPid: process.pid }); // Owner alive
			plant(
				'aaaaaa03',
				{},
				{ rx: { pid: process.pid, at: 'x', dbName: 'afbd_rx', roleName: 'afbr_rx' } }
			); // A live run
			plant('aaaaaa04', { createdAt: new Date().toISOString() }); // Too young
			const removed = await sweepPool({ docker: f.docker });
			expect(removed).toEqual(['afb-checks-pool-aaaaaa01']);
			expect([...f.containers].sort()).toEqual([
				'afb-checks-pool-aaaaaa02',
				'afb-checks-pool-aaaaaa03',
				'afb-checks-pool-aaaaaa04'
			]);
		});
	});
});

// -- REAL DOCKER (OPT IN: AFB_REAL_DOCKER=1) -- //

describe.skipIf(process.env.AFB_REAL_DOCKER !== '1')(
	'pooled databases with the real Docker',
	() => {
		let home = '';
		let before: string | undefined;
		beforeEach(() => {
			before = process.env.AFB_BRIDGE_HOME;
			home = mkdtempSync(join(tmpdir(), 'afb-dbpool-real-'));
			process.env.AFB_BRIDGE_HOME = home;
		});
		afterEach(() => {
			if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
			else process.env.AFB_BRIDGE_HOME = before;
			rmSync(home, { recursive: true, force: true });
		});

		it('lets the owner role write a FORCE ROW LEVEL SECURITY table and refuses the runtime role without a tenant setting', async () => {
			const { realDocker } = await import('./provision.js');
			const pool = new DatabasePool({ slots: 2, removeWhenIdle: true });
			const psqlIn = (container: string, url: string, sql: string) =>
				realDocker(['exec', container, 'psql', url, '-v', 'ON_ERROR_STOP=1', '-qtAc', sql]);
			let container = '';
			try {
				const tpl: DatabaseTemplate = {
					recipeHash: 'real-rls',
					migrationHash: 'v1',
					warm: async (ownerUrl) => {
						const marker = listPools()[0].marker;
						const dbName = ownerUrl.split('/').pop() ?? '';
						const r = await realDocker([
							'exec',
							marker.containerName,
							'psql',
							'-U',
							'postgres',
							'-d',
							dbName,
							'-v',
							'ON_ERROR_STOP=1',
							'-qtAc',
							"CREATE TABLE org(id int primary key, tenant text); ALTER TABLE org ENABLE ROW LEVEL SECURITY; ALTER TABLE org FORCE ROW LEVEL SECURITY; CREATE POLICY org_t ON org USING (tenant = current_setting('app.tenant', true)) WITH CHECK (tenant = current_setting('app.tenant', true)); GRANT SELECT, INSERT ON org TO app_runtime"
						]);
						expect(r.status, r.stderr).toBe(0);
					}
				};
				const a = await pool.acquireDatabase('real-rls', {
					runtimeRole: 'app_runtime',
					template: tpl
				});
				container = listPools()[0].marker.containerName;
				const port = listPools()[0].marker.port;
				const inside = (url: string) => url.replace(`@127.0.0.1:${port}`, '@127.0.0.1:5432');
				const owner = await psqlIn(
					container,
					inside(a.ownerUrl),
					"INSERT INTO org VALUES (1, 'seeded')"
				);
				expect(owner.status, owner.stderr).toBe(0);
				const runtime = await psqlIn(
					container,
					inside(a.databaseUrl),
					"INSERT INTO org VALUES (2, 'nope')"
				);
				expect(runtime.status).not.toBe(0);
				expect(runtime.stderr).toMatch(/row-level security/i);
				const bypass = await psqlIn(
					container,
					inside(a.databaseUrl),
					`SELECT rolbypassrls FROM pg_roles WHERE rolname='${a.roleName}'`
				);
				expect(bypass.stdout.trim()).toBe('f');
				await pool.releaseDatabase('real-rls');
			} finally {
				await pool.closePoolIfIdle().catch(() => undefined);
				if (container.startsWith('afb-checks-pool-'))
					await realDocker(['rm', '-f', '-v', container]);
			}
		}, 240_000);

		it('isolates run A from run B and clones the template fast', async () => {
			const { realDocker } = await import('./provision.js');
			const pool = new DatabasePool({ slots: 2, removeWhenIdle: true });
			const psqlIn = (container: string, url: string, sql: string) =>
				realDocker(['exec', container, 'psql', url, '-v', 'ON_ERROR_STOP=1', '-qtAc', sql]);
			const t0 = Date.now();
			let container = '';
			try {
				const tpl: DatabaseTemplate = {
					recipeHash: 'real-test',
					migrationHash: 'v1',
					warm: async (ownerUrl) => {
						const marker = listPools()[0].marker;
						const dbName = ownerUrl.split('/').pop() ?? '';
						const r = await realDocker([
							'exec',
							marker.containerName,
							'psql',
							'-U',
							'postgres',
							'-d',
							dbName,
							'-v',
							'ON_ERROR_STOP=1',
							'-qtAc',
							"CREATE TABLE notes(id int primary key, body text); INSERT INTO notes VALUES (1,'seed'); GRANT SELECT, INSERT ON notes TO app_runtime"
						]);
						expect(r.status, r.stderr).toBe(0);
					}
				};
				const a = await pool.acquireDatabase('real-a', {
					runtimeRole: 'app_runtime',
					template: tpl
				});
				const firstMs = Date.now() - t0;
				container = listPools()[0].marker.containerName;
				const t1 = Date.now();
				const b = await pool.acquireDatabase('real-b', {
					runtimeRole: 'app_runtime',
					template: tpl
				});
				const cloneMs = Date.now() - t1;
				console.log(
					`POOL TIMING first run (pool start + template warm + clone): ${firstMs} ms; second run (clone only): ${cloneMs} ms`
				);
				const tpl2 = Date.now();
				const c = await pool.acquireDatabase('real-c', {
					runtimeRole: 'app_runtime',
					template: tpl
				});
				console.log(`POOL TIMING third run: ${Date.now() - tpl2} ms`);
				// A runs inside its own database and sees the seeded row; the same role cannot reach B's database
				const own = await psqlIn(
					container,
					a.databaseUrl.replace('@127.0.0.1:' + listPools()[0].marker.port, '@127.0.0.1:5432'),
					'SELECT body FROM notes WHERE id=1'
				);
				expect(own.status, own.stderr).toBe(0);
				expect(own.stdout.trim()).toBe('seed');
				const cross = await psqlIn(
					container,
					`postgresql://${a.roleName}@127.0.0.1:5432/${b.dbName}`,
					'SELECT 1'
				);
				expect(cross.status).not.toBe(0);
				expect(cross.stderr).toMatch(/permission denied for database|not permitted|denied/i);
				// The owner role of A owns its objects and cannot reach B either
				const ownerCross = await psqlIn(
					container,
					`postgresql://afbo_real_a@127.0.0.1:5432/${b.dbName}`,
					'SELECT 1'
				);
				expect(ownerCross.status).not.toBe(0);
				const ownerOwn = await psqlIn(
					container,
					a.ownerUrl.replace('@127.0.0.1:' + listPools()[0].marker.port, '@127.0.0.1:5432'),
					'ALTER TABLE notes ADD COLUMN extra text'
				);
				expect(ownerOwn.status, ownerOwn.stderr).toBe(0);
				// Writes in A do not show in C
				await psqlIn(
					container,
					`postgresql://${a.roleName}@127.0.0.1:5432/${a.dbName}`,
					"INSERT INTO notes VALUES (2,'only in a')"
				);
				const inC = await psqlIn(
					container,
					`postgresql://${c.roleName}@127.0.0.1:5432/${c.dbName}`,
					'SELECT count(*) FROM notes'
				);
				expect(inC.stdout.trim()).toBe('1');
				expect(cloneMs).toBeLessThan(3000);
				await pool.releaseDatabase('real-a');
				await pool.releaseDatabase('real-b');
				await pool.releaseDatabase('real-c');
			} finally {
				// Safety net: the idle release removes the container, and this removes it if a step failed first
				await pool.closePoolIfIdle().catch(() => undefined);
				if (container.startsWith('afb-checks-pool-'))
					await realDocker(['rm', '-f', '-v', container]);
			}
		}, 240_000);
	}
);
