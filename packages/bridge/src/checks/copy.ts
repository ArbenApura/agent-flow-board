// THE PRIVATE COPY OF A REPO FOR ONE RUN, SO A RUN BUILDS AND SERVES FROM ITS OWN FOLDER AND NEVER FROM THE ONE A PERSON'S PREVIEW SERVES.
// A git repo with a commit is copied as a local clone (`git clone --local --no-checkout`: nothing is fetched from anywhere else and nothing is
// written into the repo's own .git, objects are hard linked), with the origin removed and HEAD checked out detached; then only the working-tree
// changes (tracked and untracked, not ignored) are copied over it, so a run tests what is on disk now. A git repo with no commit is copied from the
// files git lists; a folder that is not a git repo is copied with caps on files and size. Env files, keys, links and programs named like the
// package managers are never copied. If HEAD moves while the copy is made, the copy is made once more.

// -- DEP-MODULES -- //
import { execFile } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
// -- MODULES -- //
import { ensureDir, under } from './paths.js';

// -- TYPES -- //

export type GitResult = { status: number; stdout: Buffer; stderr: string };
export type CopyResult = {
	/** Files copied over the checkout (or all files, outside a clone). */
	files: number;
	/** Files that were not copied: env files, keys, links to programs, files over 5 MB. */
	skipped: number;
	skippedList: { path: string; why: string }[];
	/** The commit the copy is at, or null when the folder has no commit. */
	head: string | null;
	/** The git root the copy was made from (the folder itself when it is not inside a git repo). */
	sourceRoot: string;
	/** The folder of `repo` inside the copy: the copy itself when `repo` is the git root. */
	repoInCopy: string;
	mode: 'clone' | 'listed' | 'plain';
};
export type CopyOptions = {
	log?: (s: string) => void;
	/** A test seam: runs after the copy is made and before HEAD is looked at again. */
	afterCopy?: (attempt: number) => void | Promise<void>;
	/** Smaller caps for a folder that is not a git repo (tests). */
	limits?: { files?: number; bytes?: number };
};

// -- CONSTANTS -- //

/** A file bigger than this is not copied (a build output, a dump, a video). */
export const MAX_COPY_BYTES = 5 * 1024 * 1024;
/** A folder that is not a git repo is copied whole, so it may not be a whole disk. */
export const MAX_PLAIN_FILES = 20_000;
export const MAX_PLAIN_BYTES = 400 * 1024 * 1024;
/** Source and document extensions: a file named secrets.ts or credentials.json is code or text a project owns, not a credentials dump, so it is copied. */
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte|json|md)$/i;
/**
 * Files that are never copied, by name: secrets, keys, and a program named like the ones a shell would look up. The credentials rule only applies to a file
 * without a source extension, and the program rule only to a real program (a script file such as lib/git.js is source). A path git tracks is never skipped
 * by these (it is already in the commit); env files are the exception, they have their own rule.
 */
const NEVER: { re: RegExp; why: string }[] = [
	{ re: /(^|\/)\.env(\.[^/]*)?$/i, why: 'an env file' },
	{ re: /\.(pem|key|p12|pfx|jks|keystore)$/i, why: 'a key file' },
	{ re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, why: 'an ssh key' },
	{ re: /(^|\/)(credentials?|secrets?)(\.[^/]*)?$/i, why: 'a credentials file' },
	{
		re: /(^|\/)(yarn|npm|npx|pnpm|node|git)\.(cmd|bat|exe|com|ps1|vbs)$/i,
		why: 'a program named like a tool it would be run as'
	}
];
/** An example env file holds no secrets and is copied. */
const ENV_EXAMPLE = /\.(example|sample|template)$/i;
/** The reason a path is never copied, or null. Exported for the tests. */
export function neverCopy(rel: string, tracked: boolean): string | null {
	for (const n of NEVER) {
		if (!n.re.test(rel)) continue;
		if (n.why === 'an env file') {
			if (ENV_EXAMPLE.test(rel)) continue;
			return n.why;
		}
		if (tracked) continue;
		if (n.why === 'a credentials file' && SOURCE_EXT.test(rel)) continue;
		return n.why;
	}
	return null;
}
const SKIP_DIR = /(^|\/)(\.git|node_modules)(\/|$)/;
/** Env files a build tool loads on its own in a production build. A committed one is taken out of the copy as well. */
const TRACKED_ENV = /(^|\/)\.env(\.local|\.production|\.production\.local)?$/i;

// -- FUNCTIONS -- //

