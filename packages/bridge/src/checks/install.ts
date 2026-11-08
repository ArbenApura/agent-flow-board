// THE INSTALL OF A PRIVATE COPY: WHICH COMMAND, WHETHER IT MAY BE CACHED, AND HOW A PACKAGE MANAGER IS STARTED ON WINDOWS.
// The commands are constants: nothing in the repo can change them. They install exactly what the lock file says and, where the package manager
// allows it, with the package scripts switched off (a postinstall script would run a program the agent wrote).

// -- DEP-MODULES -- //
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

// -- TYPES -- //

export type PackageManager = 'yarn' | 'npm' | 'pnpm';

// -- CONSTANTS -- //

/** The programs that are .cmd shims on Windows. */
const SHIMMED = /^(yarn|npm|pnpm|npx)$/;
/** The files an install depends on. */
const LOCK_INPUTS = [
	'yarn.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'.pnpmfile.cjs',
	'.yarnrc.yml'
];

// -- FUNCTIONS -- //

const has = (dir: string, file: string) => existsSync(join(dir, file));

/** Which package manager the lock file in `dir` names, or null when there is none (a frozen install needs one) or no package.json. */
export function packageManagerOf(dir: string): PackageManager | null {
	if (!has(dir, 'package.json')) return null;
	if (has(dir, 'yarn.lock')) return 'yarn';
	if (has(dir, 'package-lock.json')) return 'npm';
	if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
	return null;
}

/**
 * The frozen install command for `dir`, or null when it has no lock file. Yarn with a .yarnrc.yml is Yarn 4, whose own `--immutable` is the frozen
 * form; the others get --ignore-scripts.
 */
export function installCommand(dir: string): string[] | null {
	switch (packageManagerOf(dir)) {
		case 'yarn':
			return has(dir, '.yarnrc.yml')
				? ['yarn', 'install', '--immutable']
				: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts'];
		case 'npm':
			return ['npm', 'ci', '--ignore-scripts'];
		case 'pnpm':
			return ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'];
		default:
			return null;
	}
}

/**
 * True when the finished install of `dir` may be kept and copied into another folder. A pnpm install never is: pnpm writes the absolute path of its
 * store into node_modules/.modules.yaml, and its links point into that store, so a copy in another folder is refused by the next pnpm run.
 */
export function installCacheable(dir: string): boolean {
	const manager = packageManagerOf(dir);
	if (!manager || manager === 'pnpm') return false;
	// A node_modules that pnpm made is never cached whatever lock file sits beside it
	if (has(dir, join('node_modules', '.modules.yaml')) || has(dir, '.modules.yaml')) return false;
	return true;
}

/** A hash of the files an install depends on: what the installed dependencies depend on. */
export function lockHash(dir: string): string {
	const h = createHash('sha1');
	for (const f of LOCK_INPUTS) if (has(dir, f)) h.update(f).update(readFileSync(join(dir, f)));
	return h.digest('hex');
}

/** The first file on PATH named `name` with one of the executable extensions, or null. Case-insensitive on Windows. */
export function findOnPath(
	name: string,
	pathEnv: string,
	exts: string[],
	exists: (file: string) => boolean = existsSync
): string | null {
	for (const dir of pathEnv.split(delimiter).filter(Boolean))
		for (const ext of exts) {
			const file = join(dir, name + ext);
			if (exists(file)) return file;
		}
	return null;
}

/**
 * What to start for a command. On Windows yarn, npm and pnpm are usually .cmd shims, which a plain spawn cannot find and Node refuses to start
 * directly (EINVAL): they go through `cmd.exe /d /s /c name.cmd`, unless a real .exe of that name is first on PATH. The arguments came from a command
 * that was already checked (words, flags and a port, no shell characters), so cmd.exe has nothing to interpret. Elsewhere the argv is unchanged.
 */
export function programArgv(
	argv: string[],
	opts: { platform?: NodeJS.Platform; pathEnv?: string; exists?: (file: string) => boolean } = {}
): string[] {
	const [file, ...args] = argv;
	if (!file || (opts.platform ?? process.platform) !== 'win32' || !SHIMMED.test(file)) return argv;
	const found = findOnPath(file, opts.pathEnv ?? '', ['.exe', '.cmd', '.bat'], opts.exists);
	if (found && found.toLowerCase().endsWith('.exe')) return [found, ...args];
	return ['cmd.exe', '/d', '/s', '/c', `${file}.cmd`, ...args];
}

/** The PATH of an environment object, whatever its case (Windows calls it Path). */
export function pathOf(env: Record<string, string | undefined>): string {
	for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') return env[k] ?? '';
	return '';
}

/**
 * The folder an install runs in: `appCwd` when it holds a lock file, else the nearest folder above it, up to `stopAt` (the root of the private copy), that does.
 * A monorepo keeps one lock file at the top and the apps below it. Null when there is none, and the install is skipped.
 */
export function installDirFor(appCwd: string, stopAt: string): string | null {
	const top = resolve(stopAt);
	let dir = resolve(appCwd);
	for (let i = 0; i < 32; i++) {
		if (packageManagerOf(dir)) return dir;
		if (dir === top) return null;
		const up = dirname(dir);
		if (up === dir) return null;
		// Never above the copy
		const rel = relative(top, up);
		if (rel.startsWith('..') || isAbsolute(rel)) return null;
		dir = up;
	}
	return null;
}

/** How a version is asked for. A test replaces it. */
export const versionIo = {
	run: (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> =>
		new Promise((resolveRun) => {
			const [file, ...args] = programArgv(argv, { pathEnv: pathOf(opts.env) });
			if (!file) return resolveRun('');
			execFile(
				file,
				args,
				{ cwd: opts.cwd, env: opts.env, windowsHide: true, timeout: 30_000 },
				(err, stdout) => resolveRun(err ? '' : (String(stdout).trim().split(/\r?\n/)[0] ?? ''))
			);
		})
};
const versions = new Map<string, string>();

/** The version of a package manager as `<pm> --version` prints it, asked once per process. An empty string when it cannot be asked (the cache key then differs from every real version). */
export async function packageManagerVersion(
	pm: PackageManager,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<string> {
	const known = versions.get(pm);
	if (known !== undefined) return known;
	const version = (await versionIo.run([pm, '--version'], { cwd, env })).slice(0, 40);
	// A failed ask is not remembered: the next run asks again
	if (version) versions.set(pm, version);
	return version;
}
/** Forgets the versions asked so far (tests). */
export const forgetPackageManagerVersions = () => versions.clear();
