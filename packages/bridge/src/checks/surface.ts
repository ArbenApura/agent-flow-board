// THE FILES THAT DECIDE WHAT A BUILD AND A START RUN. A registration keeps a hash of them (its pin), so a change to a script, a lockfile, the package manager's own program or a
// build config is noticed and the commands are checked against the guardrails again before the new hash is pinned. This is change detection for the build setup, not a defence
// against the agent: the preview runs the app's own code, which the agent writes.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// -- CONSTANTS -- //

const FIXED = [
	'yarn.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'.pnpmfile.cjs',
	'.yarnrc.yml',
	'.npmrc',
	'.afb-checks.json'
];
/** Files at the folder root that tools load as code when they build: vite.config.ts, svelte.config.js, postcss.config.cjs and the like. */
const CONFIG = /\.config\.(c|m)?[jt]s$|^\.postcssrc/;
/** Folders whose files run as the package manager. */
const PROGRAM_DIRS = ['.yarn/releases', '.yarn/plugins'];

// -- FUNCTIONS -- //

/** What a path is, without following a link: a link or an unreadable entry still counts, so it can never be skipped or crash the hash. */
function kind(p: string): 'link' | 'dir' | 'file' | 'unreadable' {
	try {
		const s = lstatSync(p);
		return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file';
	} catch {
		return 'unreadable';
	}
}

function text(file: string): string {
	try {
		return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
	} catch {
		return '\0unreadable';
	}
}

/** A file as it goes into the hash: its content, or the fact that it is a link or cannot be read. */
const body = (file: string) => (kind(file) === 'file' ? text(file) : `\0${kind(file)}`);

function filesIn(dir: string, base: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return [relative(base, dir).split(sep).join('/')];
	}
	for (const name of names) {
		const full = join(dir, name);
		if (kind(full) === 'dir') out.push(...filesIn(full, base));
		else out.push(relative(base, full).split(sep).join('/'));
	}
	return out;
}

/**
 * The hash of the surface of an app folder and the names of the files that went into it. When the app sits in a subfolder of the git root (`parent`), the package
 * manager's settings of the root also count (yarn merges .yarnrc.yml upward), so the root's fixed files and program folders are hashed under a `root:` prefix.
 */
export function surfaceHash(
	repo: string,
	parent: string | null = null
): { hash: string; files: string[] } {
	const names: string[] = [];
	const parts: string[] = [];
	const pkg = join(repo, 'package.json');
	if (kind(pkg) !== 'unreadable') {
		let scripts: unknown;
		try {
			const parsed: unknown = JSON.parse(text(pkg));
			scripts =
				parsed && typeof parsed === 'object'
					? ((parsed as { scripts?: unknown }).scripts ?? {})
					: {};
		} catch {
			scripts = { __unreadable: true };
		}
		names.push('package.json#scripts');
		parts.push(`package.json#scripts\0${JSON.stringify(scripts)}`);
	}
	const list = (dir: string): string[] => {
		try {
			return existsSync(dir) ? readdirSync(dir) : [];
		} catch {
			return [];
		}
	};
	const rootNames = list(repo);
	const listed = [
		...new Set([
			...FIXED.filter((f) => rootNames.includes(f)),
			...rootNames.filter((f) => CONFIG.test(f))
		])
	].sort();
	for (const f of listed) {
		names.push(f);
		parts.push(`${f}\0${body(join(repo, f))}`);
	}
	for (const d of PROGRAM_DIRS)
		for (const f of filesIn(join(repo, d), repo)) {
			names.push(f);
			parts.push(`${f}\0${body(join(repo, f))}`);
		}
	if (parent && resolve(parent) !== resolve(repo)) {
		const parentNames = list(parent);
		for (const f of FIXED.filter((n) => parentNames.includes(n) && n !== '.afb-checks.json')) {
			names.push(`root:${f}`);
			parts.push(`root:${f}\0${body(join(parent, f))}`);
		}
		for (const d of PROGRAM_DIRS)
			for (const f of filesIn(join(parent, d), parent)) {
				names.push(`root:${f}`);
				parts.push(`root:${f}\0${body(join(parent, f))}`);
			}
	}
	return { hash: createHash('sha256').update(parts.join('\n')).digest('hex'), files: names };
}