/** Runs git with an argument list and no shell. Resolves with the exit status; never throws. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolveResult) => {
		execFile(
			'git',
			args,
			{
				cwd,
				windowsHide: true,
				encoding: 'buffer',
				maxBuffer: 256 * 1024 * 1024,
				timeout: 10 * 60_000
			},
			(err, stdout, stderr) => {
				const code = err
					? typeof (err as { code?: unknown }).code === 'number'
						? (err as { code: number }).code
						: -1
					: 0;
				resolveResult({
					status: code,
					stdout: stdout as unknown as Buffer,
					stderr: String(stderr ?? '')
				});
			}
		);
	});
}

const must = (r: GitResult, what: string): Buffer => {
	if (r.status !== 0)
		throw new Error(
			`${what} failed: ${(r.stderr || r.stdout.toString('utf8')).trim().slice(-300)}`
		);
	return r.stdout;
};

/** The commit of HEAD, or null when the folder has no commit (or is not a git repo). */
export async function headCommit(repo: string): Promise<string | null> {
	const r = await git(repo, ['rev-parse', '--verify', 'HEAD']);
	return r.status === 0 ? r.stdout.toString('utf8').trim() || null : null;
}

/** The top folder of the git repo `folder` is in, or null when it is in none. */
export async function gitRoot(folder: string): Promise<string | null> {
	const r = await git(folder, ['rev-parse', '--show-toplevel']);
	if (r.status !== 0) return null;
	const out = r.stdout.toString('utf8').trim();
	return out ? resolve(out) : null;
}

/** The tracked and the untracked-not-ignored files of a repo, as paths relative to it. Null when the folder is not a git repo. */
export async function listFiles(repo: string): Promise<string[] | null> {
	const r = await git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
	if (r.status !== 0) return null;
	return [...new Set(r.stdout.toString('utf8').split('\0').filter(Boolean))];
}

/** The changes of a working tree as { deleted, changed } paths relative to the git root, from git itself (NUL separated, so any file name works). */
export async function workingTreeChanges(
	root: string
): Promise<{ deleted: string[]; changed: string[] }> {
	const out = must(
		await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
		'git status'
	).toString('utf8');
	const parts = out.split('\0');
	if (parts.at(-1) === '') parts.pop();
	const deleted: string[] = [];
	const changed: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const x = entry[0];
		const y = entry[1];
		const file = entry.slice(3);
		if (x === 'R' || x === 'C') {
			// A rename lists the new name, then the old one
			const from = parts[++i];
			if (x === 'R') deleted.push(from);
			changed.push(file);
		} else if (x === 'D' || y === 'D') deleted.push(file);
		else changed.push(file);
	}
	return { deleted, changed };
}

/** The real path of a folder (so 8.3 names and case do not matter when two paths are compared), or its resolved path. */
const realOf = (folder: string): string => {
	try {
		return realpathSync.native(folder);
	} catch {
		return resolve(folder);
	}
};

const safeRel = (rel: string) =>
	!!rel && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..') && !rel.includes('\0');

type Ctx = {
	src: string;
	dest: string;
	skipped: { path: string; why: string }[];
	/** The paths git tracks (never skipped by name, env files apart). */
	tracked: Set<string>;
};

/**
 * Copies one file of the repo into the copy. Returns true when it was copied. A link is refused by name (a copy that followed it could carry files
 * from outside the repo into the build); the other reasons to leave a file out are listed in `skipped`.
 */
function copyOne(ctx: Ctx, rel: string): boolean {
	if (!safeRel(rel))
		throw new Error(`The file "${rel.slice(0, 80)}" is not a file the tool copies.`);
	const parts = rel.split('/');
	if (parts[0] === '.git')
		throw new Error(`The file "${rel.slice(0, 80)}" is not a file the tool copies.`);
	if (SKIP_DIR.test(rel)) return false;
	// Every folder above the file must be a real folder
	for (let i = 1; i < parts.length; i++) {
		const folder = parts.slice(0, i).join('/');
		let st;
		try {
			st = lstatSync(join(ctx.src, folder));
		} catch {
			break;
		}
		if (st.isSymbolicLink())
			throw new Error(
				`"${folder.slice(0, 80)}" is a link. A check does not copy links; remove it or ignore it in git.`
			);
	}
	const from = join(ctx.src, ...parts);
	let st;
	try {
		st = lstatSync(from);
	} catch {
		return false; // Listed by git but deleted in the working tree
	}
	if (st.isSymbolicLink())
		throw new Error(
			`"${rel.slice(0, 80)}" is a link. A check does not copy links; remove it or ignore it in git.`
		);
	if (!st.isFile()) return false;
	const never = neverCopy(rel, ctx.tracked.has(rel));
	if (never) {
		ctx.skipped.push({ path: rel, why: never });
		return false;
	}
	if (st.size > MAX_COPY_BYTES) {
		ctx.skipped.push({ path: rel, why: 'larger than 5 MB' });
		return false;
	}
	const to = under(ctx.dest, ...parts);
	mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
	copyFileSync(from, to);
	return true;
}

