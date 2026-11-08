// TESTS OF THE REGISTRATIONS: SAVE, LIST, FORGET, EVERY UNIQUENESS RULE, THE FOLDER RULES BY REAL PATH, THE STATE REFUSAL, THE APPROVALS AND THE PIN.

// -- DEP-MODULES -- //
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { mintApproval } from './approve.js';
import { verifyAudit } from './audit.js';
import { registrationsDir, stateDirFor } from './paths.js';
import {
	checkAppDir,
	cleanExtraHosts,
	cleanSiteUrl,
	configFor,
	findRegistration,
	forgetRegistration,
	hasState,
	listRegistrations,
	nameClash,
	nameShadowsBoard,
	normaliseAppDir,
	pinRegistration,
	pinState,
	readRegistrations,
	registerProject,
	registryIo,
	saveRegistration,
	repoHeldBySibling,
	repoHeldElsewhere
} from './registry.js';
import { addRoot } from './roots.js';

// -- FUNCTIONS -- //

describe('registry', () => {
	let base = '';
	let work = '';
	let saved: string | undefined;
	const repoAt = (name: string, appDirs: string[] = []) => {
		const dir = join(work, name);
		mkdirSync(join(dir, '.git'), { recursive: true });
		const pkg = JSON.stringify({ scripts: { preview: 'vite preview', build: 'vite build' } });
		if (!appDirs.length) writeFileSync(join(dir, 'package.json'), pkg);
		for (const a of appDirs) {
			mkdirSync(join(dir, a), { recursive: true });
			writeFileSync(join(dir, a, 'package.json'), pkg);
		}
		return realpathSync.native(dir);
	};
	const code = (action: string, target: string) =>
		mintApproval(action, target, { isTTY: true }).code;

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-registry-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		work = join(base, 'work');
		mkdirSync(work);
		work = realpathSync.native(work);
		addRoot(work, code('roots', work));
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	describe('save, list, forget', () => {
		it('saves a registration under its organisation and lists it', () => {
			const repo = repoAt('app');
			const reg = registerProject({ org: 'acme', name: 'AFB', repo });
			expect(reg).toMatchObject({
				org: 'acme',
				name: 'AFB',
				boardProject: 'AFB',
				repo,
				adoptEnv: false
			});
			expect(listRegistrations('acme')).toHaveLength(1);
			expect(listRegistrations('other')).toHaveLength(0);
			expect(findRegistration('acme', 'afb')?.name).toBe('AFB');
			expect(registrationsDir()).toBeTruthy();
		});
		it('updates the same name without losing its creation time', () => {
			const repo = repoAt('app');
			const a = registerProject({ org: 'acme', name: 'AFB', repo });
			const b = registerProject({ org: 'acme', name: 'AFB', repo, boardProject: 'OTHER' });
			expect(b.createdAt).toBe(a.createdAt);
			expect(listRegistrations('acme')).toHaveLength(1);
			expect(findRegistration('acme', 'AFB')?.boardProject).toBe('OTHER');
		});
		it('refuses bad names, keys and organisations', () => {
			const repo = repoAt('app');
			expect(() => registerProject({ org: 'acme', name: 'a/b', repo })).toThrow(
				/registration name/
			);
			expect(() => registerProject({ org: 'acme', name: 'x'.repeat(33), repo })).toThrow(
				/registration name/
			);
			expect(() => registerProject({ org: 'acme', name: '..', repo })).toThrow(/registration name/);
			expect(() => registerProject({ org: 'acme', name: 'my-app', repo })).toThrow(/board project/);
			expect(() => registerProject({ org: 'Bad Org', name: 'AFB', repo })).toThrow(/slug/);
			expect(() => registerProject({ org: 'acme', name: 'AFB' })).toThrow(/either a repo/);
			expect(() =>
				registerProject({ org: 'acme', name: 'AFB', repo, url: 'https://x.test' })
			).toThrow(/either a repo/);
		});
		it('forgets the state, and removes the registration only with remove', () => {
			const reg = registerProject({ org: 'acme', name: 'AFB', repo: repoAt('app') });
			mkdirSync(stateDirFor('acme', 'AFB'), { recursive: true });
			writeFileSync(join(stateDirFor('acme', 'AFB'), 'secrets.json'), 'x');
			expect(hasState('acme', 'AFB')).toBe(true);
			expect(forgetRegistration('acme', 'afb')).toEqual({
				name: 'AFB',
				hadState: true,
				removed: false
			});
			expect(hasState('acme', 'AFB')).toBe(false);
			expect(findRegistration('acme', reg.name)).not.toBeNull();
			expect(forgetRegistration('acme', 'AFB', { remove: true }).removed).toBe(true);
			expect(findRegistration('acme', 'AFB')).toBeNull();
			expect(() => forgetRegistration('acme', 'AFB')).toThrow(/no registration/);
		});
		it('does not trust a registration file that was edited by hand', () => {
			registerProject({ org: 'acme', name: 'AFB', repo: repoAt('app') });
			const file = join(registrationsDir(), 'acme', 'AFB.json');
			const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
			doc.adoptEnv = true;
			writeFileSync(file, JSON.stringify(doc));
			const { registrations, problems } = readRegistrations('acme');
			expect(registrations).toEqual([]);
			expect(problems[0]).toMatch(/changed outside/);
			writeFileSync(file, '{ not json');
			expect(readRegistrations('acme').problems[0]).toMatch(/cannot be read/);
		});
		it('audits every change, and the chain stays true', () => {
			registerProject({ org: 'acme', name: 'AFB', repo: repoAt('app') });
			forgetRegistration('acme', 'AFB', { remove: true });
			const log = readFileSync(join(base, 'bridge-home', 'checks', 'audit.log'), 'utf8');
			expect(log).toContain('registration added');
			expect(log).toContain('registration removed');
			expect(verifyAudit().ok).toBe(true);
		});
	});

	describe('several writers at once', () => {
		afterEach(() => {
			registryIo.rename = (from, to) => renameSync(from, to);
		});
		const regOf = (n: number) => ({
			org: 'acme',
			name: 'AFB',
			boardProject: `P${n}`,
			recipe: false,
			database: 'none' as const,
			adoptEnv: false,
			uploadSignedInPictures: false,
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		it('retries the rename after EPERM, EBUSY and EACCES and then saves', () => {
			let fails = 3;
			const codes = ['EPERM', 'EBUSY', 'EACCES'];
			registryIo.rename = (from, to) => {
				if (fails > 0) {
					const e = new Error('operation not permitted') as NodeJS.ErrnoException;
					e.code = codes[3 - fails--];
					throw e;
				}
				renameSync(from, to);
			};
			saveRegistration(regOf(1));
			expect(fails).toBe(0);
			expect(findRegistration('acme', 'AFB')?.boardProject).toBe('P1');
			expect(readdirSync(join(registrationsDir(), 'acme'))).toEqual(['AFB.json']);
		});
		it('gives up on an error that is not a busy file, and leaves no temp file', () => {
			registryIo.rename = () => {
				const e = new Error('no such') as NodeJS.ErrnoException;
				e.code = 'ENOENT';
				throw e;
			};
			expect(() => saveRegistration(regOf(1))).toThrow(/no such/);
			expect(readdirSync(join(registrationsDir(), 'acme'))).toEqual([]);
		});
		it('many writers of one file end with one whole, trusted file, even when the first renames fail', async () => {
			let fails = 4;
			registryIo.rename = (from, to) => {
				if (fails > 0) {
					fails--;
					const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
					e.code = 'EPERM';
					throw e;
				}
				renameSync(from, to);
			};
			await Promise.all(
				Array.from({ length: 12 }, (_, i) =>
					Promise.resolve().then(() => saveRegistration(regOf(i)))
				)
			);
			const got = readRegistrations('acme');
			expect(got.problems).toEqual([]);
			expect(got.registrations).toHaveLength(1);
			expect(readdirSync(join(registrationsDir(), 'acme'))).toEqual(['AFB.json']);
		});
	});

	describe('uniqueness rules', () => {
		it('names are unique without regard to letter case', () => {
			registerProject({ org: 'acme', name: 'HAPRM', repo: repoAt('a'), boardProject: 'HAPR' });
			expect(() =>
				registerProject({ org: 'acme', name: 'haprm', repo: repoAt('b'), boardProject: 'HAPR' })
			).toThrow(/unique without regard/);
			expect(nameClash('acme', 'haprm')).toBe('acme/HAPRM');
			// Another organisation may use the name
			expect(nameClash('beta', 'haprm')).toBeNull();
		});
		it('a name may not shadow the board project another registration serves', () => {
			registerProject({ org: 'acme', name: 'HAPRM', repo: repoAt('a'), boardProject: 'HAPR' });
			// A registration named HAPR that serves another project would be confused with the board project HAPR
			expect(() =>
				registerProject({ org: 'acme', name: 'HAPR', repo: repoAt('b'), boardProject: 'AFB' })
			).toThrow(/shadow/);
			expect(nameShadowsBoard('acme', 'HAPR', 'AFB')).toBe('acme/HAPRM');
			// And the other way round: a new registration serving a project that another registration is named after
			registerProject({ org: 'acme', name: 'WEB', repo: repoAt('c'), boardProject: 'WEBX' });
			expect(() =>
				registerProject({ org: 'acme', name: 'OTHER', repo: repoAt('d'), boardProject: 'WEB' })
			).toThrow(/shadow/);
			// A registration named after the board project it serves is fine
			expect(
				registerProject({ org: 'acme', name: 'HAPR', repo: repoAt('e'), boardProject: 'HAPR' }).name
			).toBe('HAPR');
		});
		it('one organisation per folder', () => {
			const repo = repoAt('a');
			registerProject({ org: 'acme', name: 'A1', repo });
			expect(repoHeldElsewhere('beta', repo)).toBe('acme/A1');
			expect(repoHeldElsewhere('acme', repo)).toBeNull();
			expect(() => registerProject({ org: 'beta', name: 'B1', repo })).toThrow(
				/another organisation/
			);
			// Not even a folder inside it
			expect(repoHeldElsewhere('beta', join(repo, 'sub'))).toBe('acme/A1');
		});
		it('the same folder twice only with a different app folder', () => {
			const repo = repoAt('hapr', ['web', 'landing']);
			registerProject({ org: 'acme', name: 'HAPRM', repo, appDir: 'web', boardProject: 'HAPR' });
			expect(
				registerProject({
					org: 'acme',
					name: 'HAPRN',
					repo,
					appDir: 'landing',
					boardProject: 'HAPR'
				}).appDir
			).toBe('landing');
			expect(() =>
				registerProject({
					org: 'acme',
					name: 'HAPRX',
					repo,
					appDir: './web/',
					boardProject: 'HAPR'
				})
			).toThrow(/already held by acme\/HAPRM/);
			expect(repoHeldBySibling('acme', 'NEW', repo, 'web')).toBe('acme/HAPRM');
			expect(repoHeldBySibling('acme', 'HAPRM', repo, 'web')).toBeNull();
		});
		it('a folder inside a registered folder, or around it, counts as held', () => {
			const outer = repoAt('outer');
			registerProject({ org: 'acme', name: 'OUT', repo: outer });
			const inner = join(outer, 'inner');
			mkdirSync(join(inner, '.git'), { recursive: true });
			writeFileSync(
				join(inner, 'package.json'),
				JSON.stringify({ scripts: { preview: 'vite preview' } })
			);
			expect(() => registerProject({ org: 'acme', name: 'INN', repo: inner })).toThrow(
				/already held/
			);
		});
		it('links and junctions count as the same folder', () => {
			const repo = repoAt('real');
			registerProject({ org: 'acme', name: 'REAL', repo });
			const link = join(work, 'alias');
			try {
				symlinkSync(repo, link, 'junction');
			} catch {
				return; // This machine cannot make links
			}
			expect(repoHeldBySibling('acme', 'ALIAS', link, undefined)).toBe('acme/REAL');
			expect(repoHeldElsewhere('beta', link)).toBe('acme/REAL');
			// And a registration through the link is refused outright
			expect(() => registerProject({ org: 'acme', name: 'ALIAS', repo: link })).toThrow(/link/);
		});
	});

	describe('folder rules', () => {
		it('needs a repo inside an owner-approved root', () => {
			const outside = join(base, 'outside');
			mkdirSync(join(outside, '.git'), { recursive: true });
			writeFileSync(
				join(outside, 'package.json'),
				JSON.stringify({ scripts: { preview: 'vite preview' } })
			);
			expect(() => registerProject({ org: 'acme', name: 'OUT', repo: outside })).toThrow(
				/approved/
			);
		});
		it('applies the guardrails to the folder (git, package.json)', () => {
			const plain = join(work, 'nogit');
			mkdirSync(plain);
			writeFileSync(join(plain, 'package.json'), '{}');
			expect(() => registerProject({ org: 'acme', name: 'NOGIT', repo: plain })).toThrow(
				/not a git project/
			);
			expect(() =>
				registerProject({ org: 'acme', name: 'GONE', repo: join(work, 'gone') })
			).toThrow(/does not exist/);
		});
		it('keeps the real path', () => {
			const repo = repoAt('a');
			expect(registerProject({ org: 'acme', name: 'AA', repo: join(repo, '..', 'a') }).repo).toBe(
				repo
			);
		});
		it('configFor builds the config from the repo, and again checks the roots', () => {
			const reg = registerProject({ org: 'acme', name: 'AA', repo: repoAt('a') });
			const cfg = configFor(reg);
			expect(cfg).toMatchObject({
				repo: reg.repo,
				start: 'yarn preview --port {port}',
				build: 'yarn build',
				registration: { org: 'acme', name: 'AA' }
			});
			expect(cfg.appDir).toBeUndefined();
			expect(() => configFor({ ...reg, repo: join(base, 'elsewhere') })).toThrow(/approved/);
		});
		it('refuses a recipe flag without a recipe', () => {
			expect(() =>
				registerProject({ org: 'acme', name: 'AA', repo: repoAt('a'), recipe: true })
			).toThrow(/no \.afb-checks\.json|--recipe/);
		});
	});

	describe('app folder', () => {
		it('normalises the spellings', () => {
			for (const s of ['web', 'web\\', './web', 'web/', '.\\web\\'])
				expect(normaliseAppDir(s)).toBe('web');
			expect(normaliseAppDir('apps\\web/')).toBe('apps/web');
		});
		it('refuses what is not a plain relative folder', () => {
			for (const s of [
				'',
				'..',
				'../x',
				'a/../b',
				'/abs',
				'C:\\x',
				'a/b/c/d/e',
				'node_modules',
				'web/node_modules',
				'.git',
				'x/.git',
				'web.',
				'CON',
				'nul.txt',
				'a//b',
				'a b',
				'-x'
			])
				expect(() => normaliseAppDir(s), s).toThrow();
		});
		it('is walked without following links, and needs a package.json', () => {
			const repo = repoAt('r', ['web']);
			expect(checkAppDir(repo, 'web')).toBeNull();
			expect(checkAppDir(repo, 'missing')).toMatch(/is not in the repo/);
			mkdirSync(join(repo, 'empty'));
			expect(checkAppDir(repo, 'empty')).toMatch(/no package\.json/);
			writeFileSync(join(repo, 'afile'), 'x');
			expect(checkAppDir(repo, 'afile')).toMatch(/is not a folder/);
			const outside = join(base, 'outside');
			mkdirSync(outside);
			writeFileSync(join(outside, 'package.json'), '{}');
			try {
				symlinkSync(outside, join(repo, 'linked'), 'junction');
			} catch {
				return;
			}
			expect(checkAppDir(repo, 'linked')).toMatch(/goes through a link/);
		});
		it('registers an app folder and builds the config from it with the git root as repo', () => {
			const repo = repoAt('hapr', ['web']);
			const reg = registerProject({
				org: 'acme',
				name: 'HAPRM',
				repo,
				appDir: 'web\\',
				boardProject: 'HAPR'
			});
			expect(reg.appDir).toBe('web');
			const cfg = configFor(reg);
			expect(cfg.repo).toBe(repo);
			expect(cfg.appDir).toBe('web');
			expect(cfg.start).toContain('preview');
			// The git root must be given, not the app folder
			expect(() =>
				registerProject({ org: 'acme', name: 'X', repo: join(repo, 'web'), appDir: 'web' })
			).toThrow();
		});
		it('is checked again when the registration is used', () => {
			const repo = repoAt('hapr', ['web']);
			const reg = registerProject({
				org: 'acme',
				name: 'HAPRM',
				repo,
				appDir: 'web',
				boardProject: 'HAPR'
			});
			rmSync(join(repo, 'web', 'package.json'));
			expect(() => configFor(reg)).toThrow(/package\.json/);
		});
	});

	describe('saved state', () => {
		it('refuses to point a registration that holds state at another folder', () => {
			const a = repoAt('a');
			const b = repoAt('b');
			registerProject({ org: 'acme', name: 'AFB', repo: a });
			mkdirSync(stateDirFor('acme', 'AFB'), { recursive: true });
			writeFileSync(join(stateDirFor('acme', 'AFB'), 'profile.json'), 'x');
			expect(() => registerProject({ org: 'acme', name: 'AFB', repo: b })).toThrow(
				/holds saved state/
			);
			expect(findRegistration('acme', 'AFB')?.repo).toBe(a);
			// The same folder is fine, and so is another folder once the state is forgotten
			expect(registerProject({ org: 'acme', name: 'AFB', repo: a }).repo).toBe(a);
			forgetRegistration('acme', 'AFB');
			expect(registerProject({ org: 'acme', name: 'AFB', repo: b }).repo).toBe(b);
		});
		it('treats an empty state folder as no state', () => {
			registerProject({ org: 'acme', name: 'AFB', repo: repoAt('a') });
			mkdirSync(stateDirFor('acme', 'AFB'), { recursive: true });
			expect(registerProject({ org: 'acme', name: 'AFB', repo: repoAt('b') }).repo).toContain('b');
		});
		it('also refuses a different app folder while state is held', () => {
			const repo = repoAt('hapr', ['web', 'landing']);
			registerProject({ org: 'acme', name: 'HAPRM', repo, appDir: 'web', boardProject: 'HAPR' });
			mkdirSync(stateDirFor('acme', 'HAPRM'), { recursive: true });
			writeFileSync(join(stateDirFor('acme', 'HAPRM'), 'x'), 'x');
			expect(() =>
				registerProject({
					org: 'acme',
					name: 'HAPRM',
					repo,
					appDir: 'landing',
					boardProject: 'HAPR'
				})
			).toThrow(/holds saved state/);
		});
	});

	describe('owner approvals', () => {
		it('adopting the whole .env needs a code for adopt-env and this name, once', () => {
			const repo = repoAt('a');
			expect(() => registerProject({ org: 'acme', name: 'AFB', repo, adoptEnv: true })).toThrow(
				/needs a code/
			);
			expect(() =>
				registerProject(
					{ org: 'acme', name: 'AFB', repo, adoptEnv: true },
					{ adoptEnv: code('adopt-env', 'OTHER') }
				)
			).toThrow(/wrong, used or expired/);
			expect(findRegistration('acme', 'AFB')).toBeNull();
			const c = code('adopt-env', 'AFB');
			const reg = registerProject(
				{ org: 'acme', name: 'AFB', repo, adoptEnv: true },
				{ adoptEnv: c }
			);
			expect(reg.adoptEnv).toBe(true);
			expect(configFor(reg).adoptEnv).toBe(true);
			// Updating again does not need a new code; switching it off needs none either
			expect(registerProject({ org: 'acme', name: 'AFB', repo, adoptEnv: true }).adoptEnv).toBe(
				true
			);
			expect(registerProject({ org: 'acme', name: 'AFB', repo }).adoptEnv).toBe(false);
			expect(() =>
				registerProject({ org: 'acme', name: 'AFB', repo, adoptEnv: true }, { adoptEnv: c })
			).toThrow(/wrong, used or expired/);
		});
		it('uploading signed-in pictures needs a code for pictures', () => {
			const repo = repoAt('a');
			expect(() =>
				registerProject({ org: 'acme', name: 'AFB', repo, uploadSignedInPictures: true })
			).toThrow(/needs a code/);
			const reg = registerProject(
				{ org: 'acme', name: 'AFB', repo, uploadSignedInPictures: true },
				{ pictures: code('pictures', 'AFB') }
			);
			expect(reg.uploadSignedInPictures).toBe(true);
		});
		it('a refused registration does not use up a code', () => {
			const c = code('adopt-env', 'AFB');
			expect(() =>
				registerProject(
					{ org: 'acme', name: 'AFB', repo: join(work, 'gone'), adoptEnv: true },
					{ adoptEnv: c }
				)
			).toThrow(/does not exist/);
			expect(
				registerProject(
					{ org: 'acme', name: 'AFB', repo: repoAt('a'), adoptEnv: true },
					{ adoptEnv: c }
				).adoptEnv
			).toBe(true);
		});
	});

	describe('live sites', () => {
		it('needs the owner code, and holds no repo', () => {
			expect(() =>
				registerProject({
					org: 'acme',
					name: 'HAPRA',
					url: 'https://app.thehapr.com',
					boardProject: 'HAPR'
				})
			).toThrow(/needs a code/);
			const reg = registerProject(
				{
					org: 'acme',
					name: 'HAPRA',
					url: 'https://app.thehapr.com',
					boardProject: 'HAPR',
					extraHosts: ['CDN.thehapr.com']
				},
				{ register: code('register', 'HAPRA@app.thehapr.com') }
			);
			expect(reg.repo).toBeUndefined();
			expect(reg.extraHosts).toEqual(['cdn.thehapr.com']);
			const cfg = configFor(reg);
			expect(cfg).toMatchObject({
				start: '',
				url: 'https://app.thehapr.com/',
				extraHosts: ['cdn.thehapr.com']
			});
			expect(pinState(reg)).toBe('ok');
			expect(() => pinRegistration('acme', 'HAPRA')).toThrow(/live site/);
			// Saving it again unchanged needs no new code
			expect(
				registerProject({
					org: 'acme',
					name: 'HAPRA',
					url: 'https://app.thehapr.com',
					boardProject: 'HAPR'
				}).url
			).toBe('https://app.thehapr.com/');
		});
		it('refuses addresses and hosts a check must not reach', () => {
			expect(() => cleanSiteUrl('ftp://x.test')).toThrow(/http/);
			expect(() => cleanSiteUrl('https://user:pw@x.test')).toThrow(/user name/);
			expect(() => cleanSiteUrl('not a url')).toThrow(/not a url/);
			for (const u of [
				'http://localhost:5180',
				'http://127.0.0.1:5190/x',
				'http://[::1]:5433',
				'http://0.0.0.0:5180',
				'http://host.docker.internal:5433'
			])
				expect(() => cleanSiteUrl(u), u).toThrow(/never uses/);
			expect(cleanSiteUrl('http://localhost:5300')).toBe('http://localhost:5300/');
			for (const h of [
				'10.0.0.1',
				'127.0.0.1',
				'[::1]',
				'::1',
				'localhost',
				'a.localhost',
				'*.x.test',
				'x.test:8080',
				'x.test/path',
				'host.docker.internal',
				'0x7f000001',
				'a b'
			])
				expect(() => cleanExtraHosts([h]), h).toThrow(/exact host name/);
			expect(cleanExtraHosts(['A.test', 'a.test'])).toEqual(['a.test']);
			expect(() => cleanExtraHosts(Array.from({ length: 17 }, (_, i) => `h${i}.test`))).toThrow(
				/At most 16/
			);
		});
		it('has no app folder or .env', () => {
			expect(() =>
				registerProject({ org: 'acme', name: 'SS', url: 'https://x.test', appDir: 'web' })
			).toThrow(/no app folder/);
			expect(() =>
				registerProject({ org: 'acme', name: 'SS', url: 'https://x.test', adoptEnv: true })
			).toThrow(/no \.env/);
		});
	});

	describe('pin', () => {
		it('starts unpinned, pins, notices a change and refuses a change that breaks the guardrails', () => {
			const repo = repoAt('a');
			const reg = registerProject({ org: 'acme', name: 'AFB', repo });
			expect(pinState(reg)).toBe('unpinned');
			const first = pinRegistration('acme', 'AFB');
			expect(first).toMatchObject({ before: null, changed: true });
			expect(first.files).toContain('package.json#scripts');
			const pinned = findRegistration('acme', 'AFB');
			expect(pinned && pinState(pinned)).toBe('ok');
			expect(pinRegistration('acme', 'AFB').changed).toBe(false);
			writeFileSync(join(repo, 'yarn.lock'), 'new lockfile');
			expect(pinned && pinState(pinned)).toBe('changed');
			const again = pinRegistration('acme', 'AFB');
			expect(again.changed).toBe(true);
			expect(again.before).toBe(first.after);
			// A script that is no longer a plain preview command is refused, and the old pin stays
			writeFileSync(
				join(repo, 'package.json'),
				JSON.stringify({ scripts: { preview: 'node evil.js' } })
			);
			expect(() => pinRegistration('acme', 'AFB')).toThrow(/not a plain build or preview command/);
			expect(findRegistration('acme', 'AFB')?.pin).toBe(again.after);
			const log = readFileSync(join(base, 'bridge-home', 'checks', 'audit.log'), 'utf8');
			expect(log.match(/surface pinned/g)).toHaveLength(2);
		});
		it('adds the git root files to the surface of an app folder', () => {
			const repo = repoAt('hapr', ['web']);
			registerProject({ org: 'acme', name: 'HAPRM', repo, appDir: 'web', boardProject: 'HAPR' });
			const first = pinRegistration('acme', 'HAPRM');
			writeFileSync(join(repo, '.yarnrc.yml'), 'nodeLinker: node-modules');
			const second = pinRegistration('acme', 'HAPRM');
			expect(second.after).not.toBe(first.after);
			expect(second.files).toContain('root:.yarnrc.yml');
		});
	});

	describe('changing what an existing registration points at (S6)', () => {
		const adopted = (name = 'AFB') => {
			const repo = repoAt('first');
			registerProject(
				{ org: 'acme', name, repo, adoptEnv: true },
				{ adoptEnv: code('adopt-env', name) }
			);
			return repo;
		};

		it('a live site is approved for its host: a code for another host is refused', () => {
			const input = { org: 'acme', name: 'LIVE', url: 'https://one.example.com' };
			expect(() => registerProject(input, { register: code('register', 'LIVE') })).toThrow(
				/wrong, used or expired/
			);
			expect(
				registerProject(input, { register: code('register', 'LIVE@one.example.com') }).url
			).toBe('https://one.example.com/');
			// Another host is another approval
			expect(() =>
				registerProject(
					{ ...input, url: 'https://two.example.com' },
					{ register: code('register', 'LIVE@one.example.com') }
				)
			).toThrow(/wrong, used or expired/);
		});

		it('changing the extra hosts of a registration that holds saved state needs the owner code', () => {
			const reg = registerProject(
				{
					org: 'acme',
					name: 'LIVE',
					url: 'https://one.example.com',
					extraHosts: ['a.example.com']
				},
				{ register: code('register', 'LIVE@one.example.com') }
			);
			// No state yet: the hosts can change freely
			registerProject({
				org: 'acme',
				name: 'LIVE',
				url: 'https://one.example.com',
				extraHosts: ['b.example.com']
			});
			mkdirSync(stateDirFor('acme', reg.name), { recursive: true });
			writeFileSync(join(stateDirFor('acme', reg.name), 'secrets.json'), '{}');
			const change = {
				org: 'acme',
				name: 'LIVE',
				url: 'https://one.example.com',
				extraHosts: ['evil.example.com']
			};
			expect(() => registerProject(change)).toThrow(/needs a code from the owner/);
			expect(findRegistration('acme', 'LIVE')?.extraHosts).toEqual(['b.example.com']);
			expect(
				registerProject(change, { register: code('register', 'LIVE@one.example.com') }).extraHosts
			).toEqual(['evil.example.com']);
		});

		it('pointing a registration that adopted the .env at another folder needs the owner code, and adoption is switched off again', () => {
			adopted();
			const other = repoAt('second');
			expect(() => registerProject({ org: 'acme', name: 'AFB', repo: other })).toThrow(
				/needs a code from the owner/
			);
			expect(findRegistration('acme', 'AFB')?.repo).not.toBe(other);
			const moved = registerProject(
				{ org: 'acme', name: 'AFB', repo: other },
				{ register: code('register', 'AFB') }
			);
			expect(moved.repo).toBe(other);
			expect(moved.adoptEnv).toBe(false);
		});

		it('adoption does not carry over to another folder: it needs its own code again', () => {
			adopted();
			const other = repoAt('second');
			const reg = code('register', 'AFB');
			expect(() =>
				registerProject(
					{ org: 'acme', name: 'AFB', repo: other, adoptEnv: true },
					{ register: reg }
				)
			).toThrow(/Adopting the whole repo .env needs a code/);
			// The refusal did not use the register code
			const moved = registerProject(
				{ org: 'acme', name: 'AFB', repo: other, adoptEnv: true },
				{ register: reg, adoptEnv: code('adopt-env', 'AFB') }
			);
			expect(moved.adoptEnv).toBe(true);
			expect(moved.repo).toBe(other);
		});

		it('a changed app folder counts as a change as well', () => {
			const repo = repoAt('mono', ['web', 'landing']);
			registerProject(
				{ org: 'acme', name: 'AFB', repo, appDir: 'web', adoptEnv: true },
				{ adoptEnv: code('adopt-env', 'AFB') }
			);
			expect(() => registerProject({ org: 'acme', name: 'AFB', repo, appDir: 'landing' })).toThrow(
				/needs a code from the owner/
			);
		});

		it('the same registration saved again, unchanged, needs no code', () => {
			const repo = adopted();
			expect(registerProject({ org: 'acme', name: 'AFB', repo, adoptEnv: true }).adoptEnv).toBe(
				true
			);
		});

		it('a wrong code for the last approval does not use up the others (S10)', () => {
			const repo = repoAt('third');
			const adoptCode = code('adopt-env', 'AFB');
			expect(() =>
				registerProject(
					{ org: 'acme', name: 'AFB', repo, adoptEnv: true, uploadSignedInPictures: true },
					{ adoptEnv: adoptCode, pictures: code('pictures', 'OTHER') }
				)
			).toThrow(/pictures approval code is wrong/);
			// The adopt-env code is still good
			expect(
				registerProject({ org: 'acme', name: 'AFB', repo, adoptEnv: true }, { adoptEnv: adoptCode })
					.adoptEnv
			).toBe(true);
		});
	});
});
