// TESTS OF `check import-legacy`: FIXTURE FOLDERS MADE IN A TEMP DIR THAT MIMIC THE OLD LAYOUT (NEVER THE REAL OLD TOOL).

// -- DEP-MODULES -- //
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { mintApproval } from './approve.js';
import { verifyAudit } from './audit.js';
import { importLegacy, importLegacyCommand } from './importlegacy.js';
import type { ImportSummary } from './importlegacy.js';
import { scriptPath } from './paths.js';
import { findRegistration, listRegistrations } from './registry.js';
import { addRoot } from './roots.js';

// -- MOCKS -- //

/** Every path the code under test asked the file system to read, stat or list (the real calls still run). */
const touched = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs')>();
	const watch = <F extends (...a: never[]) => unknown>(fn: F): F =>
		((...args: never[]) => {
			const first: unknown = args[0];
			if (typeof first === 'string') touched.paths.push(first);
			return fn(...args);
		}) as F;
	return {
		...real,
		readFileSync: watch(real.readFileSync),
		readdirSync: watch(real.readdirSync),
		lstatSync: watch(real.lstatSync),
		statSync: watch(real.statSync),
		existsSync: watch(real.existsSync),
		openSync: watch(real.openSync),
		realpathSync: Object.assign(watch(real.realpathSync), {
			native: watch(real.realpathSync.native)
		})
	};
});

// -- FUNCTIONS -- //

