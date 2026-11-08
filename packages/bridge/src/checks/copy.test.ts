// THE PRIVATE COPY: A LOCAL CLONE AT HEAD PLUS THE WORKING-TREE CHANGES, THE NEVER LIST, THE SIZE SKIP, THE CAPS OF A NON-GIT FOLDER, A MOVED HEAD AND LINKS

// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { MAX_COPY_BYTES, makePrivateCopy, neverCopy } from './copy.js';

// -- FUNCTIONS -- //

const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' }).trim();

describe('copy', () => {
	let repo = '';
	let work = '';
	beforeEach(() => {
		work = mkdtempSync(join(tmpdir(), 'afb-copy-'));
		repo = join(work, 'repo');
		mkdirSync(repo);
		git(repo, 'init', '-q');
		writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}');
		writeFileSync(join(repo, 'keep.txt'), 'committed');
		writeFileSync(join(repo, 'gone.txt'), 'will be deleted');
		writeFileSync(join(repo, '.gitignore'), 'ignored.txt\nnode_modules\n');
		writeFileSync(join(repo, '.env'), 'SECRET=committed-env-value');
		writeFileSync(join(repo, '.env.example'), 'SECRET=');
		mkdirSync(join(repo, 'src'));
		writeFileSync(join(repo, 'src', 'a.txt'), 'a');
		git(repo, 'add', '-A', '-f');
		git(repo, 'commit', '-q', '-m', 'one');
	});
	afterEach(() => rmSync(work, { recursive: true, force: true }));

	it('clones at HEAD, detaches, drops the origin and copies the working-tree changes over it', async () => {
		writeFileSync(join(repo, 'keep.txt'), 'edited in the working tree');
		writeFileSync(join(repo, 'new.txt'), 'untracked');
		writeFileSync(join(repo, 'ignored.txt'), 'ignored');
		rmSync(join(repo, 'gone.txt'));
		const dest = join(work, 'copy');
		const r = await makePrivateCopy(repo, dest);
		expect(r.mode).toBe('clone');
		expect(r.head).toBe(git(repo, 'rev-parse', 'HEAD'));
		expect(r.repoInCopy).toBe(dest);
		expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('edited in the working tree');
		expect(readFileSync(join(dest, 'new.txt'), 'utf8')).toBe('untracked');
		expect(readFileSync(join(dest, 'src', 'a.txt'), 'utf8')).toBe('a');
		expect(existsSync(join(dest, 'gone.txt'))).toBe(false);
		expect(existsSync(join(dest, 'ignored.txt'))).toBe(false);
		expect(existsSync(join(dest, '.git'))).toBe(true);
		expect(git(dest, 'remote')).toBe('');
		expect(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
		// The source repo's own .git was not changed by the clone
		expect(git(repo, 'status', '--porcelain')).toContain('new.txt');
	});

	it('deletes a tracked env file from the copy and never copies a changed one, but keeps the example', async () => {
		writeFileSync(join(repo, '.env'), 'SECRET=edited-env-value');
		writeFileSync(join(repo, '.env.local'), 'SECRET=local');
		const dest = join(work, 'copy');
		const r = await makePrivateCopy(repo, dest);
		expect(existsSync(join(dest, '.env'))).toBe(false);
		expect(existsSync(join(dest, '.env.local'))).toBe(false);
		expect(readFileSync(join(dest, '.env.example'), 'utf8')).toBe('SECRET=');
		expect(r.skippedList.map((s) => s.path).sort()).toEqual(['.env', '.env.local']);
	});

	it('never copies keys, credentials or a program named like a package manager, and skips files over 5 MB', async () => {
		for (const f of ['server.pem', 'id_rsa', 'credentials', 'secrets.yml', 'yarn.cmd', 'node.exe'])
			writeFileSync(join(repo, f), 'x');
		writeFileSync(join(repo, 'big.bin'), Buffer.alloc(MAX_COPY_BYTES + 1));
		writeFileSync(join(repo, 'ok.bin'), Buffer.alloc(MAX_COPY_BYTES));
		const dest = join(work, 'copy');
		const r = await makePrivateCopy(repo, dest);
		for (const f of [
			'server.pem',
			'id_rsa',
			'credentials',
			'secrets.yml',
			'yarn.cmd',
			'node.exe',
			'big.bin'
		])
			expect(existsSync(join(dest, f)), f).toBe(false);
		expect(existsSync(join(dest, 'ok.bin'))).toBe(true);
		expect(r.skippedList.find((s) => s.path === 'big.bin')?.why).toMatch(/5 MB/);
		expect(r.skippedList.find((s) => s.path === 'yarn.cmd')?.why).toMatch(/program/);
		expect(r.skipped).toBe(7);
	});

	it('copies source files that are named like secrets or programs, modified, untracked or tracked', async () => {
		mkdirSync(join(repo, 'lib'));
		writeFileSync(join(repo, 'secrets.ts'), 'export const a = 1;');
		writeFileSync(join(repo, 'lib', 'git.js'), 'module.exports = 1;');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'sources');
		writeFileSync(join(repo, 'secrets.ts'), 'export const a = 2; // modified');
		writeFileSync(join(repo, 'credentials.ts'), 'export const c = 1;');
		writeFileSync(join(repo, 'node.js'), 'x');
		writeFileSync(join(repo, 'secrets.json'), '{}');
		const dest = join(work, 'copy');
		const logs: string[] = [];
		const r = await makePrivateCopy(repo, dest, { log: (s) => logs.push(s) });
		expect(readFileSync(join(dest, 'secrets.ts'), 'utf8')).toContain('modified');
		for (const f of ['credentials.ts', 'node.js', 'secrets.json', 'lib/git.js'])
			expect(existsSync(join(dest, f)), f).toBe(true);
		expect(r.skipped).toBe(0);
	});

	it('lists every skipped path by name in the log, and the rule keeps tracked files', () => {
		expect(neverCopy('secrets.yml', false)).toMatch(/credentials/);
		expect(neverCopy('secrets.yml', true)).toBeNull();
		expect(neverCopy('a/server.pem', false)).toMatch(/key/);
		expect(neverCopy('.env', true)).toMatch(/env/);
		expect(neverCopy('.env.example', false)).toBeNull();
		expect(neverCopy('bin/yarn.cmd', false)).toMatch(/program/);
		expect(neverCopy('lib/yarn.js', false)).toBeNull();
	});

	it('names every skipped file in the log, in a repo with no commit as well', async () => {
		const bare = join(work, 'bare');
		mkdirSync(bare);
		git(bare, 'init', '-q');
		writeFileSync(join(bare, 'a.txt'), 'a');
		writeFileSync(join(bare, 'k.pem'), 'k');
		writeFileSync(join(bare, 'secrets.ts'), 'ok');
		const logs: string[] = [];
		const r = await makePrivateCopy(bare, join(work, 'bcopy'), { log: (s) => logs.push(s) });
		expect(r.mode).toBe('listed');
		expect(logs.some((l) => l.includes('k.pem'))).toBe(true);
		expect(existsSync(join(work, 'bcopy', 'secrets.ts'))).toBe(true);
		expect(existsSync(join(work, 'bcopy', 'k.pem'))).toBe(false);
	});

	it('copies once more when HEAD moved during the copy', async () => {
		const dest = join(work, 'copy');
		const seen: number[] = [];
		const r = await makePrivateCopy(repo, dest, {
			afterCopy: (attempt) => {
				seen.push(attempt);
				if (attempt === 1) {
					writeFileSync(join(repo, 'second.txt'), 'from the second commit');
					git(repo, 'add', '-A');
					git(repo, 'commit', '-q', '-m', 'two');
				}
			}
		});
		expect(seen).toEqual([1, 2]);
		expect(r.head).toBe(git(repo, 'rev-parse', 'HEAD'));
		expect(readFileSync(join(dest, 'second.txt'), 'utf8')).toBe('from the second commit');
		expect(git(dest, 'rev-parse', 'HEAD')).toBe(r.head);
	});

	it('copies at most twice even when HEAD keeps moving', async () => {
		let n = 0;
		const seen: number[] = [];
		await makePrivateCopy(repo, join(work, 'copy'), {
			afterCopy: (attempt) => {
				seen.push(attempt);
				writeFileSync(join(repo, `m${++n}.txt`), String(n));
				git(repo, 'add', '-A');
				git(repo, 'commit', '-q', '-m', `m${n}`);
			}
		});
		expect(seen).toEqual([1, 2]);
	});

	it('refuses an untracked link or junction by name', async () => {
		const outside = join(work, 'outside');
		mkdirSync(outside);
		writeFileSync(join(outside, 'x.txt'), 'x');
		try {
			symlinkSync(outside, join(repo, 'linked'), 'junction');
		} catch {
			return; // This machine does not allow links for this user
		}
		await expect(makePrivateCopy(repo, join(work, 'copy'))).rejects.toThrow(/linked/);
	});

	it('refuses a link that is in the commit', async () => {
		const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
			cwd: repo,
			input: '../outside',
			encoding: 'utf8'
		}).trim();
		git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},sneaky`);
		git(repo, 'commit', '-q', '-m', 'link');
		await expect(makePrivateCopy(repo, join(work, 'copy'))).rejects.toThrow(/sneaky/);
	});

	it('copies from the git root when the folder is inside it and says where the folder is', async () => {
		mkdirSync(join(repo, 'web'));
		writeFileSync(join(repo, 'web', 'package.json'), '{}');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'web');
		const dest = join(work, 'copy');
		const r = await makePrivateCopy(join(repo, 'web'), dest);
		expect(r.repoInCopy).toBe(join(dest, 'web'));
		expect(existsSync(join(dest, 'keep.txt'))).toBe(true);
		expect(existsSync(join(dest, 'web', 'package.json'))).toBe(true);
	});

	it('copies a git repo with no commit from the files git lists', async () => {
		const fresh = join(work, 'fresh');
		mkdirSync(fresh);
		git(fresh, 'init', '-q');
		writeFileSync(join(fresh, 'a.txt'), 'a');
		writeFileSync(join(fresh, '.gitignore'), 'b.txt\n');
		writeFileSync(join(fresh, 'b.txt'), 'b');
		writeFileSync(join(fresh, '.env'), 'X=1');
		const dest = join(work, 'copy2');
		const r = await makePrivateCopy(fresh, dest);
		expect(r.mode).toBe('listed');
		expect(r.head).toBeNull();
		expect(existsSync(join(dest, 'a.txt'))).toBe(true);
		expect(existsSync(join(dest, 'b.txt'))).toBe(false);
		expect(existsSync(join(dest, '.env'))).toBe(false);
		expect(existsSync(join(dest, '.git'))).toBe(false);
	});

	it('copies a folder that is not a git repo, within the caps', async () => {
		const plain = join(work, 'plain');
		mkdirSync(join(plain, 'node_modules'), { recursive: true });
		mkdirSync(join(plain, 'src'));
		writeFileSync(join(plain, 'src', 'a.txt'), 'a');
		writeFileSync(join(plain, 'node_modules', 'x.js'), 'x');
		writeFileSync(join(plain, '.env'), 'X=1');
		const dest = join(work, 'copy3');
		const r = await makePrivateCopy(plain, dest);
		expect(r.mode).toBe('plain');
		expect(r.head).toBeNull();
		expect(existsSync(join(dest, 'src', 'a.txt'))).toBe(true);
		expect(existsSync(join(dest, 'node_modules'))).toBe(false);
		expect(existsSync(join(dest, '.env'))).toBe(false);
		await expect(
			makePrivateCopy(plain, join(work, 'copy4'), { limits: { files: 0 } })
		).rejects.toThrow(/too much to copy/);
		await expect(
			makePrivateCopy(plain, join(work, 'copy5'), { limits: { bytes: 0 } })
		).rejects.toThrow(/too much to copy/);
	});
});