/** Every file of a folder that is not a git repo, as relative paths, with the limits that keep it from being a whole disk. */
function plainFiles(repo: string, limits: CopyOptions['limits'] = {}): string[] {
	const maxFiles = limits.files ?? MAX_PLAIN_FILES;
	const maxBytes = limits.bytes ?? MAX_PLAIN_BYTES;
	const out: string[] = [];
	let bytes = 0;
	const walk = (rel: string) => {
		for (const e of readdirSync(join(repo, rel), { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (SKIP_DIR.test(`${r}/`)) continue;
			if (e.isSymbolicLink())
				throw new Error(
					`"${r.slice(0, 80)}" is a link. A check does not copy links; remove it or ignore it in git.`
				);
			if (e.isDirectory()) walk(r);
			else if (e.isFile()) {
				out.push(r);
				bytes += lstatSync(join(repo, r)).size;
				if (out.length > maxFiles || bytes > maxBytes)
					throw new Error(
						`${repo} is not a git repo and holds more than ${maxFiles} files or ${Math.round(maxBytes / 1024 / 1024)} MB, which is too much to copy for a run. Make it a git repo, or point the project at a smaller folder.`
					);
			}
		}
	};
	walk('');
	return out;
}

/** The tracked links of a checked-out clone, by name: a link in the commit would reach outside the copy. */
async function trackedLinks(dir: string): Promise<string[]> {
	const out = must(await git(dir, ['ls-files', '-s', '-z']), 'git ls-files').toString('utf8');
	const links: string[] = [];
	for (const entry of out.split('\0').filter(Boolean)) {
		const tab = entry.indexOf('\t');
		if (tab > 0 && entry.startsWith('120000 ')) links.push(entry.slice(tab + 1));
	}
	return links;
}

async function cloneCopy(root: string, dest: string, head: string, ctx: Ctx): Promise<number> {
	ensureDir(dirname(dest));
	must(
		await git(dirname(dest), ['clone', '--local', '--no-checkout', '--quiet', root, dest]),
		'git clone'
	);
	await git(dest, ['remote', 'remove', 'origin']);
	must(await git(dest, ['checkout', '--quiet', '--force', '--detach', head]), 'git checkout');
	const links = await trackedLinks(dest);
	if (links.length)
		throw new Error(
			`"${links[0].slice(0, 80)}" is a link in the commit. A check does not copy links; remove it from git.`
		);
	const tracked = must(await git(dest, ['ls-files', '-z']), 'git ls-files').toString('utf8');
	for (const f of tracked.split('\0').filter(Boolean)) {
		ctx.tracked.add(f);
		if (TRACKED_ENV.test(f)) rmSync(under(dest, f), { force: true });
	}
	const { deleted, changed } = await workingTreeChanges(root);
	for (const rel of deleted) {
		if (!safeRel(rel) || SKIP_DIR.test(rel)) continue;
		try {
			rmSync(under(dest, rel), { force: true });
		} catch {
			ctx.skipped.push({ path: rel, why: 'could not remove it' });
		}
	}
	let copied = 0;
	for (const rel of changed) if (copyOne(ctx, rel)) copied++;
	return copied;
}

/**
 * Makes one run's private copy of `repo` in `dest` (which must not exist yet). The copy is made from the git root that holds `repo`;
 * `repoInCopy` says where `repo` is inside it. A link anywhere in what is copied is refused by name.
 */
export async function makePrivateCopy(
	repo: string,
	dest: string,
	opts: CopyOptions = {}
): Promise<CopyResult> {
	const log = opts.log ?? (() => {});
	const root = (await gitRoot(repo)) ?? resolve(repo);
	for (let attempt = 1; ; attempt++) {
		const ctx: Ctx = { src: root, dest, skipped: [], tracked: new Set() };
		const head = await headCommit(root);
		let files = 0;
		let mode: CopyResult['mode'];
		if (head) {
			mode = 'clone';
			files = await cloneCopy(root, dest, head, ctx);
		} else {
			mkdirSync(dest, { recursive: true, mode: 0o700 });
			const listed = await listFiles(root);
			mode = listed ? 'listed' : 'plain';
			if (listed) {
				const cached = await git(root, ['ls-files', '--cached', '-z']);
				if (cached.status === 0)
					for (const f of cached.stdout.toString('utf8').split('\0').filter(Boolean))
						ctx.tracked.add(f);
			}
			for (const rel of listed ?? plainFiles(root, opts.limits)) if (copyOne(ctx, rel)) files++;
		}
		await opts.afterCopy?.(attempt);
		// Another commit made in the repo while it was being copied would leave a tree that is neither commit: it is copied again, once
		if (head && attempt === 1 && (await headCommit(root)) !== head) {
			log('The repo moved to another commit while it was being copied; copying again.');
			rmSync(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			continue;
		}
		if (ctx.skipped.length) {
			log(`${ctx.skipped.length} file(s) were not copied (env files, keys, files over 5 MB).`);
			// Names only, never content
			for (const k of ctx.skipped) log(`  not copied: ${k.path.slice(0, 120)} (${k.why})`);
		}
		const rel = relative(realOf(root), realOf(repo));
		return {
			files,
			skipped: ctx.skipped.length,
			skippedList: ctx.skipped,
			head,
			sourceRoot: root,
			repoInCopy: rel && !rel.startsWith('..') ? join(dest, rel) : dest,
			mode
		};
	}
}