describe('import-legacy', () => {
	let base = '';
	let work = '';
	let old = '';
	let saved: string | undefined;
	const lines: string[] = [];
	const outs: string[] = [];
	const ctx = () => ({ log: (l: string) => lines.push(l), out: (l: string) => outs.push(l) });

	const repoAt = (name: string, parent = work) => {
		const dir = join(parent, name);
		mkdirSync(join(dir, '.git'), { recursive: true });
		mkdirSync(join(dir, 'web'), { recursive: true });
		const pkg = JSON.stringify({ scripts: { preview: 'vite preview', build: 'vite build' } });
		writeFileSync(join(dir, 'package.json'), pkg);
		writeFileSync(join(dir, 'web', 'package.json'), pkg);
		return realpathSync.native(dir);
	};
	const project = (key: string, body: object, org = 'acme') => {
		const dir = join(old, 'data', 'projects', org);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${key}.json`), JSON.stringify(body));
	};
	const script = (item: string, key: string, body: string, org = 'acme') => {
		const dir = join(old, 'checks', org, item);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${key}.mjs`), body);
	};
	const header =
		'// afb-registration: HAPRM\n// a check\nexport default async (page) => { await page.goto("/"); };\n';

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-legacy-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		work = join(base, 'work');
		mkdirSync(work);
		work = realpathSync.native(work);
		old = join(base, 'old-tool');
		mkdirSync(old);
		lines.length = 0;
		outs.length = 0;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	it('re-registers a project inside an approved root with adoption off and no pin', () => {
		addRoot(work, mintApproval('roots', work, { isTTY: true }).code);
		const repo = repoAt('hapr');
		project('HAPRM', {
			repo,
			appDir: 'web',
			boardProject: 'HAPR',
			recipe: false,
			database: 'none'
		});
		const s = importLegacy({ from: old, org: 'acme' });
		expect(s.projects.registered).toEqual(['HAPRM']);
		const reg = findRegistration('acme', 'HAPRM');
		expect(reg).toMatchObject({
			boardProject: 'HAPR',
			appDir: 'web',
			adoptEnv: false,
			uploadSignedInPictures: false
		});
		expect(reg?.pin).toBeUndefined();
		expect(s.todo.join(' ')).toMatch(/check secrets import/);
		expect(s.todo.join(' ')).toMatch(/check login HAPRM --org acme/);
		expect(s.todo.join(' ')).toMatch(/stop the old worker/);
		expect(verifyAudit().ok).toBe(true);
	});

	it('skips a repo outside every approved root and lists the exact command', () => {
		const outside = join(base, 'elsewhere');
		mkdirSync(outside);
		const repo = repoAt('far', outside);
		project('FAR', { repo, boardProject: 'FAR' });
		const s = importLegacy({ from: old, org: 'acme' });
		expect(s.projects.registered).toEqual([]);
		expect(s.projects.skipped[0]).toMatchObject({ name: 'FAR' });
		expect(s.projects.skipped[0]?.next).toMatch(
			/check roots add .* with an approval code|check roots add .*--approval <code>/
		);
		expect(listRegistrations('acme')).toEqual([]);
		expect(s.ok).toBe(false);
	});

	it('does not register a live site without the owner code, and says how', () => {
		project('HAPRD', {
			url: 'https://demo.example.com',
			boardProject: 'HAPR',
			extraHosts: ['cdn.example.com']
		});
		const s = importLegacy({ from: old, org: 'acme' });
		expect(s.projects.skipped[0]?.next).toMatch(
			/check approve --request --action register --target HAPRD.*--url https:\/\/demo.example.com --extra-hosts cdn.example.com/
		);
		expect(listRegistrations('acme')).toEqual([]);
	});

	it('leaves an existing registration as it is', () => {
		addRoot(work, mintApproval('roots', work, { isTTY: true }).code);
		const repo = repoAt('same');
		project('SAME', { repo, boardProject: 'SAME' });
		importLegacy({ from: old, org: 'acme' });
		const again = importLegacy({ from: old, org: 'acme' });
		expect(again.projects.unchanged).toEqual(['SAME']);
		expect(again.projects.registered).toEqual([]);
	});

	it('notes the old build and start commands that are not copied', () => {
		addRoot(work, mintApproval('roots', work, { isTTY: true }).code);
		project('CMD', {
			repo: repoAt('cmd'),
			boardProject: 'CMD',
			build: 'pnpm build',
			start: 'pnpm preview --port {port}'
		});
		const s = importLegacy({ from: old, org: 'acme' });
		expect(s.notes[0]).toMatch(/CMD: the old build and start commands are not copied/);
	});

	it('copies scripts unchanged with their headers, lints them, and lists conflicts', () => {
		script('AFB-1', 'home', header);
		script(
			'AFB-1',
			'bad',
			'// afb-registration: X\nimport fs from "node:fs";\nprocess.env.SECRET;\n'
		);
		script('AFB-2', 'same', header);
		script('AFB-3', 'diff', header);
		mkdirSync(join(process.env.AFB_BRIDGE_HOME ?? '', 'checks', 'scripts', 'acme', 'AFB-2'), {
			recursive: true
		});
		writeFileSync(scriptPath('acme', 'AFB-2', 'same'), header);
		writeFileSync(scriptPath('acme', 'AFB-2', 'same'), header);
		mkdirSync(join(process.env.AFB_BRIDGE_HOME ?? '', 'checks', 'scripts', 'acme', 'AFB-3'), {
			recursive: true
		});
		writeFileSync(scriptPath('acme', 'AFB-3', 'diff'), '// mine\n');
		const s = importLegacy({ from: old, org: 'acme' });
		expect(s.scripts).toMatchObject({ found: 4, copied: 1, same: 1, conflicts: ['AFB-3/diff'] });
		expect(s.scripts.rejected).toHaveLength(1);
		expect(s.scripts.rejected[0]).toMatchObject({ item: 'AFB-1', key: 'bad' });
		expect(readFileSync(scriptPath('acme', 'AFB-1', 'home'), 'utf8')).toBe(header);
		// The conflicting script is untouched, the rejected one was not copied
		expect(readFileSync(scriptPath('acme', 'AFB-3', 'diff'), 'utf8')).toBe('// mine\n');
		expect(() => readFileSync(scriptPath('acme', 'AFB-1', 'bad'))).toThrow();
	});

	it('reads only the project files of the organisation and ignores other folders and other organisations', () => {
		project('OTHER', { url: 'https://x.example.com' }, 'zeta');
		mkdirSync(join(old, 'data', 'profiles'), { recursive: true });
		writeFileSync(join(old, 'data', 'profiles', 'secret.json'), '{"password":"hunter2"}');
		mkdirSync(join(old, 'data', 'projects', 'acme'), { recursive: true });
		writeFileSync(join(old, 'data', 'projects', 'acme', 'notes.txt'), 'x');
		script('AFB-1', 'ok', header, 'zeta');
		const s = importLegacy({ from: old, org: 'acme', dryRun: true });
		expect(s.projects.found).toBe(0);
		expect(s.scripts.found).toBe(0);
		expect(JSON.stringify(s)).not.toContain('hunter2');
	});

	it('a dry run changes nothing and writes no audit line', () => {
		addRoot(work, mintApproval('roots', work, { isTTY: true }).code);
		project('DRY', { repo: repoAt('dry'), boardProject: 'DRY' });
		script('AFB-1', 'home', header);
		const before = verifyAudit().lines;
		const s = importLegacy({ from: old, org: 'acme', dryRun: true });
		expect(s.dryRun).toBe(true);
		expect(s.projects.registered).toEqual(['DRY']);
		expect(s.scripts.copied).toBe(1);
		expect(listRegistrations('acme')).toEqual([]);
		expect(() => readFileSync(scriptPath('acme', 'AFB-1', 'home'))).toThrow();
		expect(verifyAudit().lines).toBe(before);
	});

	it('writes one audit line with counts only', () => {
		addRoot(work, mintApproval('roots', work, { isTTY: true }).code);
		project('AUD', { repo: repoAt('aud'), boardProject: 'AUD' });
		const lastBefore = verifyAudit().lines;
		importLegacy({ from: old, org: 'acme' });
		const log = readFileSync(join(process.env.AFB_BRIDGE_HOME ?? '', 'checks', 'audit.log'), 'utf8')
			.trim()
			.split('\n');
		const last = JSON.parse(log[log.length - 1] ?? '{}') as {
			action: string;
			detail: Record<string, unknown>;
		};
		expect(last.action).toBe('import-legacy');
		expect(last.detail).toMatchObject({ org: 'acme', projects: 1, registered: 1 });
		expect(verifyAudit().lines).toBeGreaterThan(lastBefore);
	});

	it('the command prints json, exits 1 when something was skipped, 2 on a usage error', async () => {
		project('LIVE', { url: 'https://live.example.com' });
		const code = await importLegacyCommand(
			['import-legacy', '--from', old, '--org', 'acme', '--json'],
			ctx()
		);
		expect(code).toBe(1);
		const s = JSON.parse(outs[0] ?? '{}') as ImportSummary;
		expect(s.projects.skipped).toHaveLength(1);
		expect(await importLegacyCommand(['--org', 'acme'], ctx())).toBe(2);
		expect(await importLegacyCommand(['--from', join(base, 'nope'), '--org', 'acme'], ctx())).toBe(
			1
		);
		expect(await importLegacyCommand(['--from', old, '--org', 'Bad Org'], ctx())).toBe(2);
		const clean = join(base, 'empty-old');
		mkdirSync(clean);
		expect(await importLegacyCommand(['--from', clean, '--org', 'acme'], ctx())).toBe(0);
	});

	it('opens nothing of the old tool outside data/projects/<org> and checks/<org>, whatever else lies there', () => {
		addRoot(work, mintApproval('roots', work, { isTTY: true }).code);
		const repo = repoAt('hapr');
		project('HAPRM', {
			repo,
			appDir: 'web',
			boardProject: 'HAPR',
			recipe: false,
			database: 'none'
		});
		script('AFB-20261108-0001', 'M1', header);
		// Decoys: another organisation, the old tool's own sign-ins and tokens, an env file and a project file with a dangerous name
		project('OTHERP', { repo, boardProject: 'OTH' }, 'otherorg');
		script('AFB-20261108-0002', 'M2', header, 'otherorg');
		mkdirSync(join(old, 'data', 'auth'), { recursive: true });
		writeFileSync(join(old, 'data', 'auth', 'state.json'), '{"cookies":[]}');
		mkdirSync(join(old, 'data', 'tokens'), { recursive: true });
		writeFileSync(
			join(old, 'data', 'tokens', 'token.json'),
			'{"token":"afx_secret_secret_secret"}'
		);
		writeFileSync(join(old, '.env'), 'KEY=value-that-must-not-be-read');
		writeFileSync(join(old, 'data', 'secrets.json'), '{}');
		touched.paths.length = 0;
		const s = importLegacy({ from: old, org: 'acme' });
		expect(s.projects.registered).toEqual(['HAPRM']);
		const inOld = touched.paths
			.map((p) => relative(old, p))
			.filter((r) => r === '' || (!r.startsWith('..') && !r.includes(':')))
			.map((r) => r.split(sep).join('/'));
		expect(inOld.length).toBeGreaterThan(0);
		for (const r of inOld) {
			const allowed =
				r === '' ||
				r === 'data/projects/acme' ||
				r.startsWith('data/projects/acme/') ||
				r === 'checks/acme' ||
				r.startsWith('checks/acme/');
			expect(allowed, `the import touched ${r}`).toBe(true);
		}
		// And the decoys are named nowhere
		expect(inOld.some((r) => /otherorg|auth|tokens|secrets|\.env/.test(r))).toBe(false);
	});
});
